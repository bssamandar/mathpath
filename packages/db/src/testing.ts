import { type Dialect, Kysely } from 'kysely';
import { migrateToLatest } from './migrator';
import type { Database } from './schema';

/**
 * Creates a fresh, migrated, in-memory PostgreSQL database for tests.
 *
 * PGlite is real PostgreSQL compiled to WebAssembly, so constraints, triggers
 * and SQL behave as in production, without Docker. Each call is isolated.
 *
 * @returns A typed database handle; call `destroy()` after the test.
 */
export async function createTestDb(): Promise<Kysely<Database>> {
  // Loaded lazily: PGlite is a dev dependency and must never load in production.
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGliteDialect } = await import('kysely-pglite-dialect');
  const db = new Kysely<Database>({ dialect: pgliteDialect(new PGliteDialect(new PGlite())) });
  await migrateToLatest(db as Kysely<unknown>);
  return db;
}

/**
 * The dialect package ships separate CommonJS and ES module type declarations;
 * a dynamic import resolves the ES ones, which TypeScript treats as a different
 * Kysely class. Both are the same class at runtime, so the cast is safe.
 */
export function pgliteDialect(dialect: unknown): Dialect {
  return dialect as Dialect;
}
