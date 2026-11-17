/**
 * Media uploads and protected playback (docs/architecture.md §4 `media`, §7.3).
 *
 * Upload: the studio asks for a slot, the browser PUTs the file straight to
 * object storage with a presigned URL (the API never streams large files),
 * then tells the API it finished. The API checks the stored object (size,
 * type, first bytes) before trusting it, and queues videos for transcoding.
 *
 * Playback: a learner gets a short-lived token for a video that appears in a
 * published lesson they may open. Playlists and the AES-128 key are only
 * served with that token and the same signed-in user; the key endpoint
 * re-checks access and is rate-limited per session.
 */
import type { AppConfig } from '@mathpath/config';
import {
  type Database,
  type Locale,
  type MediaKind,
  newId,
  type Rendition,
  type Role,
} from '@mathpath/db';
import { mediaKeys, type MediaKeyVault, type ObjectStore } from '@mathpath/media';
import type { MediaAssetsTable } from '@mathpath/db';
import { type Kysely, type Selectable, sql } from 'kysely';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import type { RateLimiter } from '../common/rate-limiter';
import type { Entitlements } from '../content/catalogue.service';
import { tooMany } from '../identity/otp.service';
import { type Permission, permissionsFor } from '../identity/permissions';
import { rewriteMaster, rewriteMedia } from './hls';
import type { PlaybackTokens } from './playback-token';
import type { TranscodeQueue } from './transcode-queue';

/** The signed-in caller, as the access guard decoded it. */
export interface MediaActor {
  userId: string;
  sessionId: string;
  roles: readonly Role[];
  mfaVerified: boolean;
}

/** Allowed content types per kind (docs/api/openapi.yaml `createMediaUpload`). */
const CONTENT_TYPES: Record<MediaKind, readonly string[]> = {
  video: ['video/mp4'],
  image: ['image/png', 'image/jpeg', 'image/svg+xml'],
  subtitle: ['text/vtt'],
};

export interface UploadRequest {
  kind: MediaKind;
  contentType: string;
  sizeBytes: number;
  locale?: Locale | undefined;
  /** The video a subtitle file belongs to. */
  videoId?: string | undefined;
}

/** `MediaAsset` in docs/api/openapi.yaml. */
export interface MediaAssetView {
  id: string;
  kind: MediaKind;
  status: string;
  contentType: string;
  sizeBytes: number;
  locale: Locale | null;
  videoId: string | null;
  durationS: number | null;
  renditions: Rendition[];
  error: string | null;
  /** A short-lived download URL for images and subtitles once ready. */
  previewUrl: string | null;
}

export interface PlaybackView {
  manifestUrl: string;
  expiresAt: string;
  watermark: string;
  subtitles: { locale: Locale; url: string }[];
}

type MediaRow = Selectable<MediaAssetsTable>;

const notFound = () => new ProblemException(404, 'MEDIA_NOT_FOUND', 'This media does not exist.');
const badToken = () =>
  new ProblemException(403, 'PLAYBACK_TOKEN_INVALID', 'This playback link has expired.');

