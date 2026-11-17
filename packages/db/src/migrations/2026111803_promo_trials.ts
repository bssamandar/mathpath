import { type Kysely, sql } from 'kysely';

/**
 * Promo codes and free trials (schema doc §3.10; step 6.5c).
 *
 * - `promo_codes`: codes are stored upper-case and unique; a percent discount
 *   is at most 100 and the validity window must be non-empty.
 * - `promo_redemptions`: one row per paid order that used a code, written when
 *   the order is paid, so unpaid orders never use up a code.
 * - `orders.promo_code_id`: the code applied at checkout.
 * - `trials`: one per account (`owner_id` unique) and, when the app sends a
 *   device token, one per device (`device_hash` unique).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE promo_codes (
      id              uuid PRIMARY KEY,
      code            text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{4,32}$'),
      discount_type   text NOT NULL CHECK (discount_type IN ('percent','fixed')),
      value           bigint NOT NULL CHECK (value > 0),
      plan_codes      text[],
      max_redemptions integer CHECK (max_redemptions > 0),
      per_user_limit  integer NOT NULL DEFAULT 1 CHECK (per_user_limit > 0),
      valid_from      timestamptz NOT NULL,
      valid_to        timestamptz NOT NULL,
      is_active       boolean NOT NULL DEFAULT true,
      created_by      uuid NOT NULL REFERENCES users (id),
      created_at      timestamptz NOT NULL DEFAULT now(),
      CHECK (discount_type <> 'percent' OR value <= 100),
      CHECK (valid_to > valid_from)
    )
  `.execute(db);

  await sql`ALTER TABLE orders ADD COLUMN promo_code_id uuid REFERENCES promo_codes (id)`.execute(
    db,
  );

  await sql`
    CREATE TABLE promo_redemptions (
      promo_code_id uuid NOT NULL REFERENCES promo_codes (id),
      order_id      uuid NOT NULL REFERENCES orders (id),
      owner_id      uuid NOT NULL REFERENCES users (id),
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (promo_code_id, order_id)
    )
  `.execute(db);
  await sql`CREATE INDEX promo_redemptions_owner_idx ON promo_redemptions (promo_code_id, owner_id)`.execute(
    db,
  );

  await sql`
    CREATE TABLE trials (
      id              uuid PRIMARY KEY,
      owner_id        uuid NOT NULL UNIQUE REFERENCES users (id),
      device_hash     text UNIQUE,
      subscription_id uuid NOT NULL REFERENCES subscriptions (id),
      started_at      timestamptz NOT NULL,
      ends_at         timestamptz NOT NULL,
      CHECK (ends_at > started_at)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE trials`.execute(db);
  await sql`DROP TABLE promo_redemptions`.execute(db);
  await sql`ALTER TABLE orders DROP COLUMN promo_code_id`.execute(db);
  await sql`DROP TABLE promo_codes`.execute(db);
}
