import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './schema';

/** Options for {@link createDb}. */
export interface CreateDbOptions {
  /** PostgreSQL connection string, e.g. from the DATABASE_URL environment variable. */
  connectionString: string;
  /** Maximum pooled connections per process (PgBouncer sits in front in production). */
  maxConnections?: number;
}

/**
 * Creates a Kysely instance backed by a pg connection pool.
 *
 * @returns A typed database handle; call `destroy()` on shutdown.
 */
export function createDb({
  connectionString,
  maxConnections = 10,
}: CreateDbOptions): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: maxConnections }) }),
  });
}
