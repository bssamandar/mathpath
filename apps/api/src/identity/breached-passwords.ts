/**
 * Breached-password check (security plan C-02).
 *
 * Uses the Have I Been Pwned range API with k-anonymity: only the first five
 * hex characters of the password's SHA-1 leave the server, and the service
 * returns every suffix with that prefix, so it never learns which password we
 * checked. Padding hides the real number of matches from network observers.
 *
 * Alternative considered: shipping a local copy of the breach corpus. It is
 * tens of gigabytes and needs regular updates, which is too heavy for the MVP.
 */
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';

export abstract class BreachedPasswordChecker {
  /** @returns True when the password is known from a data breach. */
  abstract isBreached(password: string): Promise<boolean>;
}

/** Used when the check is turned off (tests, offline development). */
export class DisabledBreachedPasswordChecker extends BreachedPasswordChecker {
  async isBreached(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

export class HibpBreachedPasswordChecker extends BreachedPasswordChecker {
  private readonly logger = new Logger('BreachedPasswords');

  /**
   * @param fetchFn - Injected for tests; defaults to the global fetch.
   * @param timeoutMs - Sign-up must not hang on a slow third party.
   */
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 2000,
  ) {
    super();
  }

  /**
   * Fails open: if the service is down, the password is accepted and the
   * problem is logged, so an outage elsewhere never blocks sign-up (C-02).
   */
  async isBreached(password: string): Promise<boolean> {
    const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    try {
      const response = await this.fetchFn(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'MathPath-API' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      // Each line is "SUFFIX:COUNT"; padding lines have a count of 0.
      return body.split('\n').some((line) => {
        const [candidate, count] = line.trim().split(':');
        return candidate === suffix && Number(count) > 0;
      });
    } catch (error) {
      this.logger.warn(`Breached-password check skipped: ${(error as Error).message}`);
      return false;
    }
  }
}
