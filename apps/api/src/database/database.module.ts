import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Database } from '@mathpath/db';
import type { Kysely } from 'kysely';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';

/** Injection token for the shared `Kysely<Database>` instance. */
export const DB = Symbol('DB');

/**
 * Provides one connection pool for the whole API.
 *
 * The pool connects lazily, so the process starts (and /health answers) even
 * while the database is briefly unavailable. Tests replace this provider with
 * an in-memory PGlite database.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ENV],
      useFactory: (env: Env): Kysely<Database> => createDb({ connectionString: env.DATABASE_URL }),
    },
  ],
  exports: [DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  /** Closes the pool so a rolling deploy does not leave connections behind. */
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
