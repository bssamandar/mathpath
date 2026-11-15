/**
 * Migration command line: `pnpm --filter @mathpath/db migrate <latest|down>`.
 * Reads DATABASE_URL. Production deploys run `latest` as a separate step
 * before new code starts (docs/database-schema.md §6).
 */
import type { Kysely } from 'kysely';
import { createDb } from './client';
import { migrateDown, migrateToLatest } from './migrator';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'latest';
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const db = createDb({ connectionString, maxConnections: 1 }) as unknown as Kysely<unknown>;
  try {
    const ran = command === 'down' ? await migrateDown(db) : await migrateToLatest(db);
    console.warn(ran.length ? ran.join('\n') : 'Nothing to migrate.');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
