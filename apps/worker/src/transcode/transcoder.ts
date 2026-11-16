/**
 * Turns an uploaded video into encrypted HLS (architecture §7.1, §7.3).
 *
 * 1. Claims the asset (uploaded → processing) so two workers cannot both run it.
 * 2. Downloads the source to a private temp directory and probes it.
 * 3. Encodes the ladder (never taller than the source) plus an audio-only
 *    fallback, every rendition encrypted with one random AES-128 key.
 * 4. Uploads playlists and segments, then in one transaction stores the
 *    sealed key and marks the asset ready. Until that commit nothing points
 *    at the new files, so a crash half-way leaves no playable half-video.
 *
 * Stored playlists contain only relative names; the API adds tokens and
 * signed URLs per viewer when it serves them.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@mathpath/config';
import type { Database, Rendition } from '@mathpath/db';
import { mediaKeys, type MediaKeyVault, type ObjectStore } from '@mathpath/media';
import type { Kysely } from 'kysely';
import { encode, type EncodeOptions, type Probe, probe, RejectedMedia } from './ffmpeg';

export type VideoRules = AppConfig['content']['video'];

export interface TranscodeResult {
  outcome: 'ready' | 'rejected' | 'skipped';
  reason?: string;
}

/** Encoders are injectable so tests can count calls; production uses ffmpeg. */
export interface Encoders {
  probe(file: string): Promise<Probe>;
  encode(options: EncodeOptions): Promise<void>;
}

const ffmpeg: Encoders = { probe: (file) => probe(file), encode };

export class Transcoder {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly store: ObjectStore,
    private readonly vault: MediaKeyVault,
    private readonly rules: VideoRules,
    private readonly encoders: Encoders = ffmpeg,
    private readonly workDir: string = tmpdir(),
  ) {}

  /**
   * @param finalAttempt - On the last retry an unexpected error marks the asset failed.
   * @throws The unexpected error (storage, ffmpeg crash) so the queue retries.
   */
  async run(mediaId: string, finalAttempt: boolean): Promise<TranscodeResult> {
    const claimed = await this.db
      .updateTable('media_assets')
      .set({ status: 'processing', error: null })
      .where('id', '=', mediaId)
      .where('kind', '=', 'video')
      // `processing` too: a worker that died mid-job left it there.
      .where('status', 'in', ['uploaded', 'processing'])
      .returning(['source_key'])
      .executeTakeFirst();
    if (!claimed) return { outcome: 'skipped' };

    const dir = await mkdtemp(join(this.workDir, 'mp-transcode-'));
    try {
      await this.transcode(mediaId, claimed.source_key, dir);
      return { outcome: 'ready' };
    } catch (error) {
      if (error instanceof RejectedMedia) {
        await this.fail(mediaId, error.message);
        return { outcome: 'rejected', reason: error.message };
      }
      if (finalAttempt) await this.fail(mediaId, 'transcoding failed; upload the file again');
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async transcode(mediaId: string, sourceKey: string, dir: string): Promise<void> {
    const source = join(dir, 'source');
    await this.store.download(sourceKey, source);
    const info = await this.encoders.probe(source);
    const { minDurationSeconds: min, maxDurationSeconds: max } = this.rules;
    if (info.durationS < min || info.durationS > max) {
      throw new RejectedMedia(
        `the video is ${Math.round(info.durationS)} s long; lessons need ${min}–${max} s`,
      );
    }

    const key = randomBytes(16);
    const iv = randomBytes(16);
    const keyFile = join(dir, 'content.key');
    const keyInfoFile = join(dir, 'key.info');
    await writeFile(keyFile, key, { mode: 0o600 });
    // Line 1 is the URI written into the playlist; the API replaces it per viewer.
    await writeFile(keyInfoFile, `key\n${keyFile}\n${iv.toString('hex')}\n`, { mode: 0o600 });

    const out = join(dir, 'hls');
    const renditions: (Rendition & { width: number | null })[] = [];
    for (const rung of ladderFor(info, this.rules)) {
      const name = rung.height === null ? 'audio' : `${rung.height}p`;
      const outDir = join(out, name);
      await mkdir(outDir, { recursive: true });
      await this.encoders.encode({
        source,
        outDir,
        keyInfoFile,
        segmentSeconds: this.rules.segmentSeconds,
        height: rung.height,
        videoKbps: rung.videoKbps,
        audioKbps: rung.height === null ? this.rules.audioOnlyKbps : this.rules.audioKbps,
        hasAudio: info.hasAudio,
        // Generous: a 10-minute 720p encode takes a few minutes on one core.
        timeoutMs: Math.max(120_000, info.durationS * 4_000),
      });
      const audioKbps = info.hasAudio ? this.rules.audioKbps : 0;
      renditions.push({
        name,
        height: rung.height,
        width: rung.height === null ? null : evenWidth(info, rung.height),
        bandwidth:
          rung.height === null
            ? this.rules.audioOnlyKbps * 1000
            : Math.round((rung.videoKbps + audioKbps) * 1100),
      });
    }
    await writeFile(join(out, 'master.m3u8'), masterPlaylist(renditions, info.hasAudio));

    for (const file of await listFiles(out)) {
      await this.store.write(
        mediaKeys.hls(mediaId, file),
        await readFile(join(out, file)),
        file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      );
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('media_keys')
        .values({ media_id: mediaId, sealed_key: this.vault.seal(mediaId, key), iv })
        .onConflict((oc) =>
          oc.column('media_id').doUpdateSet({
            sealed_key: this.vault.seal(mediaId, key),
            iv,
            rotated_at: new Date(),
          }),
        )
        .execute();
      await trx
        .updateTable('media_assets')
        .set({
          status: 'ready',
          hls_manifest_key: mediaKeys.hls(mediaId, 'master.m3u8'),
          duration_s: Math.ceil(info.durationS),
          renditions: JSON.stringify(
            renditions.map(({ name, height, bandwidth }) => ({ name, height, bandwidth })),
          ),
          error: null,
        })
        .where('id', '=', mediaId)
        .execute();
    });
  }

  private async fail(mediaId: string, reason: string): Promise<void> {
    await this.db
      .updateTable('media_assets')
      .set({ status: 'failed', error: reason })
      .where('id', '=', mediaId)
      .execute();
  }
}

/**
 * The rungs to encode: every configured height up to the source's, at least
 * the lowest one (at the source's own height if that is smaller), plus the
 * audio-only fallback when the source has sound.
 */
export function ladderFor(
  info: Probe,
  rules: VideoRules,
): { height: number | null; videoKbps: number }[] {
  const fitting = rules.ladder.filter((r) => r.height <= info.height);
  const lowest = rules.ladder[0]!;
  const video =
    fitting.length > 0 ? fitting : [{ ...lowest, height: info.height - (info.height % 2) }];
  return info.hasAudio ? [...video, { height: null, videoKbps: 0 }] : video;
}

function evenWidth(info: Probe, height: number): number {
  return Math.round((info.width * height) / info.height / 2) * 2;
}

export function masterPlaylist(
  renditions: (Rendition & { width: number | null })[],
  hasAudio: boolean,
): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const r of renditions) {
    const codecs =
      r.height === null ? 'mp4a.40.2' : hasAudio ? 'avc1.4d401f,mp4a.40.2' : 'avc1.4d401f';
    const resolution = r.width === null ? '' : `,RESOLUTION=${r.width}x${r.height}`;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth}${resolution},CODECS="${codecs}"`);
    lines.push(`${r.name}/index.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}

/** Relative paths of every file under `root`. */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else files.push(path);
  }
  return files.sort();
}
