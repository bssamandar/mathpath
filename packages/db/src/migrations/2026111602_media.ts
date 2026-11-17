/**
 * Migration 2026111602: media assets and HLS keys (docs/database-schema.md §3.5).
 *
 * An upload moves awaiting_upload → uploaded → processing → ready (or failed).
 * Images and subtitles skip processing. Subtitles belong to one video
 * (`parent_id`) and one locale.
 *
 * The AES-128 key of each video lives in `media_keys`, sealed with a key the
 * database never sees (MEDIA_KEY_SECRET), so a dump alone cannot decrypt the
 * videos. The schema doc's `key_ref` column is not needed: the key row is
 * found by `media_id`.
 */
import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE media_assets (
      id               uuid PRIMARY KEY,
      kind             text NOT NULL CHECK (kind IN ('video', 'image', 'subtitle')),
      locale           text CHECK (locale IN ('uz-Latn', 'ru', 'en')),
      parent_id        uuid REFERENCES media_assets (id),
      content_type     text NOT NULL,
      size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
      source_key       text NOT NULL UNIQUE,
      status           text NOT NULL DEFAULT 'awaiting_upload'
                       CHECK (status IN ('awaiting_upload', 'uploaded', 'processing', 'ready', 'failed')),
      hls_manifest_key text,
      duration_s       integer CHECK (duration_s > 0),
      renditions       jsonb CHECK (renditions IS NULL OR jsonb_typeof(renditions) = 'array'),
      error            text,
      uploaded_by      uuid NOT NULL REFERENCES users (id),
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CHECK (kind <> 'subtitle' OR (locale IS NOT NULL AND parent_id IS NOT NULL)),
      CHECK (kind = 'subtitle' OR parent_id IS NULL),
      CHECK (kind <> 'video' OR status <> 'ready' OR (hls_manifest_key IS NOT NULL AND duration_s IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX media_assets_parent_idx ON media_assets (parent_id) WHERE parent_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE TRIGGER media_assets_updated_at BEFORE UPDATE ON media_assets
            FOR EACH ROW EXECUTE FUNCTION set_updated_at()`.execute(db);

  await sql`
    CREATE TABLE media_keys (
      media_id   uuid PRIMARY KEY REFERENCES media_assets (id),
      sealed_key bytea NOT NULL CHECK (octet_length(sealed_key) = 44),
      iv         bytea NOT NULL CHECK (octet_length(iv) = 16),
      created_at timestamptz NOT NULL DEFAULT now(),
      rotated_at timestamptz
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE media_keys`.execute(db);
  await sql`DROP TABLE media_assets`.execute(db);
}
