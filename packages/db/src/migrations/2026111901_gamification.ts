import { type Kysely, sql } from 'kysely';

/**
 * XP, levels, streaks, badges and daily quests (schema doc §3.8; PRD §8;
 * security plan C-26). Leagues come in their own migration.
 *
 * - `xp_ledger`: every award. The unique key on (user, reason, source)
 *   means the same answer, test or quest can never pay twice. `day` is the
 *   Tashkent day, for the daily cap. Not partitioned yet: at MVP volume an
 *   index on (user_id, day) is enough; partitioning is a later migration.
 * - `user_stats`: totals and the streak, a projection of the ledger.
 * - `user_badges`: badge codes; the badge catalogue is code, not data.
 * - `user_quests`: each learner's quests for a day, created when first needed.
 * - `attempts.reward`: what submitting the attempt earned, so a repeated
 *   submit or a reload of the result screen shows the same "+XP".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE xp_ledger (
      id          uuid PRIMARY KEY,
      user_id     uuid NOT NULL REFERENCES users (id),
      amount      integer NOT NULL CHECK (amount <> 0),
      reason      text NOT NULL CHECK (reason IN
                    ('first_try_correct','mastery_passed','review_passed','quest_completed','admin_adjustment')),
      source_type text NOT NULL,
      source_id   text NOT NULL,
      day         date NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, reason, source_type, source_id)
    )
  `.execute(db);
  await sql`CREATE INDEX xp_ledger_user_day_idx ON xp_ledger (user_id, day)`.execute(db);

  await sql`
    CREATE TABLE user_stats (
      user_id         uuid PRIMARY KEY REFERENCES users (id),
      xp_total        integer NOT NULL DEFAULT 0 CHECK (xp_total >= 0),
      level           smallint NOT NULL DEFAULT 1 CHECK (level >= 1),
      current_streak  integer NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
      longest_streak  integer NOT NULL DEFAULT 0 CHECK (longest_streak >= current_streak),
      last_active_day date,
      streak_freezes  smallint NOT NULL DEFAULT 0 CHECK (streak_freezes >= 0),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE user_badges (
      user_id    uuid NOT NULL REFERENCES users (id),
      badge_code text NOT NULL,
      awarded_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, badge_code)
    )
  `.execute(db);

  await sql`
    CREATE TABLE user_quests (
      user_id      uuid NOT NULL REFERENCES users (id),
      day          date NOT NULL,
      code         text NOT NULL,
      progress     integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
      target       integer NOT NULL CHECK (target > 0),
      completed_at timestamptz,
      PRIMARY KEY (user_id, day, code),
      CHECK ((completed_at IS NOT NULL) = (progress >= target))
    )
  `.execute(db);

  await sql`ALTER TABLE attempts ADD COLUMN reward jsonb`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE attempts DROP COLUMN reward`.execute(db);
  await sql`DROP TABLE user_quests`.execute(db);
  await sql`DROP TABLE user_badges`.execute(db);
  await sql`DROP TABLE user_stats`.execute(db);
  await sql`DROP TABLE xp_ledger`.execute(db);
}
