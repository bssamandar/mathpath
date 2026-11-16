/**
 * Migration 2026111601: catalogue and versioned lesson content
 * (docs/database-schema.md §3.4).
 *
 * The structure (track → course → chapter → topic) changes rarely, so it is in
 * plain tables. What a lesson teaches changes often and must be reviewed, so it
 * lives in versioned documents (`topic_versions`). A published version is
 * immutable, enforced by a trigger and not only by the service: a learner's
 * progress points at the exact version they studied, and a later "small fix"
 * must never change what they were tested on.
 *
 * Question templates follow in the question-engine step (6.4); the
 * `content_reviews` table already accepts them as an entity type.
 */
import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE tracks (
      id        uuid PRIMARY KEY,
      slug      text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
      title     jsonb NOT NULL CHECK (jsonb_typeof(title) = 'object'),
      sort      smallint NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true
    )
  `.execute(db);

  await sql`
    CREATE TABLE courses (
      id          uuid PRIMARY KEY,
      track_id    uuid NOT NULL REFERENCES tracks (id),
      slug        text NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,60}$'),
      grade       smallint CHECK (grade BETWEEN 1 AND 11),
      title       jsonb NOT NULL CHECK (jsonb_typeof(title) = 'object'),
      description jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(description) = 'object'),
      status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
      sort        smallint NOT NULL DEFAULT 0,
      UNIQUE (track_id, slug)
    )
  `.execute(db);

  await sql`
    CREATE TABLE chapters (
      id        uuid PRIMARY KEY,
      course_id uuid NOT NULL REFERENCES courses (id),
      slug      text NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,60}$'),
      title     jsonb NOT NULL CHECK (jsonb_typeof(title) = 'object'),
      sort      smallint NOT NULL DEFAULT 0,
      status    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
      UNIQUE (course_id, slug)
    )
  `.execute(db);

  await sql`
    CREATE TABLE topics (
      id                   uuid PRIMARY KEY,
      chapter_id           uuid NOT NULL REFERENCES chapters (id),
      slug                 text NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,60}$'),
      sort                 smallint NOT NULL DEFAULT 0,
      is_free              boolean NOT NULL DEFAULT false,
      published_version_id uuid,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (chapter_id, slug)
    )
  `.execute(db);
  await sql`CREATE INDEX topics_chapter_idx ON topics (chapter_id)`.execute(db);

  await sql`
    CREATE TABLE topic_versions (
      id            uuid PRIMARY KEY,
      topic_id      uuid NOT NULL REFERENCES topics (id),
      version_no    integer NOT NULL CHECK (version_no > 0),
      status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','changes_requested','approved','published','archived')),
      title         jsonb NOT NULL CHECK (jsonb_typeof(title) = 'object'),
      summary       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(summary) = 'object'),
      steps         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steps) = 'array'),
      question_pool jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(question_pool) = 'object'),
      author_id     uuid NOT NULL REFERENCES users (id),
      content_hash  text NOT NULL,
      published_at  timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (topic_id, version_no),
      CHECK ((status IN ('published', 'archived')) OR published_at IS NULL)
    )
  `.execute(db);
  // At most one open draft per topic: two authors editing two drafts would
  // silently overwrite each other's work on publish.
  await sql`
    CREATE UNIQUE INDEX topic_versions_one_open_draft
      ON topic_versions (topic_id)
      WHERE status IN ('draft', 'in_review', 'changes_requested', 'approved')
  `.execute(db);

  await sql`
    ALTER TABLE topics
      ADD CONSTRAINT topics_published_version_fk
      FOREIGN KEY (published_version_id) REFERENCES topic_versions (id)
  `.execute(db);

  // Published versions are frozen. The only change allowed is archiving one
  // when a newer version replaces it; deleting one is never allowed.
  await sql`
    CREATE FUNCTION topic_versions_freeze() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('published', 'archived') THEN
          RAISE EXCEPTION 'published topic versions cannot be deleted' USING ERRCODE = 'P0001';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.status = 'archived' THEN
        RAISE EXCEPTION 'archived topic versions are immutable' USING ERRCODE = 'P0001';
      END IF;
      IF OLD.status = 'published' AND (
           NEW.status <> 'archived'
        OR NEW.title IS DISTINCT FROM OLD.title
        OR NEW.summary IS DISTINCT FROM OLD.summary
        OR NEW.steps IS DISTINCT FROM OLD.steps
        OR NEW.question_pool IS DISTINCT FROM OLD.question_pool
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.topic_id IS DISTINCT FROM OLD.topic_id
        OR NEW.version_no IS DISTINCT FROM OLD.version_no
        OR NEW.author_id IS DISTINCT FROM OLD.author_id
      ) THEN
        RAISE EXCEPTION 'published topic versions are immutable' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER topic_versions_freeze
      BEFORE UPDATE OR DELETE ON topic_versions
      FOR EACH ROW EXECUTE FUNCTION topic_versions_freeze()
  `.execute(db);

  await sql`CREATE TRIGGER topics_updated_at BEFORE UPDATE ON topics
            FOR EACH ROW EXECUTE FUNCTION set_updated_at()`.execute(db);
  await sql`CREATE TRIGGER topic_versions_updated_at BEFORE UPDATE ON topic_versions
            FOR EACH ROW EXECUTE FUNCTION set_updated_at()`.execute(db);

  await sql`
    CREATE TABLE topic_prerequisites (
      topic_id        uuid NOT NULL REFERENCES topics (id),
      prerequisite_id uuid NOT NULL REFERENCES topics (id),
      strength        text NOT NULL DEFAULT 'required' CHECK (strength IN ('required', 'helpful')),
      PRIMARY KEY (topic_id, prerequisite_id),
      CHECK (topic_id <> prerequisite_id)
    )
  `.execute(db);
  await sql`CREATE INDEX topic_prerequisites_prereq_idx ON topic_prerequisites (prerequisite_id)`.execute(
    db,
  );

  await sql`
    CREATE TABLE topic_mappings (
      topic_id        uuid NOT NULL REFERENCES topics (id),
      mapped_topic_id uuid NOT NULL REFERENCES topics (id),
      relation        text NOT NULL CHECK (relation IN ('equivalent', 'partial', 'extends')),
      PRIMARY KEY (topic_id, mapped_topic_id),
      CHECK (topic_id <> mapped_topic_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE content_reviews (
      id          uuid PRIMARY KEY,
      entity_type text NOT NULL CHECK (entity_type IN ('topic_version', 'question_template_version')),
      entity_id   uuid NOT NULL,
      reviewer_id uuid NOT NULL REFERENCES users (id),
      decision    text NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
      comments    jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(comments) = 'array'),
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX content_reviews_entity_idx ON content_reviews (entity_type, entity_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE content_reviews`.execute(db);
  await sql`DROP TABLE topic_mappings`.execute(db);
  await sql`DROP TABLE topic_prerequisites`.execute(db);
  await sql`ALTER TABLE topics DROP CONSTRAINT topics_published_version_fk`.execute(db);
  await sql`DROP TABLE topic_versions`.execute(db);
  await sql`DROP FUNCTION topic_versions_freeze()`.execute(db);
  await sql`DROP TABLE topics`.execute(db);
  await sql`DROP TABLE chapters`.execute(db);
  await sql`DROP TABLE courses`.execute(db);
  await sql`DROP TABLE tracks`.execute(db);
}
