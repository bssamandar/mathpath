import { type Kysely, sql } from 'kysely';

/**
 * Learning state and adaptivity (schema doc §3.6; architecture §5.2; ADR-0006).
 *
 * - `topic_progress`: one row per learner and topic, with the mastery
 *   estimate and the spaced-repetition (SM-2) state.
 * - `learning_detours`: each gap-routing decision that sent a learner to a
 *   prerequisite, so depth and per-day limits can be enforced and the
 *   learning path can place the prerequisite before the topic.
 * - `learning_events`: an append-only log of adaptivity decisions (ADR-0006
 *   "we log every routing decision"). Plain table for now, partitioned later
 *   with the partition job, as for `audit_log`.
 * - A trigger refuses a prerequisite edge that would close a cycle, so the
 *   knowledge graph stays a DAG whatever writes it (the CMS, a seed, SQL).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE topic_progress (
      user_id              uuid NOT NULL REFERENCES users (id),
      topic_id             uuid NOT NULL REFERENCES topics (id),
      topic_version_id     uuid REFERENCES topic_versions (id),
      state                text NOT NULL DEFAULT 'not_started'
                           CHECK (state IN ('not_started','learning','mastered','needs_review')),
      mastery              numeric(4,3) CHECK (mastery BETWEEN 0 AND 1),
      steps_completed      smallint[] NOT NULL DEFAULT '{}',
      mastered_at          timestamptz,
      next_review_at       timestamptz,
      review_interval_days smallint CHECK (review_interval_days > 0),
      ease                 numeric(3,2) CHECK (ease BETWEEN 1.30 AND 3.00),
      review_count         smallint NOT NULL DEFAULT 0 CHECK (review_count >= 0),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, topic_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX topic_progress_review_idx ON topic_progress (user_id, next_review_at)
      WHERE next_review_at IS NOT NULL
  `.execute(db);

  await sql`
    CREATE TABLE learning_detours (
      id              uuid PRIMARY KEY,
      user_id         uuid NOT NULL REFERENCES users (id),
      from_topic_id   uuid NOT NULL REFERENCES topics (id),
      to_topic_id     uuid NOT NULL REFERENCES topics (id),
      depth           smallint NOT NULL CHECK (depth >= 1),
      status          text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','refreshed','added_to_path','closed')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      resolved_at     timestamptz,
      CHECK (from_topic_id <> to_topic_id),
      CHECK ((status = 'open') = (resolved_at IS NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX learning_detours_user_idx ON learning_detours (user_id, created_at)`.execute(
    db,
  );

  await sql`
    CREATE TABLE learning_events (
      id          uuid PRIMARY KEY,
      user_id     uuid NOT NULL REFERENCES users (id),
      type        text NOT NULL CHECK (type ~ '^[a-z][a-z_]{2,40}$'),
      topic_id    uuid,
      payload     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX learning_events_user_idx ON learning_events (user_id, created_at)`.execute(
    db,
  );

  // The gap router's recommendation, kept so a repeated submit returns the same result.
  await sql`ALTER TABLE attempts ADD COLUMN recommendation jsonb`.execute(db);

  // Adding prerequisite_id as a prerequisite of topic_id closes a cycle when
  // topic_id is already reachable from prerequisite_id's own prerequisites.
  await sql`
    CREATE FUNCTION topic_prerequisites_no_cycle() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        WITH RECURSIVE reach (id) AS (
          SELECT p.prerequisite_id FROM topic_prerequisites p WHERE p.topic_id = NEW.prerequisite_id
          UNION
          SELECT p.prerequisite_id FROM topic_prerequisites p JOIN reach r ON p.topic_id = r.id
        )
        SELECT 1 FROM reach WHERE id = NEW.topic_id
      ) THEN
        RAISE EXCEPTION 'prerequisite edge % -> % would create a cycle', NEW.topic_id, NEW.prerequisite_id
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER topic_prerequisites_no_cycle
      BEFORE INSERT OR UPDATE ON topic_prerequisites
      FOR EACH ROW EXECUTE FUNCTION topic_prerequisites_no_cycle()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER topic_prerequisites_no_cycle ON topic_prerequisites`.execute(db);
  await sql`DROP FUNCTION topic_prerequisites_no_cycle()`.execute(db);
  await sql`ALTER TABLE attempts DROP COLUMN recommendation`.execute(db);
  await sql`DROP TABLE learning_events`.execute(db);
  await sql`DROP TABLE learning_detours`.execute(db);
  await sql`DROP TABLE topic_progress`.execute(db);
}
