/**
 * Tests of the Redis implementations against a real Redis server, because
 * the Lua scripts are the part most likely to be wrong. Locally:
 * `pnpm services:up` (or any Redis on localhost:6379); CI runs a Redis service.
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisRevokedSessions } from '../identity/revoked-sessions';
import { Clock } from './clock';
import { RedisCounterStore } from './counter-store';
import { RedisRateLimiter } from './rate-limiter';

class StepClock extends Clock {
  time = Date.parse('2026-11-15T10:00:00Z');
  now(): Date {
    return new Date(this.time);
  }
}

const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
let redis: Redis;
// A fresh namespace per run, so tests never see each other's keys.
const ns = `test:${randomUUID()}:`;

beforeAll(() => {
  redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false });
});

afterAll(async () => {
  const keys = await redis.keys(`${ns}*`);
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});

describe('RedisRateLimiter', () => {
  it('allows up to the limit, then reports when a slot frees up', async () => {
    const clock = new StepClock();
    const limiter = new RedisRateLimiter(redis, clock, ns);
    const window = { limit: 2, windowMs: 60_000 };
    expect((await limiter.consume('a', window)).allowed).toBe(true);
    clock.time += 10_000;
    expect((await limiter.consume('a', window)).allowed).toBe(true);
    expect(await limiter.consume('a', window)).toEqual({ allowed: false, retryAfterS: 50 });
    expect(await limiter.check('a', window)).toEqual({ allowed: false, retryAfterS: 50 });

    clock.time += 50_001;
    expect((await limiter.consume('a', window)).allowed).toBe(true);
  });

  it('records failures beyond the limit and counts them', async () => {
    const clock = new StepClock();
    const limiter = new RedisRateLimiter(redis, clock, ns);
    const window = { limit: 1, windowMs: 60_000 };
    expect(await limiter.record('b', window)).toBe(1);
    expect(await limiter.record('b', window)).toBe(2);
    expect(await limiter.count('b', 60_000)).toBe(2);
    clock.time += 61_000;
    expect(await limiter.count('b', 60_000)).toBe(0);
  });

  it('expires idle keys with their window', async () => {
    const limiter = new RedisRateLimiter(redis, new StepClock(), ns);
    await limiter.consume('c', { limit: 5, windowMs: 60_000 });
    const ttl = await redis.pttl(`${ns}c`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('never lets concurrent requests exceed the limit', async () => {
    const limiter = new RedisRateLimiter(redis, new StepClock(), ns);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume('d', { limit: 5, windowMs: 60_000 })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });
});

describe('RedisCounterStore', () => {
  it('adds up and expires with the first write', async () => {
    const counters = new RedisCounterStore(redis, ns);
    expect(await counters.add('sms', 100, 1000)).toBe(100);
    expect(await counters.add('sms', 50, 999_999)).toBe(150);
    expect(await counters.get('sms')).toBe(150);
    expect(await redis.pttl(`${ns}sms`)).toBeLessThanOrEqual(1000);
    expect(await counters.get('missing')).toBe(0);
  });
});

describe('RedisRevokedSessions', () => {
  it('remembers a revoked session until its TTL', async () => {
    const revoked = new RedisRevokedSessions(redis, ns);
    await revoked.add('s1', 60_000);
    expect(await revoked.has('s1')).toBe(true);
    expect(await revoked.has('s2')).toBe(false);
  });
});
