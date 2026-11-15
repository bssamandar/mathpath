/**
 * Sliding-window rate limits (config/limits.yaml, config/risk.yaml; C-04, C-20).
 *
 * The interface lets the in-memory implementation below serve tests and a
 * single local instance, while production uses Redis so that every API
 * instance shares the same counters (added with the risk module).
 */
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

  /** Records an event even when over the limit (failures always count). */
  abstract record(key: string, window: RateWindow): Promise<void>;
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
    if (result.allowed) this.events.get(key)!.push(this.clock.now().getTime());
    return Promise.resolve(result);
  }

  async check(key: string, window: RateWindow): Promise<RateResult> {
    return Promise.resolve(this.evaluate(key, window));
  }

  async record(key: string, window: RateWindow): Promise<void> {
    this.evaluate(key, window);
    this.events.get(key)!.push(this.clock.now().getTime());
    return Promise.resolve();
  }

  private evaluate(key: string, { limit, windowMs }: RateWindow): RateResult {
    const now = this.clock.now().getTime();
    const recent = (this.events.get(key) ?? []).filter((t) => t > now - windowMs);
    this.events.set(key, recent);
    if (recent.length < limit) return { allowed: true, retryAfterS: 0 };
    // The oldest event that still counts decides when a slot frees up.
    const oldest = recent[recent.length - limit]!;
    return { allowed: false, retryAfterS: Math.ceil((oldest + windowMs - now) / 1000) };
  }
}
