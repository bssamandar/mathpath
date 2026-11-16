import { randomBytes } from 'node:crypto';
import { MediaKeyVault, type MemoryObjectStore } from '@mathpath/media';
import { newId, type Role } from '@mathpath/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAuditChain } from '../src/audit/audit.service';
import { SessionService } from '../src/identity/session.service';
import { OBJECT_STORE } from '../src/media/media.module';
import { TranscodeQueue } from '../src/media/transcode-queue';
import { browser, createTestApp, type TestApp } from './helpers';

let t: TestApp;
let store: MemoryObjectStore;

beforeEach(async () => {
  t = await createTestApp();
  store = t.app.get(OBJECT_STORE);
});

afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());

const client = {
  ipPrefix: null,
  userAgentSummary: null,
  requestId: null,
  automationSuspected: false,
};

async function userWith(roles: Role[]): Promise<{ id: string; auth: string }> {
  const id = newId();
  await t.db.insertInto('users').values({ id, first_name: 'Aziz' }).execute();
  await t.db
    .insertInto('user_roles')
    .values(roles.map((role) => ({ user_id: id, role })))
    .execute();
  const sessions = t.app.get(SessionService);
  const started = await sessions.start(id, client, 'password');
  const session = roles.some((r) => r !== 'student' && r !== 'parent')
    ? await sessions.elevate(started.sessionId)
    : started;
  return { id, auth: `Bearer ${session.accessToken}` };
}

const MP4_HEAD = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from('ftypisom'),
  Buffer.alloc(100),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40),
]);

async function upload(
  author: { auth: string },
  body: Record<string, unknown>,
  file: Buffer | null,
  contentType = body.contentType as string,
) {
  const slot = await http()
    .post('/api/v1/studio/media/uploads')
    .set('Authorization', author.auth)
    .send(body)
    .expect(201);
  if (file) await store.write(`sources/${slot.body.mediaId}`, file, contentType);
  return slot.body as { mediaId: string; uploadUrl: string; expiresAt: string };
}

/**
 * A transcoded video as the worker leaves it: playlists in storage, a sealed
 * key in the database, the row ready.
 */
async function readyVideo(uploaderId: string) {
  const id = newId();
  const key = randomBytes(16);
  await t.db
    .insertInto('media_assets')
    .values({
      id,
      kind: 'video',
      content_type: 'video/mp4',
      size_bytes: 1000,
      source_key: `sources/${id}`,
      uploaded_by: uploaderId,
    })
    .execute();
  await t.db
    .updateTable('media_assets')
    .set({
      status: 'ready',
      hls_manifest_key: `hls/${id}/master.m3u8`,
      duration_s: 300,
      renditions: JSON.stringify([
        { name: '360p', height: 360, bandwidth: 800_000 },
        { name: 'audio', height: null, bandwidth: 60_000 },
      ]),
    })
    .where('id', '=', id)
    .execute();
  await t.db
    .insertInto('media_keys')
    .values({
      media_id: id,
      sealed_key: t.app.get(MediaKeyVault).seal(id, key),
      iv: randomBytes(16),
    })
    .execute();
  await store.write(
    `hls/${id}/master.m3u8`,
    Buffer.from(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
        '360p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=60000,CODECS="mp4a.40.2"',
        'audio/index.m3u8',
        '',
      ].join('\n'),
    ),
    'application/vnd.apple.mpegurl',
  );
  await store.write(
    `hls/${id}/360p/index.m3u8`,
    Buffer.from(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x0123456789abcdef0123456789abcdef',
        '#EXTINF:6.0,',
        'seg_0000.ts',
        '#EXTINF:4.0,',
        'seg_0001.ts',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    ),
    'application/vnd.apple.mpegurl',
  );
  return { id, key };
}

