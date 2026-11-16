/**
 * Runs the real ffmpeg on a generated 3-second clip and checks that what the
 * worker stores can be played: the key opens, and the first segment decrypts
 * to an MPEG-TS packet. CI installs ffmpeg for this.
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type Database, newId } from '@mathpath/db';
import { MediaKeyVault, MemoryObjectStore } from '@mathpath/media';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { probe, RejectedMedia } from './ffmpeg';
import { ladderFor, masterPlaylist, Transcoder, type VideoRules } from './transcoder';

const rules: VideoRules = {
  minDurationSeconds: 1,
  maxDurationSeconds: 10,
  maxUploadBytes: 10_000_000,
  segmentSeconds: 1,
  ladder: [
    { height: 144, videoKbps: 150 },
    { height: 240, videoKbps: 300 },
    { height: 360, videoKbps: 500 },
  ],
  audioKbps: 64,
  audioOnlyKbps: 32,
};

let dir: string;
let clip: Buffer;
let silentClip: Buffer;
let db: Kysely<Database>;
let store: MemoryObjectStore;
const vault = new MediaKeyVault(Buffer.alloc(32, 3));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mp-worker-test-'));
  const make = (file: string, withAudio: boolean) => {
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=426x240:rate=15:duration=3',
      ...(withAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'] : []),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      ...(withAudio ? ['-c:a', 'aac', '-shortest'] : []),
      '-movflags',
      '+faststart',
      join(dir, file),
    ]);
    return readFileSync(join(dir, file));
  };
  clip = make('clip.mp4', true);
  silentClip = make('silent.mp4', false);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db = await createTestDb();
  store = new MemoryObjectStore();
});

async function uploadedVideo(
  file: Buffer | null,
  status: 'uploaded' | 'awaiting_upload' = 'uploaded',
) {
  const user = newId();
  await db.insertInto('users').values({ id: user, first_name: 'Muallif' }).execute();
  const id = newId();
  await db
    .insertInto('media_assets')
    .values({
      id,
      kind: 'video',
      content_type: 'video/mp4',
      size_bytes: file?.length ?? 1,
      source_key: `sources/${id}`,
      status,
      uploaded_by: user,
    })
    .execute();
  if (file) await store.write(`sources/${id}`, file, 'video/mp4');
  return id;
}

async function asset(id: string) {
  return db.selectFrom('media_assets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

describe('Transcoder', () => {
  it('produces encrypted HLS that the stored key decrypts', { timeout: 60_000 }, async () => {
    const id = await uploadedVideo(clip);
    const result = await new Transcoder(db, store, vault, rules).run(id, false);
    expect(result).toEqual({ outcome: 'ready' });

    const row = await asset(id);
    expect(row).toMatchObject({
      status: 'ready',
      hls_manifest_key: `hls/${id}/master.m3u8`,
      duration_s: 3,
      error: null,
    });
    expect(row.renditions?.map((r) => r.name)).toEqual(['144p', '240p', 'audio']);

    const master = (await store.read(`hls/${id}/master.m3u8`)).toString();
    expect(master).toContain('RESOLUTION=256x144');
    expect(master).toContain('240p/index.m3u8');
    expect(master).not.toContain('360p');

    const media = (await store.read(`hls/${id}/240p/index.m3u8`)).toString();
    const keyLine = media.split('\n').find((l) => l.startsWith('#EXT-X-KEY'))!;
    expect(keyLine).toMatch(/METHOD=AES-128,URI="key",IV=0x[0-9a-f]{32}/);
    const segment = media.split('\n').find((l) => l.endsWith('.ts'))!;
    expect(segment).toBe('seg_0000.ts');

    const keys = await db
      .selectFrom('media_keys')
      .selectAll()
      .where('media_id', '=', id)
      .executeTakeFirstOrThrow();
    const key = vault.open(id, keys.sealed_key);
    expect(`0x${Buffer.from(keys.iv).toString('hex')}`).toBe(/IV=(0x[0-9a-f]+)/.exec(keyLine)![1]);
    const encrypted = await store.read(`hls/${id}/240p/${segment}`);
    expect(encrypted[0]).not.toBe(0x47);
    const decipher = createDecipheriv('aes-128-cbc', key, keys.iv);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    expect(plain[0]).toBe(0x47); // MPEG-TS sync byte
    expect(plain[188]).toBe(0x47);

    // No temporary files are left behind, including the clear key.
    const leftovers = readdirTemp();
    expect(leftovers).toEqual([]);
  });

  it('skips the audio fallback for a silent video', { timeout: 60_000 }, async () => {
    const id = await uploadedVideo(silentClip);
    await new Transcoder(db, store, vault, rules).run(id, false);
    const row = await asset(id);
    expect(row.renditions?.map((r) => r.name)).toEqual(['144p', '240p']);
    expect((await store.read(`hls/${id}/master.m3u8`)).toString()).toContain(
      'CODECS="avc1.4d401f"',
    );
  });

  it('rejects a video outside the allowed length without retrying', async () => {
    const id = await uploadedVideo(clip);
    const result = await new Transcoder(db, store, vault, {
      ...rules,
      minDurationSeconds: 5,
    }).run(id, false);
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'the video is 3 s long; lessons need 5–10 s',
    });
    expect(await asset(id)).toMatchObject({ status: 'failed', error: result.reason });
  });

  it('rejects a file that is not a video', async () => {
    const id = await uploadedVideo(Buffer.from('definitely not a video'));
    const result = await new Transcoder(db, store, vault, rules).run(id, false);
    expect(result.outcome).toBe('rejected');
    expect((await asset(id)).status).toBe('failed');
  });

  it('leaves assets that are not waiting for transcoding alone', async () => {
    const id = await uploadedVideo(clip, 'awaiting_upload');
    expect(await new Transcoder(db, store, vault, rules).run(id, false)).toEqual({
      outcome: 'skipped',
    });
    expect((await asset(id)).status).toBe('awaiting_upload');
  });

  it('rethrows unexpected errors, and marks the asset failed on the last attempt', async () => {
    const id = await uploadedVideo(null);
    const transcoder = new Transcoder(db, store, vault, rules);
    await expect(transcoder.run(id, false)).rejects.toThrow('no such object');
    expect((await asset(id)).status).toBe('processing');
    await expect(transcoder.run(id, true)).rejects.toThrow('no such object');
    expect(await asset(id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/again/),
    });
  });

  it('rotates the key when a video is transcoded again', async () => {
    const id = await uploadedVideo(clip);
    const encoders = {
      probe: vi.fn().mockResolvedValue({ durationS: 3, width: 426, height: 240, hasAudio: false }),
      encode: vi.fn().mockResolvedValue(undefined),
    };
    const transcoder = new Transcoder(db, store, vault, rules, encoders);
    await transcoder.run(id, false);
    const first = await db.selectFrom('media_keys').selectAll().executeTakeFirstOrThrow();
    await db.updateTable('media_assets').set({ status: 'uploaded' }).where('id', '=', id).execute();
    await transcoder.run(id, false);
    const second = await db.selectFrom('media_keys').selectAll().executeTakeFirstOrThrow();
    expect(second.rotated_at).not.toBeNull();
    expect(vault.open(id, second.sealed_key)).not.toEqual(vault.open(id, first.sealed_key));
    expect(encoders.encode).toHaveBeenCalledTimes(4);
  });
});

function readdirTemp(): string[] {
  return execFileSync('ls', [tmpdir()])
    .toString()
    .split('\n')
    .filter((name) => name.startsWith('mp-transcode-'));
}

describe('probe', () => {
  it('reads duration, size and audio', async () => {
    const file = join(dir, 'clip.mp4');
    const info = await probe(file);
    expect(info).toMatchObject({ width: 426, height: 240, hasAudio: true });
    expect(info.durationS).toBeCloseTo(3, 0);
  });

  it('refuses an audio-only file', async () => {
    const file = join(dir, 'tone.m4a');
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      '-c:a',
      'aac',
      file,
    ]);
    await expect(probe(file)).rejects.toBeInstanceOf(RejectedMedia);
  });
});

describe('ladderFor', () => {
  it('never upscales, but always keeps one video rung', () => {
    const tiny = { durationS: 3, width: 160, height: 91, hasAudio: false };
    expect(ladderFor(tiny, rules)).toEqual([{ height: 90, videoKbps: 150 }]);
    const hd = { durationS: 3, width: 1920, height: 1080, hasAudio: true };
    expect(ladderFor(hd, rules).map((r) => r.height)).toEqual([144, 240, 360, null]);
  });
});

describe('masterPlaylist', () => {
  it('lists renditions with bandwidth, resolution and codecs', () => {
    expect(
      masterPlaylist(
        [
          { name: '240p', height: 240, width: 426, bandwidth: 400_000 },
          { name: 'audio', height: null, width: null, bandwidth: 32_000 },
        ],
        true,
      ),
    ).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240,CODECS="avc1.4d401f,mp4a.40.2"',
        '240p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=32000,CODECS="mp4a.40.2"',
        'audio/index.m3u8',
        '',
      ].join('\n'),
    );
  });
});
