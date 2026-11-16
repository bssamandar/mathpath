import { type Kysely, sql } from 'kysely';

/**
 * Question templates (schema doc §3.4, §4.2; step 6.4).
 *
 * A template belongs to a topic and has versions with the same workflow and
 * freeze rule as lesson versions: a published version never changes, because
 * attempts point at the exact version a learner answered. The body (answer
 * rule, distractors, solution) is server-only (C-16).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE question_templates (
      id                   uuid PRIMARY KEY,
      topic_id             uuid NOT NULL REFERENCES topics (id),
      external_ref         text CHECK (char_length(external_ref) <= 64),
      created_by           uuid NOT NULL REFERENCES users (id),
      created_at           timestamptz NOT NULL DEFAULT now(),
      published_version_id uuid
    )
  `.execute(db);
  await sql`CREATE INDEX question_templates_topic_idx ON question_templates (topic_id)`.execute(db);

  await sql`
    CREATE TABLE question_template_versions (
      id           uuid PRIMARY KEY,
      template_id  uuid NOT NULL REFERENCES question_templates (id),
      version_no   integer NOT NULL CHECK (version_no > 0),
      status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','changes_requested','approved','published','archived')),
      type         text NOT NULL CHECK (type IN ('single_choice','multiple_choice','numeric','formula','matching','ordering')),
      difficulty   smallint NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
      skills       text[] NOT NULL DEFAULT '{}',
      body         jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
      author_id    uuid NOT NULL REFERENCES users (id),
      content_hash text NOT NULL,
      published_at timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (template_id, version_no),
      CHECK ((status IN ('published', 'archived')) OR published_at IS NULL)
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX question_template_versions_one_open_draft
      ON question_template_versions (template_id)
      WHERE status IN ('draft', 'in_review', 'changes_requested', 'approved')
  `.execute(db);
  await sql`
    ALTER TABLE question_templates
      ADD CONSTRAINT question_templates_published_version_fk
      FOREIGN KEY (published_version_id) REFERENCES question_template_versions (id)
  `.execute(db);

  await sql`
    CREATE FUNCTION question_template_versions_freeze() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('published', 'archived') THEN
          RAISE EXCEPTION 'published question versions cannot be deleted' USING ERRCODE = 'P0001';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.status = 'archived' THEN
        RAISE EXCEPTION 'archived question versions are immutable' USING ERRCODE = 'P0001';
      END IF;
      IF OLD.status = 'published' AND (
           NEW.status <> 'archived'
        OR NEW.type IS DISTINCT FROM OLD.type
        OR NEW.difficulty IS DISTINCT FROM OLD.difficulty
        OR NEW.skills IS DISTINCT FROM OLD.skills
        OR NEW.body IS DISTINCT FROM OLD.body
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.template_id IS DISTINCT FROM OLD.template_id
        OR NEW.version_no IS DISTINCT FROM OLD.version_no
        OR NEW.author_id IS DISTINCT FROM OLD.author_id
      ) THEN
        RAISE EXCEPTION 'published question versions are immutable' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER question_template_versions_freeze
      BEFORE UPDATE OR DELETE ON question_template_versions
      FOR EACH ROW EXECUTE FUNCTION question_template_versions_freeze()
  `.execute(db);
  await sql`CREATE TRIGGER question_template_versions_updated_at BEFORE UPDATE ON question_template_versions
            FOR EACH ROW EXECUTE FUNCTION set_updated_at()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE question_templates DROP CONSTRAINT question_templates_published_version_fk`.execute(
    db,
  );
  await sql`DROP TABLE question_template_versions`.execute(db);
  await sql`DROP FUNCTION question_template_versions_freeze()`.execute(db);
  await sql`DROP TABLE question_templates`.execute(db);
}