/** A published course with a lesson that shows `videoId`; free unless `paid`. */
async function lessonWith(videoId: string, authorId: string, paid = false) {
  const [track, course, chapter, topic, version] = [newId(), newId(), newId(), newId(), newId()];
  await t.db
    .insertInto('tracks')
    .values({ id: track, slug: 'school', title: { 'uz-Latn': 'Maktab' } })
    .execute();
  await t.db
    .insertInto('courses')
    .values({
      id: course,
      track_id: track,
      slug: 'grade-5',
      title: { 'uz-Latn': '5-sinf' },
      status: 'published',
    })
    .execute();
  await t.db
    .insertInto('chapters')
    .values({
      id: chapter,
      course_id: course,
      slug: 'fractions',
      title: { 'uz-Latn': 'Kasrlar' },
      status: 'published',
    })
    .execute();
  await t.db
    .insertInto('topics')
    .values({ id: topic, chapter_id: chapter, slug: 'what-is-a-fraction', is_free: !paid })
    .execute();
  await t.db
    .insertInto('topic_versions')
    .values({
      id: version,
      topic_id: topic,
      version_no: 1,
      title: JSON.stringify({ 'uz-Latn': 'Kasr nima?' }),
      steps: JSON.stringify([{ type: 'video', mediaId: videoId, required: true }]),
      author_id: authorId,
      content_hash: 'x',
    })
    .execute();
  await t.db
    .updateTable('topic_versions')
    .set({ status: 'published', published_at: new Date() })
    .where('id', '=', version)
    .execute();
  await t.db
    .updateTable('topics')
    .set({ published_version_id: version })
    .where('id', '=', topic)
    .execute();
  return { topic };
}

