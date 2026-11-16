import { type Kysely, type Migration, type MigrationResultSet, Migrator } from 'kysely';
import * as m2026111501 from './migrations/2026111501_identity';
import * as m2026111502 from './migrations/2026111502_terms_acceptance';
import * as m2026111601 from './migrations/2026111601_content';
import * as m2026111602 from './migrations/2026111602_media';
import * as m2026111603 from './migrations/2026111603_questions';
import * as m2026111701 from './migrations/2026111701_assessment';
import * as m2026111702 from './migrations/2026111702_learning';

/**
 * The ordered list of migrations. Names sort chronologically; each module
 * exports `up` and `down`. Add new migrations at the end of this list.
 *
 * A static list (instead of reading a folder at runtime) works the same in
 * tests, bundles and the production image.
 */
export const migrations: Record<string, Migration> = {
  '2026111501_identity': m2026111501,
  '2026111502_terms_acceptance': m2026111502,
  '2026111601_content': m2026111601,
  '2026111602_media': m2026111602,
  '2026111603_questions': m2026111603,
  '2026111701_assessment': m2026111701,
  '2026111702_learning': m2026111702,
};

function migratorFor(db: Kysely<unknown>, list: Record<string, Migration>): Migrator {
  return new Migrator({ db, provider: { getMigrations: async () => list } });
}

/** Thrown when a migration fails; carries the per-migration results. */
export class MigrationError extends Error {
  constructor(
    message: string,
    readonly results: MigrationResultSet['results'],
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

function unwrap(set: MigrationResultSet): string[] {
  if (set.error) {
    throw new MigrationError(`Migration failed: ${String(set.error)}`, set.results);
  }
  return (set.results ?? []).map((r) => `${r.direction} ${r.migrationName}`);
}

/**
 * Applies every pending migration.
 * @param list - Migrations to apply; defaults to the project's list (overridable in tests).
 * @returns Descriptions of the migrations that ran, for logging.
 * @throws MigrationError if any migration fails (the failing one is rolled back).
 */
export async function migrateToLatest(
  db: Kysely<unknown>,
  list: Record<string, Migration> = migrations,
): Promise<string[]> {
  return unwrap(await migratorFor(db, list).migrateToLatest());
}

/**
 * Reverts the most recent migration.
 * @returns Description of the migration that was reverted (empty if none).
 * @throws MigrationError if its `down` fails.
 */
export async function migrateDown(
  db: Kysely<unknown>,
  list: Record<string, Migration> = migrations,
): Promise<string[]> {
  return unwrap(await migratorFor(db, list).migrateDown());
}

/**
 * Reverts every migration (used by the CI up → down → up check).
 * @throws MigrationError if any `down` fails.
 */
export async function migrateToNothing(
  db: Kysely<unknown>,
  list: Record<string, Migration> = migrations,
): Promise<string[]> {
  const { NO_MIGRATIONS } = await import('kysely');
  return unwrap(await migratorFor(db, list).migrateTo(NO_MIGRATIONS));
}