export class MediaService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly store: ObjectStore,
    private readonly vault: MediaKeyVault,
    private readonly queue: TranscodeQueue,
    private readonly tokens: PlaybackTokens,
    private readonly entitlements: Entitlements,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly rules: AppConfig['content'],
  ) {}

  // ───────────────────────────── Studio ─────────────────────────────

  /**
   * Creates an upload slot and a presigned PUT URL for it.
   * @throws ProblemException 422 for a wrong type, size, locale or video.
   */
  async createUpload(actor: MediaActor, input: UploadRequest) {
    if (!CONTENT_TYPES[input.kind].includes(input.contentType)) {
      throw invalid(
        'contentType',
        `A ${input.kind} must be ${CONTENT_TYPES[input.kind].join(', ')}.`,
      );
    }
    const max = {
      video: this.rules.video.maxUploadBytes,
      image: this.rules.media.maxImageBytes,
      subtitle: this.rules.media.maxSubtitleBytes,
    }[input.kind];
    if (input.sizeBytes > max) throw invalid('sizeBytes', `At most ${max} bytes.`);
    if (input.kind === 'subtitle') {
      if (!input.locale) throw invalid('locale', 'Subtitles need a locale.');
      const video = input.videoId
        ? await this.db
            .selectFrom('media_assets')
            .select('kind')
            .where('id', '=', input.videoId)
            .executeTakeFirst()
        : undefined;
      if (video?.kind !== 'video') throw invalid('videoId', 'Subtitles need an existing video.');
    } else if (input.videoId) {
      throw invalid('videoId', 'Only subtitles belong to a video.');
    }

    const id = newId();
    const ttl = this.rules.media.uploadUrlTtlSeconds;
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('media_assets')
        .values({
          id,
          kind: input.kind,
          locale: input.kind === 'image' ? null : (input.locale ?? null),
          parent_id: input.kind === 'subtitle' ? input.videoId! : null,
          content_type: input.contentType,
          size_bytes: input.sizeBytes,
          source_key: mediaKeys.source(id),
          uploaded_by: actor.userId,
        })
        .execute();
      await this.audit.record(
        {
          action: 'media.upload_create',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'media_asset',
          targetId: id,
          metadata: {
            kind: input.kind,
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
          },
        },
        trx,
      );
    });
    const uploadUrl = await this.store.presignUpload(
      mediaKeys.source(id),
      input.contentType,
      input.sizeBytes,
      ttl,
    );
    return {
      mediaId: id,
      uploadUrl,
      expiresAt: new Date(this.clock.now().getTime() + ttl * 1000).toISOString(),
    };
  }

  /**
   * Checks the uploaded object and moves the asset on: videos to the
   * transcoding queue, images and subtitles straight to ready. Calling it
   * again for an uploaded video queues it again (the job ID deduplicates).
   * @throws ProblemException 409 UPLOAD_MISSING, 422 UPLOAD_REJECTED.
   */
  async completeUpload(actor: MediaActor, mediaId: string): Promise<MediaAssetView> {
    const row = await this.findRow(mediaId);
    if (row.kind === 'video' && row.status === 'uploaded') {
      await this.queue.enqueue(row.id);
      return this.view(row);
    }
    if (row.status !== 'awaiting_upload') {
      throw new ProblemException(
        409,
        'MEDIA_STATE_CONFLICT',
        `This media is already ${row.status}.`,
      );
    }
    const stored = await this.store.head(row.source_key);
    if (!stored) {
      throw new ProblemException(409, 'UPLOAD_MISSING', 'The file has not arrived yet.');
    }
    const problem =
      stored.sizeBytes !== Number(row.size_bytes)
        ? 'size differs from the upload request'
        : stored.contentType !== row.content_type
          ? 'content type differs from the upload request'
          : sniff(
              row.content_type,
              // An SVG is read whole (at most maxImageBytes): script may sit anywhere in it.
              await this.store.read(
                row.source_key,
                row.content_type === 'image/svg+xml' ? undefined : 4096,
              ),
            );
    const next = problem ? 'failed' : row.kind === 'video' ? 'uploaded' : 'ready';

    await this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable('media_assets')
        .set({ status: next, error: problem })
        .where('id', '=', row.id)
        .where('status', '=', 'awaiting_upload')
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) {
        throw new ProblemException(409, 'MEDIA_STATE_CONFLICT', 'This media changed meanwhile.');
      }
      await this.audit.record(
        {
          action: problem ? 'media.upload_rejected' : 'media.upload_complete',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'media_asset',
          targetId: row.id,
          metadata: problem ? { reason: problem } : { kind: row.kind },
        },
        trx,
      );
    });
    if (problem) {
      throw new ProblemException(422, 'UPLOAD_REJECTED', 'The uploaded file was refused.', {
        errors: [{ field: 'file', message: problem }],
      });
    }
    if (next === 'uploaded') await this.queue.enqueue(row.id);
    return this.view(await this.findRow(row.id));
  }

  async asset(mediaId: string): Promise<MediaAssetView> {
    return this.view(await this.findRow(mediaId));
  }

  // ──────────────────────────── Playback ────────────────────────────

  /**
   * A token-bearing manifest URL for a ready video the caller may watch.
   * @throws ProblemException 404 when not found or not in an open lesson, 402 without access.
   */
  async playback(actor: MediaActor, mediaId: string): Promise<PlaybackView> {
    const row = await this.findRow(mediaId);
    if (row.kind !== 'video' || row.status !== 'ready') throw notFound();
    await this.assertCanWatch(actor, row.id);

    const now = this.clock.now().getTime();
    const ttl = this.rules.media.playbackTtlSeconds;
    const expiresAt = Math.floor(now / 1000) + ttl;
    const token = this.tokens.sign({ mediaId: row.id, userId: actor.userId, expiresAt });
    const subtitles = await this.db
      .selectFrom('media_assets')
      .select(['source_key', 'locale'])
      .where('parent_id', '=', row.id)
      .where('kind', '=', 'subtitle')
      .where('status', '=', 'ready')
      .orderBy('created_at', 'desc')
      .execute();
    const seen = new Set<string>();
    const latest = subtitles.filter((s) => s.locale && !seen.has(s.locale) && seen.add(s.locale));
    return {
      manifestUrl: `/api/v1/media/${row.id}/hls/master.m3u8?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      watermark: watermarkFor(actor.userId),
      subtitles: await Promise.all(
        latest.map(async (s) => ({
          locale: s.locale!,
          url: await this.store.presignDownload(s.source_key, ttl),
        })),
      ),
    };
  }

  /**
   * A playlist rewritten for this viewer.
   * @param name - `master` or a rendition name from the asset's renditions.
   */
  async playlist(actor: MediaActor, mediaId: string, name: string, token: string): Promise<string> {
    this.checkToken(actor, mediaId, token);
    const row = await this.findRow(mediaId);
    if (row.status !== 'ready' || !row.hls_manifest_key) throw notFound();
    if (name === 'master') {
      return rewriteMaster((await this.store.read(row.hls_manifest_key)).toString('utf8'), token);
    }
    // Only names the worker recorded, so a crafted name cannot reach another path.
    if (!(row.renditions ?? []).some((r) => r.name === name)) throw notFound();
    const playlist = await this.store.read(mediaKeys.hls(row.id, `${name}/index.m3u8`));
    const ttl = this.rules.media.segmentUrlTtlSeconds;
    return rewriteMedia(playlist.toString('utf8'), token, (file) =>
      this.store.presignDownload(mediaKeys.hls(row.id, `${name}/${file}`), ttl),
    );
  }

  /**
   * The raw AES-128 key. Access is checked again on every call, so a
   * subscription that ended stops playback at the next key request.
   * @throws ProblemException 403 for a bad token, 429 over the per-session limit.
   */
  async key(actor: MediaActor, mediaId: string, token: string): Promise<Buffer> {
    this.checkToken(actor, mediaId, token);
    const limit = await this.limiter.consume(`media-key:${actor.sessionId}`, {
      limit: this.rules.media.keyRequestsPerMinute,
      windowMs: 60_000,
    });
    if (!limit.allowed) throw tooMany(limit.retryAfterS);
    await this.assertCanWatch(actor, mediaId);
    const row = await this.db
      .selectFrom('media_keys')
      .select('sealed_key')
      .where('media_id', '=', mediaId)
      .executeTakeFirst();
    if (!row) throw notFound();
    return this.vault.open(mediaId, row.sealed_key);
  }

  // ──────────────────────────── Helpers ─────────────────────────────

  private checkToken(actor: MediaActor, mediaId: string, token: string): void {
    const claims = this.tokens.verify(token, this.clock.now().getTime());
    if (!claims || claims.mediaId !== mediaId || claims.userId !== actor.userId) throw badToken();
  }

  /**
   * Content staff may preview any video. Anyone else needs the video in a
   * published lesson of a published course that is free or entitled.
   */
  private async assertCanWatch(actor: MediaActor, videoId: string): Promise<void> {
    const granted = permissionsFor(actor.roles, actor.mfaVerified);
    if ((['content:author', 'content:review'] as Permission[]).some((p) => granted.has(p))) return;

    const topics = await this.db
      .selectFrom('topics as t')
      .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
      .innerJoin('chapters as ch', 'ch.id', 't.chapter_id')
      .innerJoin('courses as c', 'c.id', 'ch.course_id')
      .select(['t.id', 't.is_free'])
      .where('ch.status', '=', 'published')
      .where('c.status', '=', 'published')
      .where(sql<boolean>`v.steps @> ${JSON.stringify([{ mediaId: videoId }])}::jsonb`)
      .execute();
    if (topics.length === 0) throw notFound();
    for (const topic of topics) {
      if (topic.is_free || (await this.entitlements.hasAccess(actor.userId, topic.id))) return;
    }
    throw new ProblemException(402, 'PAYMENT_REQUIRED', 'This video is part of a paid plan.');
  }

  private async findRow(mediaId: string): Promise<MediaRow> {
    const row = await this.db
      .selectFrom('media_assets')
      .selectAll()
      .where('id', '=', mediaId)
      .executeTakeFirst();
    if (!row) throw notFound();
    return row;
  }

  private async view(row: MediaRow): Promise<MediaAssetView> {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      locale: row.locale,
      videoId: row.parent_id,
      durationS: row.duration_s,
      renditions: row.renditions ?? [],
      error: row.error,
      previewUrl:
        row.kind !== 'video' && row.status === 'ready'
          ? await this.store.presignDownload(row.source_key, this.rules.media.playbackTtlSeconds)
          : null,
    };
  }
}

function invalid(field: string, message: string): ProblemException {
  return new ProblemException(422, 'VALIDATION_FAILED', 'The upload request is invalid.', {
    errors: [{ field, message }],
  });
}

/**
 * Checks the first bytes match the declared type, so a renamed file is
 * refused before ffmpeg or a browser ever sees it.
 * @returns A reason to refuse, or null.
 */
export function sniff(contentType: string, head: Buffer): string | null {
  const ascii = head.toString('latin1');
  switch (contentType) {
    case 'video/mp4':
      return ascii.slice(4, 8) === 'ftyp' ? null : 'not an MP4 file';
    case 'image/png':
      return head
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        ? null
        : 'not a PNG file';
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? null : 'not a JPEG file';
    case 'image/svg+xml': {
      // SVG can carry script. Storage is served from its own origin, and on
      // top of that anything scriptable is refused outright.
      const text = head.toString('utf8');
      if (!/<svg[\s>]/i.test(text)) return 'not an SVG file';
      return /<script|\bon\w+\s*=|javascript:|<foreignObject/i.test(text)
        ? 'SVG with scripts or event handlers is not allowed'
        : null;
    }
    case 'text/vtt':
      return /^(\uFEFF)?WEBVTT/.test(head.toString('utf8')) ? null : 'not a WebVTT file';
    default:
      return 'unsupported type';
  }
}

/**
 * The code drawn over the video. The last 8 hex digits of the user ID are
 * random (UUIDv7), so the code finds the account behind a leaked recording
 * without showing the viewer's name or phone.
 */
export function watermarkFor(userId: string): string {
  return `MP-${userId.replaceAll('-', '').slice(-8).toUpperCase()}`;
}
