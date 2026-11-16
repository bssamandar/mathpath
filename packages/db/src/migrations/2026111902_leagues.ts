import { type Kysely, sql } from 'kysely';

/**
 * Weekly leagues (schema doc §3.8; PRD §8; UX S8; security plan C-26).
 *
 * - `leagues`: one group of about 30 learners for a Tashkent week (Monday to
 *   Sunday), a tier and a grade band, so children compete with peers.
 *   `cohort` numbers the groups of the same week, tier and band.
 *   `closed_at` is set by the worker's weekly close.
 * - `league_members`: a learner's weekly XP in their league. One league per
 *   learner per week (unique key). `final_rank` and `outcome` are written at
 *   the close.
 * - `user_stats.league_tier`: the tier a learner joins next week.
 *
 * Weekly XP is kept here, not in Redis sorted sets: a league has about 30
 * rows, so ranking them in PostgreSQL is cheap and needs no second store.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE leagues (
      id         uuid PRIMARY KEY,
      week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
      tier       smallint NOT NULL CHECK (tier >= 1),
      band       smallint NOT NULL CHECK (band >= 0),
      cohort     smallint NOT NULL CHECK (cohort >= 1),
      closed_at  timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (week_start, tier, band, cohort)
    )
  `.execute(db);
  await sql`CREATE INDEX leagues_open_idx ON leagues (week_start) WHERE closed_at IS NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE league_members (
      league_id  uuid NOT NULL REFERENCES leagues (id) ON DELETE CASCADE,
      user_id    uuid NOT NULL REFERENCES users (id),
      week_start date NOT NULL,
      weekly_xp  integer NOT NULL DEFAULT 0 CHECK (weekly_xp >= 0),
      joined_at  timestamptz NOT NULL DEFAULT now(),
      final_rank smallint CHECK (final_rank >= 1),
      outcome    text CHECK (outcome IN ('promoted', 'stayed', 'demoted')),
      PRIMARY KEY (league_id, user_id),
      UNIQUE (user_id, week_start)
    )
  `.execute(db);

  await sql`
    ALTER TABLE user_stats
      ADD COLUMN league_tier smallint NOT NULL DEFAULT 1 CHECK (league_tier >= 1)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE user_stats DROP COLUMN league_tier`.execute(db);
  await sql`DROP TABLE league_members`.execute(db);
  await sql`DROP TABLE leagues`.execute(db);
}
