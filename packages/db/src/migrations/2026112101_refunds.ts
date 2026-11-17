import { type Kysely, sql } from 'kysely';

/**
 * Refunds (step 7.4; ADR-0008; security plan C-28, C-33).
 *
 * One row per refund: who asked, why, and what the provider said. Click
 * refunds are reversed through Click's Merchant API at once; Payme's Merchant
 * API cannot start a refund, so a Payme refund stays `requested` until the
 * transaction is cancelled in the Payme cabinet and Payme calls
 * CancelTransaction. A refund Payme starts on its own side (a cabinet cancel
 * without a request here) is recorded with no `requested_by`.
 *
 * The providers refund whole payments only, so at most one live refund
 * (requested or succeeded) exists per payment; a failed one can be retried.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE refunds (
      id            uuid PRIMARY KEY,
      payment_id    uuid NOT NULL REFERENCES payments (id),
      amount_tiyin  bigint NOT NULL CHECK (amount_tiyin > 0),
      status        text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested', 'succeeded', 'failed')),
      reason        text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
      requested_by  uuid NULL REFERENCES users (id),
      idempotency_key uuid NULL UNIQUE,
      provider_ref  text NULL,
      failure       text NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      completed_at  timestamptz NULL,
      CHECK ((status = 'requested') = (completed_at IS NULL)),
      CHECK ((status = 'failed') = (failure IS NOT NULL))
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX refunds_one_live_uq ON refunds (payment_id)
            WHERE status IN ('requested', 'succeeded')`.execute(db);
  await sql`CREATE INDEX refunds_payment_idx ON refunds (payment_id, created_at)`.execute(db);
  // The reconciliation job looks for Payme requests nobody finished.
  await sql`CREATE INDEX refunds_open_idx ON refunds (created_at) WHERE status = 'requested'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE refunds`.execute(db);
}
