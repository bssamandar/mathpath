import { type Kysely, sql } from 'kysely';

/**
 * Admin console (step 6.7b; security plan C-14, C-33).
 *
 * - `audit_log (actor_id, created_at)`: "what did this person do" is the
 *   first question in an investigation; the table already has indexes by time
 *   and by target.
 * - `risk_reviews (subject_user_id)`: the queue shows a person's earlier
 *   reviews, and the risk engine looks for an open one before opening another.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at)`.execute(db);
  await sql`CREATE INDEX risk_reviews_subject_idx ON risk_reviews (subject_user_id, created_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX risk_reviews_subject_idx`.execute(db);
  await sql`DROP INDEX audit_log_actor_idx`.execute(db);
}
