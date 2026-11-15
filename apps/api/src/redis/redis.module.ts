import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';

/** Injection token for the shared Redis client, or null when REDIS_URL is not set. */
export const REDIS = Symbol('REDIS');

/**
 * One Redis connection for rate limits, revoked sessions and counters.
 *
 * Without REDIS_URL (local development, unit tests) the app falls back to
 * in-memory implementations; production refuses to start without it, because
 * per-instance limits would multiply by the number of instances.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env): Redis | null => {
        if (!env.REDIS_URL) {
          new Logger('Redis').warn(
            'REDIS_URL is not set: limits are kept in memory (development only).',
          );
          return null;
        }
        // Commands fail fast instead of queueing forever while Redis is down,
        // so a request gets an error rather than hanging.
        return new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true });
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis?.quit();
  }
}
