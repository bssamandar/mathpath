import { type Kysely, sql } from 'kysely';

/**
 * The Sunday-evening report SMS (step 7.4b; UX S11; security plan C-20).
 *
 * One row per parent and week, written before the message is sent: the
 * primary key makes a second run (a restart, a second worker) skip parents
 * who already have a row, so nobody gets the report twice. A failed send is
 * not retried that week, to keep a provider outage from turning into a storm.
 * The phone number is not stored here; the users table has it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE report_sms_log (
      parent_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      week_start  date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
      status      text NOT NULL DEFAULT 'sending'
                  CHECK (status IN ('sending', 'sent', 'failed')),
      children    smallint NOT NULL CHECK (children > 0),
      failure     text NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz NULL,
      PRIMARY KEY (parent_id, week_start),
      CHECK ((status = 'sending') = (finished_at IS NULL)),
      CHECK ((status = 'failed') = (failure IS NOT NULL))
    )`.execute(db);
  await sql`CREATE INDEX report_sms_log_week_idx ON report_sms_log (week_start, status)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE report_sms_log`.execute(db);
}
