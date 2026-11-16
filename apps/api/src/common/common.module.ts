import { Global, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { Clock, SystemClock } from './clock';
import { CounterStore, MemoryCounterStore, RedisCounterStore } from './counter-store';
import { MemoryRateLimiter, RateLimiter, RedisRateLimiter } from './rate-limiter';

/**
 * Shared infrastructure for every module: the clock, rate limiter and
 * counters. Redis-backed when Redis is configured, in memory otherwise.
 */
@Global()
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    {
      provide: RateLimiter,
      inject: [REDIS, Clock],
      useFactory: (redis: Redis | null, clock: Clock) =>
        redis ? new RedisRateLimiter(redis, clock) : new MemoryRateLimiter(clock),
    },
    {
      provide: CounterStore,
      inject: [REDIS, Clock],
      useFactory: (redis: Redis | null, clock: Clock) =>
        redis ? new RedisCounterStore(redis) : new MemoryCounterStore(clock),
    },
  ],
  exports: [Clock, RateLimiter, CounterStore],
})
export class CommonModule {}
