/**
 * Sliding-window rate limits (config/limits.yaml, config/risk.yaml; C-04, C-20).
 *
 * Production uses {@link RedisRateLimiter} so that every API instance shares
 * the same counters. The in-memory implementation serves tests and local
 * development without Redis.
 */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Clock } from './clock';

/** A limit: at most `limit` events per `windowMs` milliseconds. */
export interface RateWindow {
  limit: number;
  windowMs: number;
}

/** Outcome of a rate-limit check. */
export interface RateResult {
  /** True while the key is within its limit. */
  allowed: boolean;
  /** Seconds until one more event is allowed; 0 when allowed. */
  retryAfterS: number;
}

export abstract class RateLimiter {
  /**
   * Records one event for `key` if it is within the limit.
   * @returns Whether the event was allowed; a refused event is not recorded.
   */
  abstract consume(key: string, window: RateWindow): Promise<RateResult>;

  /** Checks the limit without recording an event (used before counting failures). */
  abstract check(key: string, window: RateWindow): Promise<RateResult>;

  /**
   * Records an event even when over the limit (failures always count).
   * @returns The number of events in the window, including this one.
   */
  abstract record(key: string, window: RateWindow): Promise<number>;

  /** @returns The number of events in the last `windowMs` milliseconds. */
  abstract count(key: string, windowMs: number): Promise<number>;
}

/** Converts a `{ limit, windowMinutes }` value from the YAML config. */
export function perMinutes(w: { limit: number; windowMinutes: number }): RateWindow {
  return { limit: w.limit, windowMs: w.windowMinutes * 60_000 };
}

/**
 * Exact sliding-log limiter kept in process memory.
 *
 * Not suitable for more than one API instance: each would count separately.
 */
export class MemoryRateLimiter extends RateLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {
    super();
  }

  async consume(key: string, window: RateWindow): Promise<RateResult> {
    const result = this.evaluate(key, window);
    if (result.allowed) this.recent(key, window.windowMs).push(this.clock.now().getTime());
    return Promise.resolve(result);
  }

  async check(key: string, window: RateWindow): Promise<RateResult> {
    return Promise.resolve(this.evaluate(key, window));
  }

  async record(key: string, window: RateWindow): Promise<number> {
    const events = this.recent(key, window.windowMs);
    events.push(this.clock.now().getTime());
    return Promise.resolve(events.length);
  }

  async count(key: string, windowMs: number): Promise<number> {
    return Promise.resolve(this.recent(key, windowMs).length);
  }

  /** Drops events older than the window and returns the live list. */
  private recent(key: string, windowMs: number): number[] {
    const now = this.clock.now().getTime();
    const recent = (this.events.get(key) ?? []).filter((t) => t > now - windowMs);
    this.events.set(key, recent);
    return recent;
  }

  private evaluate(key: string, { limit, windowMs }: RateWindow): RateResult {
    const recent = this.recent(key, windowMs);
    if (recent.length < limit) return { allowed: true, retryAfterS: 0 };
    // The oldest event that still counts decides when a slot frees up.
    const oldest = recent[recent.length - limit]!;
    const now = this.clock.now().getTime();
    return { allowed: false, retryAfterS: Math.ceil((oldest + windowMs - now) / 1000) };
  }
}

/**
 * The same sliding log in Redis: one sorted set per key, scored by time.
 *
 * Each operation is one Lua script, so "check then add" is atomic even when
 * many API instances hit the same key at once. Keys expire with their window,
 * so idle keys cost no memory.
 *
 * Time comes from the API's clock, not Redis, so tests can move it; the small
 * clock differences between instances do not matter at minute-long windows.
 */
export class RedisRateLimiter extends RateLimiter {
  // KEYS[1] = key; ARGV = now, windowMs, limit, member, add (1 or 0)
  private static readonly SCRIPT = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
    local count = redis.call('ZCARD', key)
    if count < limit then
      if ARGV[5] == '1' then
        redis.call('ZADD', key, now, ARGV[4])
        redis.call('PEXPIRE', key, window)
      end
      return {1, 0}
    end
    local oldest = redis.call('ZRANGE', key, count - limit, count - limit, 'WITHSCORES')
    return {0, tonumber(oldest[2]) + window - now}
  `;

  // KEYS[1] = key; ARGV = now, windowMs, member
  private static readonly RECORD = `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return redis.call('ZCARD', KEYS[1])
  `;

  constructor(
    private readonly redis: Redis,
    private readonly clock: Clock,
    private readonly prefix = 'rl:',
  ) {
    super();
  }

  async consume(key: string, window: RateWindow): Promise<RateResult> {
    return this.run(key, window, true);
  }

  async check(key: string, window: RateWindow): Promise<RateResult> {
    return this.run(key, window, false);
  }

  async record(key: string, { windowMs }: RateWindow): Promise<number> {
    const now = this.clock.now().getTime();
    const count = await this.redis.eval(
      RedisRateLimiter.RECORD,
      1,
      this.prefix + key,
      now,
      windowMs,
      this.member(now),
    );
    return Number(count);
  }

  async count(key: string, windowMs: number): Promise<number> {
    const now = this.clock.now().getTime();
    return this.redis.zcount(this.prefix + key, `(${now - windowMs}`, '+inf');
  }

  private async run(
    key: string,
    { limit, windowMs }: RateWindow,
    add: boolean,
  ): Promise<RateResult> {
    const now = this.clock.now().getTime();
    const [allowed, waitMs] = (await this.redis.eval(
      RedisRateLimiter.SCRIPT,
      1,
      this.prefix + key,
      now,
      windowMs,
      limit,
      this.member(now),
      add ? '1' : '0',
    )) as [number, number];
    return allowed === 1
      ? { allowed: true, retryAfterS: 0 }
      : { allowed: false, retryAfterS: Math.ceil(Number(waitMs) / 1000) };
  }

  /** Unique per event, so two events in the same millisecond both count. */
  private member(now: number): string {
    return `${now}:${randomBytes(6).toString('hex')}`;
  }
}
