/**
 * Migration 2026111502: record which terms and privacy policy version a user accepted.
 *
 * Why on `users` and not a separate table: an adult accepts the terms once at
 * sign-up and again only when the version changes, so the latest acceptance is
 * enough evidence for the personal data law. Parental consent for children,
 * which needs scopes and a history, has its own `consents` table.
 */
import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE users
      ADD COLUMN terms_version     text CHECK (length(terms_version) BETWEEN 1 AND 32),
      ADD COLUMN terms_accepted_at timestamptz,
      ADD CONSTRAINT users_terms_pair_ck
        CHECK ((terms_version IS NULL) = (terms_accepted_at IS NULL))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE users
      DROP CONSTRAINT users_terms_pair_ck,
      DROP COLUMN terms_accepted_at,
      DROP COLUMN terms_version
  `.execute(db);
}
