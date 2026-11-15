/**
 * Password rules and hashing (security plan C-01, C-02).
 */
import { hash, verify } from '@node-rs/argon2';
import type { AppConfig } from '@mathpath/config';
import { ProblemException } from '../common/problem';
import type { BreachedPasswordChecker } from './breached-passwords';
import { commonPasswords } from './common-passwords';

/** Result of checking a password against a stored hash. */
export interface PasswordCheck {
  ok: boolean;
  /** True when the hash uses older Argon2 parameters and should be replaced. */
  needsRehash: boolean;
}

export class PasswordService {
  /**
   * A hash of a random password, verified when the account does not exist, so
   * "unknown phone" and "wrong password" take the same time (anti-enumeration).
   */
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly rules: AppConfig['auth']['password'],
    private readonly breached: BreachedPasswordChecker,
  ) {}

  /**
   * Checks a new password against the rules. Composition rules (a digit, a
   * symbol) are deliberately absent: NIST 800-63B found they make passwords
   * harder to remember without making them harder to guess.
   *
   * @param password - The proposed password.
   * @param context - Personal values the password must not equal.
   * @throws ProblemException 422 with a code the UI translates.
   */
  async assertAcceptable(password: string, context: { phone: string }): Promise<void> {
    const reject = (code: string, title: string): never => {
      throw new ProblemException(422, code, title, {
        errors: [{ field: 'password', message: title }],
      });
    };
    // Length is counted in characters people type, not UTF-16 units.
    const length = [...password].length;
    if (length < this.rules.minLength) {
      reject('PASSWORD_TOO_SHORT', `Use at least ${this.rules.minLength} characters.`);
    }
    if (length > this.rules.maxLength) {
      reject('PASSWORD_TOO_LONG', `Use at most ${this.rules.maxLength} characters.`);
    }
    const lower = password.toLowerCase();
    const phoneDigits = context.phone.replace(/\D/g, '');
    const phoneForms = [context.phone, phoneDigits, phoneDigits.slice(-9)];
    if (commonPasswords.has(lower) || phoneForms.includes(lower)) {
      reject('PASSWORD_TOO_COMMON', 'This password is too easy to guess.');
    }
    if (await this.breached.isBreached(password)) {
      reject('PASSWORD_BREACHED', 'This password appeared in a data breach. Choose another one.');
    }
  }

  /** Hashes a password with Argon2id and the configured parameters. */
  async hash(password: string): Promise<string> {
    const { memoryKiB, timeCost, parallelism } = this.rules.argon2;
    // Algorithm defaults to Argon2id in @node-rs/argon2.
    return hash(password, { memoryCost: memoryKiB, timeCost, parallelism });
  }

  /**
   * Verifies a password. With a null hash (no such account) it still spends
   * the time of one verification and returns false.
   */
  async verify(storedHash: string | null, password: string): Promise<PasswordCheck> {
    if (!storedHash) {
      this.dummyHash ??= this.hash(`dummy-${Math.random()}`);
      await verify(await this.dummyHash, password).catch(() => false);
      return { ok: false, needsRehash: false };
    }
    const ok = await verify(storedHash, password).catch(() => false);
    return { ok, needsRehash: ok && this.needsRehash(storedHash) };
  }

  /** True when a PHC string (`$argon2id$v=19$m=…,t=…,p=…$…`) uses other parameters. */
  needsRehash(storedHash: string): boolean {
    const { memoryKiB, timeCost, parallelism } = this.rules.argon2;
    const params = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
    return (
      !params ||
      Number(params[1]) !== memoryKiB ||
      Number(params[2]) !== timeCost ||
      Number(params[3]) !== parallelism
    );
  }
}
