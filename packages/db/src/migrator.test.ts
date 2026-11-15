import { Kysely, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDb } from './client';
import { MigrationError, migrateToLatest } from './migrator';
import { pgliteDialect } from './testing';

describe('migrateToLatest error handling', () => {
  it('throws MigrationError with per-migration results when a migration fails', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { PGliteDialect } = await import('kysely-pglite-dialect');
    const db = new Kysely<unknown>({ dialect: pgliteDialect(new PGliteDialect(new PGlite())) });
    const broken = {
      '0001_ok': {
        up: async (k: Kysely<unknown>) => {
          await sql`CREATE TABLE ok_table (id int)`.execute(k);
        },
      },
      '0002_broken': {
        up: async (k: Kysely<unknown>) => {
          await sql`CREATE TABLE ok_table (id int)`.execute(k);
        },
      },
    };
    const error = await migrateToLatest(db, broken).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).results?.map((r) => r.status)).toEqual(['Success', 'Error']);
    await db.destroy();
  });
});

describe('createDb', () => {
  it('creates a handle without connecting until the first query', async () => {
    const db = createDb({ connectionString: 'postgres://user:pass@127.0.0.1:1/none' });
    expect(db).toBeInstanceOf(Kysely);
    await db.destroy();
  });
});
