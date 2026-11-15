/**
 * Sessions revoked before their access token expired (ADR-0005).
 *
 * Access tokens are checked without a database lookup, so a signed-out or
 * stolen session would otherwise keep working for up to 15 minutes. Entries
 * live only as long as the longest access token. Production uses Redis so all
 * instances see the same list (added with the risk module).
 */
import type { Clock } from '../common/clock';

export abstract class RevokedSessions {
  /** Marks a session as revoked for `ttlMs` milliseconds. */
  abstract add(sessionId: string, ttlMs: number): Promise<void>;
  /** @returns True when the session was revoked. */
  abstract has(sessionId: string): Promise<boolean>;
}

/** In-process implementation for tests and a single local instance. */
export class MemoryRevokedSessions extends RevokedSessions {
  private readonly entries = new Map<string, number>();

  constructor(private readonly clock: Clock) {
    super();
  }

  async add(sessionId: string, ttlMs: number): Promise<void> {
    this.entries.set(sessionId, this.clock.now().getTime() + ttlMs);
    return Promise.resolve();
  }

  async has(sessionId: string): Promise<boolean> {
    const until = this.entries.get(sessionId);
    if (until === undefined) return Promise.resolve(false);
    if (until <= this.clock.now().getTime()) {
      this.entries.delete(sessionId);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }
}
