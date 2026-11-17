import { type Kysely, sql } from 'kysely';

/**
 * Assessment: attempts and their items (schema doc §3.7; step 6.4).
 *
 * An attempt is one sitting of a practice set or a test. Each item is a
 * generated question instance: the seed and values it was built from, what
 * the learner was shown, and the answer key, which never leaves the server
 * (C-16). Items point at the exact published template version, which is
 * frozen, so an old attempt can always be explained.
 *
 * `attempt_items` starts as a plain table; monthly partitioning follows with
 * the partition job, as for `audit_log` (schema doc §5 implementation note).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE assessments (
      id          uuid PRIMARY KEY,
      type        text NOT NULL CHECK (type IN ('diagnostic','practice','mastery','review','chapter','mock_exam')),
      scope_type  text NOT NULL CHECK (scope_type IN ('topic','chapter','course')),
      scope_id    uuid NOT NULL,
      blueprint   jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(blueprint) = 'object'),
      version_no  integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
      status      text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (type, scope_type, scope_id, version_no)
    )
  `.execute(db);

  await sql`
    CREATE TABLE attempts (
      id              uuid PRIMARY KEY,
      user_id         uuid NOT NULL REFERENCES users (id),
      assessment_id   uuid NOT NULL REFERENCES assessments (id),
      topic_id        uuid REFERENCES topics (id),
      assignment_id   uuid,
      status          text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','expired','invalidated')),
      started_at      timestamptz NOT NULL DEFAULT now(),
      deadline_at     timestamptz,
      submitted_at    timestamptz,
      score           numeric(7,2),
      max_score       numeric(7,2),
      passed          boolean,
      integrity_flags text[] NOT NULL DEFAULT '{}',
      idempotency_key text CHECK (char_length(idempotency_key) <= 128),
      created_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, idempotency_key),
      CHECK ((status = 'submitted') = (submitted_at IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX attempts_user_created_idx ON attempts (user_id, created_at DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX attempts_user_topic_idx ON attempts (user_id, topic_id)`.execute(db);
  // One open sitting per learner and assessment: starting again resumes it.
  await sql`
    CREATE UNIQUE INDEX attempts_one_open
      ON attempts (user_id, assessment_id) WHERE status = 'in_progress'
  `.execute(db);

  await sql`
    CREATE TABLE attempt_items (
      id                  uuid PRIMARY KEY,
      attempt_id          uuid NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
      position            smallint NOT NULL CHECK (position >= 1),
      template_version_id uuid NOT NULL REFERENCES question_template_versions (id),
      seed                text NOT NULL,
      params              jsonb NOT NULL,
      presented           jsonb NOT NULL,
      answer_key          jsonb NOT NULL,
      feedback            jsonb NOT NULL,
      response            jsonb,
      is_correct          boolean,
      score               numeric(5,2),
      tries               smallint NOT NULL DEFAULT 0 CHECK (tries >= 0),
      hints_shown         smallint NOT NULL DEFAULT 0 CHECK (hints_shown >= 0),
      served_at           timestamptz,
      answered_at         timestamptz,
      last_request_key    text CHECK (char_length(last_request_key) <= 128),
      last_result         jsonb,
      created_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (attempt_id, position)
    )
  `.execute(db);

  await sql`
    CREATE TABLE daily_usage (
      user_id         uuid NOT NULL REFERENCES users (id),
      day             date NOT NULL,
      exercises_count integer NOT NULL DEFAULT 0 CHECK (exercises_count >= 0),
      minutes_active  integer NOT NULL DEFAULT 0 CHECK (minutes_active >= 0),
      PRIMARY KEY (user_id, day)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE daily_usage`.execute(db);
  await sql`DROP TABLE attempt_items`.execute(db);
  await sql`DROP TABLE attempts`.execute(db);
  await sql`DROP TABLE assessments`.execute(db);
}
