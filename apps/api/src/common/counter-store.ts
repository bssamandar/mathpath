/**
 * Expiring counters, for budgets such as SMS spend per hour and per day (C-20).
 */
import type { Redis } from 'ioredis';
import type { Clock } from './clock';

export abstract class CounterStore {
  /**
   * Adds `amount` to a counter, creating it with a lifetime of `ttlMs`.
   * @returns The new total.
   */
  abstract add(key: string, amount: number, ttlMs: number): Promise<number>;
  /** @returns The current total, or 0. */
  abstract get(key: string): Promise<number>;
}

/** In-process counters for tests and local development. */
export class MemoryCounterStore extends CounterStore {
  private readonly values = new Map<string, { total: number; expiresAt: number }>();

  constructor(private readonly clock: Clock) {
    super();
  }

  async add(key: string, amount: number, ttlMs: number): Promise<number> {
    const now = this.clock.now().getTime();
    const current = this.live(key, now);
    const total = (current?.total ?? 0) + amount;
    this.values.set(key, { total, expiresAt: current?.expiresAt ?? now + ttlMs });
    return Promise.resolve(total);
  }

  async get(key: string): Promise<number> {
    return Promise.resolve(this.live(key, this.clock.now().getTime())?.total ?? 0);
  }

  private live(key: string, now: number) {
    const entry = this.values.get(key);
    if (entry && entry.expiresAt <= now) {
      this.values.delete(key);
      return undefined;
    }
    return entry;
  }
}

/** Shared counters in Redis (INCRBY with an expiry set on creation). */
export class RedisCounterStore extends CounterStore {
  private static readonly ADD = `
    local total = redis.call('INCRBY', KEYS[1], ARGV[1])
    if total == tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
    return total
  `;

  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'ctr:',
  ) {
    super();
  }

  async add(key: string, amount: number, ttlMs: number): Promise<number> {
    return Number(
      await this.redis.eval(RedisCounterStore.ADD, 1, this.prefix + key, amount, ttlMs),
    );
  }

  async get(key: string): Promise<number> {
    return Number((await this.redis.get(this.prefix + key)) ?? 0);
  }
}
