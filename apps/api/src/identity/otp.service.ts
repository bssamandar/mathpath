/**
 * One-time codes sent by SMS (security plan C-03, C-20, C-21).
 *
 * Two goals pull in different directions here: tell honest users clearly what
 * happened, and tell attackers nothing. So the response to a code request is
 * identical whether or not the number has an account, and the SMS itself
 * (which only the phone's owner reads) carries the real message.
 */
import type { AppConfig } from '@mathpath/config';
import { type Database, newId } from '@mathpath/db';
import { Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import { perMinutes, type RateLimiter, type RateWindow } from '../common/rate-limiter';
import { randomDigits, safeEqual } from './crypto';
import type { AuthKeys } from './keys';
import { maskPhone, type SmsSender } from './sms/sms-sender';
import { smsMessages } from './sms/messages';
import type { RiskService } from '../risk/risk.service';
import type { SmsBudget } from '../risk/sms-budget';

/**
 * Purposes supported so far; password reset and phone change follow.
 * `confirm_action` lets a signed-in parent prove possession of their phone
 * for an important action, such as giving consent for a child (C-30).
 */
export type OtpRequestPurpose = 'signup' | 'login' | 'reset_password' | 'confirm_action';

export interface OtpRequest {
  phone: string;
  purpose: OtpRequestPurpose;
  ipPrefix: string | null;
  automationSuspected: boolean;
  captchaToken?: string | undefined;
}

export interface OtpChallengeInfo {
  challengeId: string;
  expiresInS: number;
  resendAfterS: number;
}

/** What a correct code proves. */
export interface VerifiedOtp {
  challengeId: string;
  phone: string;
  purpose: OtpRequestPurpose;
}

const DAY_MS = 86_400_000;

export class OtpService {
  private readonly logger = new Logger('OtpService');

  constructor(
    private readonly db: Kysely<Database>,
    private readonly sms: SmsSender,
    private readonly limiter: RateLimiter,
    private readonly keys: AuthKeys,
    private readonly clock: Clock,
    private readonly rules: AppConfig['risk']['otp'],
    private readonly resendAfterSeconds: number,
    private readonly risk: RiskService,
    private readonly budget: SmsBudget,
  ) {}

  /**
   * Creates a challenge and sends the SMS.
   * @throws ProblemException 400 for a country we do not serve, 428 when a
   *   CAPTCHA is needed, 403 when blocked, 429 when a limit is hit.
   */
  async request(input: OtpRequest): Promise<OtpChallengeInfo> {
    const { phone, purpose, ipPrefix } = input;
    // SMS pumping fraud targets expensive foreign numbers, so only the
    // countries we serve can receive codes at all (C-20).
    if (!this.rules.allowedCountryCodes.some((cc) => phone.startsWith(cc))) {
      throw new ProblemException(
        400,
        'PHONE_COUNTRY_NOT_SUPPORTED',
        'This phone number is not supported.',
        {
          errors: [{ field: 'phone', message: 'Only supported country codes can receive SMS.' }],
        },
      );
    }

    // Risk is scored before any limit is used up, so a request that only
    // lacks a CAPTCHA can be retried with one at no cost.
    await this.risk.enforce({
      kind: 'otp_request',
      phone,
      ipPrefix,
      automationSuspected: input.automationSuspected,
      captchaToken: input.captchaToken,
    });

    const limits: [string, RateWindow][] = [
      [`otp:resend:${phone}`, { limit: 1, windowMs: this.resendAfterSeconds * 1000 }],
      [`otp:phone:${phone}`, perMinutes(this.rules.perPhone)],
      [`otp:phone-day:${phone}`, { limit: this.rules.perPhoneDaily, windowMs: DAY_MS }],
      [`otp:ip:${ipPrefix ?? 'unknown'}`, perMinutes(this.rules.perIpPrefix)],
    ];
    // Check every limit before consuming any, so a refused request does not
    // use up the allowance of the limits that passed.
    for (const [key, window] of limits) {
      const result = await this.limiter.check(key, window);
      if (!result.allowed) throw tooMany(result.retryAfterS);
    }
    for (const [key, window] of limits) await this.limiter.consume(key, window);

    const now = this.clock.now();
    const challengeId = newId();
    const code = randomDigits(this.rules.codeLength);
    const hasAccount = await this.hasLiveAccount(phone);

    await this.db
      .insertInto('otp_challenges')
      .values({
        id: challengeId,
        phone_e164: phone,
        purpose,
        code_hash: this.codeHash(challengeId, code),
        expires_at: new Date(now.getTime() + this.rules.ttlSeconds * 1000),
        ip_prefix: ipPrefix,
        created_at: now,
      })
      .execute();

    // signup + existing account: tell the owner by SMS instead of sending a code.
    // login + no account: send nothing (no cost); the caller cannot tell.
    let text: string | null = null;
    if (purpose === 'signup')
      text = hasAccount ? smsMessages.alreadyRegistered() : smsMessages.otpCode(code);
    else if (purpose === 'confirm_action') text = smsMessages.confirmCode(code);
    // reset_password + no account: like login, nothing is sent and nothing is revealed.
    else if (purpose === 'reset_password') text = hasAccount ? smsMessages.resetCode(code) : null;
    else if (hasAccount) text = smsMessages.otpCode(code);

    if (text) {
      // Not awaited: the response time must not depend on whether an SMS was
      // sent, or it would reveal which numbers have accounts.
      void this.sms
        .send(phone, text)
        .then(() => this.budget.spend())
        .catch((error: unknown) => {
          this.logger.error(`SMS to ${maskPhone(phone)} failed: ${(error as Error).message}`);
        });
    }

    return {
      challengeId,
      expiresInS: this.rules.ttlSeconds,
      resendAfterS: this.resendAfterSeconds,
    };
  }

  /**
   * Checks a code. Each wrong guess counts; after the configured number of
   * attempts the challenge is burned even for the right code.
   * @param purposes - The purposes the caller accepts.
   * @throws ProblemException 401 with OTP_INVALID, OTP_EXPIRED or OTP_ATTEMPTS_EXCEEDED.
   */
  async verify(
    challengeId: string,
    code: string,
    purposes: readonly OtpRequestPurpose[],
  ): Promise<VerifiedOtp> {
    const now = this.clock.now();
    const outcome = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('otp_challenges')
        .selectAll()
        .where('id', '=', challengeId)
        .forUpdate()
        .executeTakeFirst();
      // A code requested for one purpose never works for another.
      if (!row || row.consumed_at || !purposes.includes(row.purpose as OtpRequestPurpose)) {
        return 'OTP_INVALID' as const;
      }
      if (row.expires_at <= now) return 'OTP_EXPIRED' as const;
      if (row.attempts >= this.rules.maxAttemptsPerChallenge)
        return 'OTP_ATTEMPTS_EXCEEDED' as const;

      const correct = safeEqual(row.code_hash, this.codeHash(row.id, code));
      await trx
        .updateTable('otp_challenges')
        .set({ attempts: row.attempts + 1, ...(correct ? { consumed_at: now } : {}) })
        .where('id', '=', row.id)
        .execute();
      if (!correct) return 'OTP_INVALID' as const;
      return {
        challengeId: row.id,
        phone: row.phone_e164,
        purpose: row.purpose as OtpRequestPurpose,
      };
    });

    if (typeof outcome === 'string') {
      const titles = {
        OTP_INVALID: 'The code is not correct.',
        OTP_EXPIRED: 'The code has expired. Request a new one.',
        OTP_ATTEMPTS_EXCEEDED: 'Too many wrong codes. Request a new one.',
      };
      throw new ProblemException(401, outcome, titles[outcome]);
    }
    return outcome;
  }

  /** Codes are stored as an HMAC bound to their challenge, never in clear (C-03). */
  private codeHash(challengeId: string, code: string): string {
    return this.keys.hmac('otp', `${challengeId}:${code}`);
  }

  private async hasLiveAccount(phone: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('users')
      .select('id')
      .where('phone_e164', '=', phone)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }
}

/** A 429 problem with Retry-After. */
export function tooMany(retryAfterS: number): ProblemException {
  return new ProblemException(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Try again later.', {
    retryAfterS,
  });
}
