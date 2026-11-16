import { type Kysely, sql } from 'kysely';

/**
 * Click (step 6.5b) identifies our side of a payment with an integer
 * (`merchant_prepare_id`, `merchant_confirm_id`), while payment IDs are
 * UUIDs. `merchant_ref` gives every payment a unique number from a sequence,
 * so the adapter can hand Click an integer without a second ID table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE payments ADD COLUMN merchant_ref bigint GENERATED ALWAYS AS IDENTITY`.execute(
    db,
  );
  await sql`ALTER TABLE payments ADD CONSTRAINT payments_merchant_ref_key UNIQUE (merchant_ref)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE payments DROP COLUMN merchant_ref`.execute(db);
}