describe('studio uploads', () => {
  it('takes a video from upload slot to the transcoding queue, and audits it', async () => {
    const author = await userWith(['author']);
    const enqueue = vi.spyOn(t.app.get(TranscodeQueue), 'enqueue');
    const slot = await upload(
      author,
      { kind: 'video', contentType: 'video/mp4', sizeBytes: MP4_HEAD.length },
      null,
    );
    const url = new URL(slot.uploadUrl);
    expect(url.pathname).toBe(`/sources/${slot.mediaId}`);
    expect(url.searchParams.get('size')).toBe(String(MP4_HEAD.length));
    expect(url.searchParams.get('ttl')).toBe('900');
    expect(slot.expiresAt).toBe('2026-11-15T10:15:00.000Z');

    const early = await http()
      .post(`/api/v1/studio/media/${slot.mediaId}/complete`)
      .set('Authorization', author.auth)
      .expect(409);
    expect(early.body.code).toBe('UPLOAD_MISSING');

    await store.write(`sources/${slot.mediaId}`, MP4_HEAD, 'video/mp4');
    const done = await http()
      .post(`/api/v1/studio/media/${slot.mediaId}/complete`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(done.body).toMatchObject({ kind: 'video', status: 'uploaded', previewUrl: null });
    expect(enqueue).toHaveBeenCalledWith(slot.mediaId);

    // A repeated call re-queues (the job ID deduplicates) instead of failing.
    await http()
      .post(`/api/v1/studio/media/${slot.mediaId}/complete`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(enqueue).toHaveBeenCalledTimes(2);

    const status = await http()
      .get(`/api/v1/studio/media/${slot.mediaId}`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(status.body).toMatchObject({ status: 'uploaded', sizeBytes: MP4_HEAD.length });

    const actions = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'like', 'media.%')
      .orderBy('created_at')
      .execute();
    expect(actions.map((a) => a.action)).toEqual(['media.upload_create', 'media.upload_complete']);
    expect(await verifyAuditChain(t.db)).toMatchObject({ ok: true });
  });

  it('refuses a file whose size, type or first bytes differ from the request', async () => {
    const author = await userWith(['author']);
    const cases: [Record<string, unknown>, Buffer, string, RegExp][] = [
      [{ kind: 'video', contentType: 'video/mp4', sizeBytes: 999 }, MP4_HEAD, 'video/mp4', /size/],
      [
        { kind: 'video', contentType: 'video/mp4', sizeBytes: MP4_HEAD.length },
        MP4_HEAD,
        'image/png',
        /content type/,
      ],
      [{ kind: 'video', contentType: 'video/mp4', sizeBytes: PNG.length }, PNG, 'video/mp4', /MP4/],
      [
        { kind: 'image', contentType: 'image/jpeg', sizeBytes: PNG.length },
        PNG,
        'image/jpeg',
        /JPEG/,
      ],
    ];
    for (const [body, file, storedType, reason] of cases) {
      const slot = await upload(author, body, file, storedType);
      const res = await http()
        .post(`/api/v1/studio/media/${slot.mediaId}/complete`)
        .set('Authorization', author.auth)
        .expect(422);
      expect(res.body.code).toBe('UPLOAD_REJECTED');
      expect(res.body.errors[0].message).toMatch(reason);
      const row = await http()
        .get(`/api/v1/studio/media/${slot.mediaId}`)
        .set('Authorization', author.auth)
        .expect(200);
      expect(row.body.status).toBe('failed');
    }
    const again = await http()
      .post(
        `/api/v1/studio/media/${(await t.db.selectFrom('media_assets').select('id').executeTakeFirstOrThrow()).id}/complete`,
      )
      .set('Authorization', author.auth)
      .expect(409);
    expect(again.body.code).toBe('MEDIA_STATE_CONFLICT');
  });

  it('makes images and subtitles ready at once, with a preview URL', async () => {
    const author = await userWith(['author']);
    const image = await upload(
      author,
      { kind: 'image', contentType: 'image/png', sizeBytes: PNG.length },
      PNG,
    );
    const done = await http()
      .post(`/api/v1/studio/media/${image.mediaId}/complete`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(done.body.status).toBe('ready');
    expect(done.body.previewUrl).toContain(`sources/${image.mediaId}`);

    const video = await readyVideo(author.id);
    const vtt = Buffer.from('\uFEFFWEBVTT\n\n00:00.000 --> 00:02.000\nSalom\n');
    const sub = await upload(
      author,
      {
        kind: 'subtitle',
        contentType: 'text/vtt',
        sizeBytes: vtt.length,
        locale: 'uz-Latn',
        videoId: video.id,
      },
      vtt,
    );
    const subDone = await http()
      .post(`/api/v1/studio/media/${sub.mediaId}/complete`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(subDone.body).toMatchObject({ status: 'ready', locale: 'uz-Latn', videoId: video.id });
  });

  it('refuses SVG files that can run script', async () => {
    const author = await userWith(['author']);
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>',
    ]) {
      const file = Buffer.from(svg);
      const slot = await upload(
        author,
        { kind: 'image', contentType: 'image/svg+xml', sizeBytes: file.length },
        file,
      );
      const res = await http()
        .post(`/api/v1/studio/media/${slot.mediaId}/complete`)
        .set('Authorization', author.auth)
        .expect(422);
      expect(res.body.errors[0].message).toMatch(/SVG with scripts/);
    }
    const ok = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
    const slot = await upload(
      author,
      { kind: 'image', contentType: 'image/svg+xml', sizeBytes: ok.length },
      ok,
    );
    await http()
      .post(`/api/v1/studio/media/${slot.mediaId}/complete`)
      .set('Authorization', author.auth)
      .expect(200);
  });

  it('validates the upload request', async () => {
    const author = await userWith(['author']);
    const bad: [Record<string, unknown>, string][] = [
      [{ kind: 'video', contentType: 'image/png', sizeBytes: 10 }, 'contentType'],
      [{ kind: 'image', contentType: 'image/png', sizeBytes: 6_000_000 }, 'sizeBytes'],
      [{ kind: 'subtitle', contentType: 'text/vtt', sizeBytes: 10 }, 'locale'],
      [
        {
          kind: 'subtitle',
          contentType: 'text/vtt',
          sizeBytes: 10,
          locale: 'ru',
          videoId: newId(),
        },
        'videoId',
      ],
      [{ kind: 'image', contentType: 'image/png', sizeBytes: 10, videoId: newId() }, 'videoId'],
    ];
    for (const [body, field] of bad) {
      const res = await http()
        .post('/api/v1/studio/media/uploads')
        .set('Authorization', author.auth)
        .send(body)
        .expect(422);
      expect(res.body.errors[0].field).toBe(field);
    }
    await http()
      .post('/api/v1/studio/media/uploads')
      .set('Authorization', author.auth)
      .send({ kind: 'video', contentType: 'video/mp4', sizeBytes: 10, extra: 1 })
      .expect(400);
    await http()
      .get(`/api/v1/studio/media/${newId()}`)
      .set('Authorization', author.auth)
      .expect(404);
  });

  it('is for content staff only', async () => {
    const student = await userWith(['student']);
    await http()
      .post('/api/v1/studio/media/uploads')
      .set('Authorization', student.auth)
      .send({ kind: 'video', contentType: 'video/mp4', sizeBytes: 10 })
      .expect(403);
  });
});

describe('protected playback (architecture §7.3)', () => {
  async function setup(paid = false) {
    const author = await userWith(['author']);
    const video = await readyVideo(author.id);
    await lessonWith(video.id, author.id, paid);
    const student = await userWith(['student']);
    return { author, student, video };
  }

  it('serves rewritten playlists and the key to a learner with access', async () => {
    const { student, video } = await setup();
    const playback = await http()
      .get(`/api/v1/media/${video.id}/playback`)
      .set('Authorization', student.auth)
      .expect(200);
    expect(playback.headers['cache-control']).toBe('no-store, private');
    expect(playback.body.expiresAt).toBe('2026-11-15T10:10:00.000Z');
    expect(playback.body.watermark).toBe(
      `MP-${student.id.replaceAll('-', '').slice(-8).toUpperCase()}`,
    );
    expect(playback.body.subtitles).toEqual([]);
    const manifestUrl = playback.body.manifestUrl as string;
    expect(manifestUrl).toMatch(
      new RegExp(`^/api/v1/media/${video.id}/hls/master\\.m3u8\\?token=`),
    );
    const token = new URL(manifestUrl, 'http://x').searchParams.get('token')!;

    const master = await http().get(manifestUrl).set('Authorization', student.auth).expect(200);
    expect(master.headers['content-type']).toMatch(/application\/vnd\.apple\.mpegurl/);
    expect(master.text).toContain(`360p.m3u8?token=${encodeURIComponent(token)}`);
    expect(master.text).toContain(`audio.m3u8?token=${encodeURIComponent(token)}`);
    expect(master.text).not.toContain('index.m3u8');

    const media = await http()
      .get(`/api/v1/media/${video.id}/hls/360p.m3u8?token=${encodeURIComponent(token)}`)
      .set('Authorization', student.auth)
      .expect(200);
    expect(media.text).toContain(`URI="../key?token=${encodeURIComponent(token)}"`);
    expect(media.text).toContain('IV=0x0123456789abcdef0123456789abcdef');
    expect(media.text).toContain(
      `memory://bucket/hls/${video.id}/360p/seg_0000.ts?method=GET&ttl=3600`,
    );

    const key = await http()
      .get(`/api/v1/media/${video.id}/key?token=${encodeURIComponent(token)}`)
      .set('Authorization', student.auth)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(key.headers['cache-control']).toBe('no-store, private');
    expect(Buffer.compare(key.body as Buffer, video.key)).toBe(0);
  });

  it('lists the newest ready subtitle per language', async () => {
    const { author, student, video } = await setup();
    for (const [locale, text] of [
      ['ru', 'old'],
      ['ru', 'new'],
      ['uz-Latn', 'uz'],
    ] as const) {
      const file = Buffer.from(`WEBVTT\n\n${text}\n`);
      const slot = await upload(
        author,
        {
          kind: 'subtitle',
          contentType: 'text/vtt',
          sizeBytes: file.length,
          locale,
          videoId: video.id,
        },
        file,
      );
      await http()
        .post(`/api/v1/studio/media/${slot.mediaId}/complete`)
        .set('Authorization', author.auth)
        .expect(200);
      t.clock.advance(1000);
    }
    const playback = await http()
      .get(`/api/v1/media/${video.id}/playback`)
      .set('Authorization', student.auth)
      .expect(200);
    expect(playback.body.subtitles.map((s: { locale: string }) => s.locale).sort()).toEqual([
      'ru',
      'uz-Latn',
    ]);
    const ru = playback.body.subtitles.find((s: { locale: string }) => s.locale === 'ru');
    const latest = await t.db
      .selectFrom('media_assets')
      .select('source_key')
      .where('parent_id', '=', video.id)
      .where('locale', '=', 'ru')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(ru.url).toContain(latest.source_key);
  });

  it('refuses a token of another user, of another video, or past its expiry', async () => {
    const { student, video } = await setup();
    const other = await userWith(['student']);
    const playback = await http()
      .get(`/api/v1/media/${video.id}/playback`)
      .set('Authorization', student.auth)
      .expect(200);
    const token = encodeURIComponent(
      new URL(playback.body.manifestUrl, 'http://x').searchParams.get('token')!,
    );

    const stolen = await http()
      .get(`/api/v1/media/${video.id}/key?token=${token}`)
      .set('Authorization', other.auth)
      .expect(403);
    expect(stolen.body.code).toBe('PLAYBACK_TOKEN_INVALID');
    await http()
      .get(`/api/v1/media/${newId()}/hls/master.m3u8?token=${token}`)
      .set('Authorization', student.auth)
      .expect(403);
    await http()
      .get(`/api/v1/media/${video.id}/key?token=${token.slice(0, -2)}xx`)
      .set('Authorization', student.auth)
      .expect(403);

    t.clock.advance(10 * 60_000);
    await http()
      .get(`/api/v1/media/${video.id}/hls/master.m3u8?token=${token}`)
      .set('Authorization', student.auth)
      .expect(403);
  });

  it('serves only renditions the worker recorded', async () => {
    const { student, video } = await setup();
    const playback = await http()
      .get(`/api/v1/media/${video.id}/playback`)
      .set('Authorization', student.auth)
      .expect(200);
    const token = encodeURIComponent(
      new URL(playback.body.manifestUrl, 'http://x').searchParams.get('token')!,
    );
    await http()
      .get(`/api/v1/media/${video.id}/hls/1080p.m3u8?token=${token}`)
      .set('Authorization', student.auth)
      .expect(404);
    await http()
      .get(`/api/v1/media/${video.id}/hls/..%2Fsecret.m3u8?token=${token}`)
      .set('Authorization', student.auth)
      .expect(400);
  });

  it('asks for payment for a paid lesson and hides videos in no published lesson', async () => {
    const { student, video } = await setup(true);
    const paid = await http()
      .get(`/api/v1/media/${video.id}/playback`)
      .set('Authorization', student.auth)
      .expect(402);
    expect(paid.body.code).toBe('PAYMENT_REQUIRED');

    const author = await userWith(['author']);
    const loose = await readyVideo(author.id);
    await http()
      .get(`/api/v1/media/${loose.id}/playback`)
      .set('Authorization', student.auth)
      .expect(404);
    // Content staff may preview any ready video, in a lesson or not.
    await http()
      .get(`/api/v1/media/${loose.id}/playback`)
      .set('Authorization', author.auth)
      .expect(200);
  });

  it('does not offer a video that is still processing', async () => {
    const author = await userWith(['author']);
    const slot = await upload(
      author,
      { kind: 'video', contentType: 'video/mp4', sizeBytes: MP4_HEAD.length },
      MP4_HEAD,
    );
    await http()
      .get(`/api/v1/media/${slot.mediaId}/playback`)
      .set('Authorization', author.auth)
      .expect(404);
  });

  it('rate-limits key requests per session', async () => {
    const { student, video } = await setup();
    const playback = await http()
      .get(`/api/v1/media/${video.id}/playback`)
      .set('Authorization', student.auth)
      .expect(200);
    const token = encodeURIComponent(
      new URL(playback.body.manifestUrl, 'http://x').searchParams.get('token')!,
    );
    for (let i = 0; i < 30; i++) {
      await http()
        .get(`/api/v1/media/${video.id}/key?token=${token}`)
        .set('Authorization', student.auth)
        .expect(200);
    }
    const res = await http()
      .get(`/api/v1/media/${video.id}/key?token=${token}`)
      .set('Authorization', student.auth)
      .expect(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
