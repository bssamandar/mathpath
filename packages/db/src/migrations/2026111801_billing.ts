import { type Kysely, sql } from 'kysely';

/**
 * Billing core (schema doc §3.10; architecture §5.5; ADR-0008).
 *
 * - `orders`: one intended purchase, with the plan price snapshotted in
 *   tiyin and the children it will cover. Its ID is the account Payme and
 *   Click send back.
 * - `payments`: one provider transaction for an order. `(provider,
 *   provider_txn_id)` is unique, so a repeated callback can never create a
 *   second payment, and at most one payment per order is pending or paid.
 *   A trigger allows only forward status changes.
 * - `subscriptions` and `subscription_members`: what a paid order grants,
 *   and to which children.
 * - `payment_callbacks`: every provider call with our answer, for audit,
 *   support and reconciliation.
 *
 * Saved cards, refunds by admins, promo codes, trials and referrals come in
 * later migrations with their features.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE orders (
      id              uuid PRIMARY KEY,
      owner_id        uuid NOT NULL REFERENCES users (id),
      plan_code       text NOT NULL,
      plan_interval   text NOT NULL CHECK (plan_interval IN ('month','year')),
      student_ids     uuid[] NOT NULL CHECK (cardinality(student_ids) >= 1),
      amount_tiyin    bigint NOT NULL CHECK (amount_tiyin > 0),
      discount_tiyin  bigint NOT NULL DEFAULT 0 CHECK (discount_tiyin >= 0),
      provider        text NOT NULL CHECK (provider IN ('payme','click')),
      status          text NOT NULL DEFAULT 'created'
                      CHECK (status IN ('created','pending','paid','cancelled','expired')),
      idempotency_key text NOT NULL,
      return_url      text,
      expires_at      timestamptz NOT NULL,
      paid_at         timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_id, idempotency_key),
      CHECK ((status = 'paid') = (paid_at IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX orders_owner_idx ON orders (owner_id, created_at)`.execute(db);

  await sql`
    CREATE TABLE subscriptions (
      id                   uuid PRIMARY KEY,
      owner_id             uuid NOT NULL REFERENCES users (id),
      order_id             uuid REFERENCES orders (id),
      plan_code            text NOT NULL,
      status               text NOT NULL
                           CHECK (status IN ('trialing','active','past_due','cancelled','expired')),
      seats                smallint NOT NULL CHECK (seats >= 1),
      price_tiyin          bigint NOT NULL CHECK (price_tiyin >= 0),
      current_period_start timestamptz NOT NULL,
      current_period_end   timestamptz NOT NULL,
      cancel_at_period_end boolean NOT NULL DEFAULT false,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CHECK (current_period_end > current_period_start)
    )
  `.execute(db);
  await sql`CREATE INDEX subscriptions_owner_idx ON subscriptions (owner_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX subscriptions_order_key ON subscriptions (order_id)
            WHERE order_id IS NOT NULL`.execute(db);

  await sql`
    CREATE TABLE subscription_members (
      subscription_id uuid NOT NULL REFERENCES subscriptions (id),
      student_id      uuid NOT NULL REFERENCES users (id),
      PRIMARY KEY (subscription_id, student_id)
    )
  `.execute(db);
  await sql`CREATE INDEX subscription_members_student_idx ON subscription_members (student_id)`.execute(
    db,
  );

  await sql`
    CREATE TABLE payments (
      id                  uuid PRIMARY KEY,
      order_id            uuid NOT NULL REFERENCES orders (id),
      subscription_id     uuid REFERENCES subscriptions (id),
      provider            text NOT NULL CHECK (provider IN ('payme','click')),
      provider_txn_id     text NOT NULL CHECK (length(provider_txn_id) BETWEEN 1 AND 64),
      amount_tiyin        bigint NOT NULL CHECK (amount_tiyin > 0),
      status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','paid','cancelled','refunded','partially_refunded','failed')),
      provider_created_at timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      paid_at             timestamptz,
      cancelled_at        timestamptz,
      cancel_reason       smallint,
      fiscal_receipt      jsonb,
      UNIQUE (provider, provider_txn_id),
      CHECK ((status = 'paid') <= (paid_at IS NOT NULL)),
      CHECK ((status IN ('cancelled','refunded')) = (cancelled_at IS NOT NULL))
    )
  `.execute(db);
  // One live payment per order: a second transaction for the same order is refused.
  await sql`CREATE UNIQUE INDEX payments_one_live_per_order ON payments (order_id)
            WHERE status IN ('pending','paid')`.execute(db);
  await sql`CREATE INDEX payments_statement_idx ON payments (provider, created_at)`.execute(db);

  // Forward-only payment states (ADR-0008): a paid payment never goes back to
  // pending, and a cancelled or refunded one never comes back to life.
  await sql`
    CREATE FUNCTION payments_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = OLD.status THEN RETURN NEW; END IF;
      IF (OLD.status = 'pending' AND NEW.status IN ('paid','cancelled','failed'))
         OR (OLD.status = 'paid' AND NEW.status IN ('refunded','partially_refunded'))
         OR (OLD.status = 'partially_refunded' AND NEW.status = 'refunded') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'payment status cannot go from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END $$;
  `.execute(db);
  await sql`CREATE TRIGGER payments_forward_only BEFORE UPDATE OF status ON payments
            FOR EACH ROW EXECUTE FUNCTION payments_forward_only()`.execute(db);

  await sql`
    CREATE TABLE payment_callbacks (
      id          uuid PRIMARY KEY,
      provider    text NOT NULL,
      method      text NOT NULL,
      external_id text,
      auth_valid  boolean NOT NULL,
      payload     jsonb NOT NULL,
      response    jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX payment_callbacks_lookup_idx
            ON payment_callbacks (provider, external_id, received_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE payment_callbacks`.execute(db);
  await sql`DROP TRIGGER payments_forward_only ON payments`.execute(db);
  await sql`DROP FUNCTION payments_forward_only()`.execute(db);
  await sql`DROP TABLE payments`.execute(db);
  await sql`DROP TABLE subscription_members`.execute(db);
  await sql`DROP TABLE subscriptions`.execute(db);
  await sql`DROP TABLE orders`.execute(db);
}
