/**
 * Sign-up and sign-in flows for adults (parents), built from the OTP,
 * password and session services. Child sign-in and staff 2FA come next.
 */
import type { AppConfig } from '@mathpath/config';
import { type Database, type Locale, newId } from '@mathpath/db';
import type { Kysely } from 'kysely';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import { perMinutes, type RateLimiter } from '../common/rate-limiter';
import type { OtpService } from './otp.service';
import { tooMany } from './otp.service';
import type { PasswordService } from './password.service';
import type { ClientContext, IssuedSession, SessionService } from './session.service';
import type { SignedToken, TokenService } from './token.service';

export interface RegisterInput {
  registrationToken: string;
  firstName: string;
  lastName?: string | undefined;
  password: string;
  locale?: Locale | undefined;
  acceptedTermsVersion: string;
}

/** Result of a verified code: a sign-up ticket or a signed-in session. */
export type OtpVerifyResult =
  | { kind: 'registration'; ticket: SignedToken }
  | { kind: 'session'; session: IssuedSession };

const invalidCredentials = (): ProblemException =>
  new ProblemException(401, 'INVALID_CREDENTIALS', 'Phone number or password is not correct.');

const phoneTaken = (): ProblemException =>
  new ProblemException(
    409,
    'PHONE_ALREADY_REGISTERED',
    'This phone number already has an account.',
  );

export class AuthService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly otp: OtpService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    private readonly limits: AppConfig['limits']['rateLimits'],
    private readonly audit: AuditService,
  ) {}

  /** Verifies an OTP and continues the flow it was requested for. */
  async verifyOtp(
    challengeId: string,
    code: string,
    client: ClientContext,
  ): Promise<OtpVerifyResult> {
    const verified = await this.otp.verify(challengeId, code);
    const user = await this.liveUserByPhone(verified.phone);

    if (verified.purpose === 'signup') {
      // Normally impossible (an existing number gets no code), unless the
      // account was created between the request and the verification.
      if (user) throw phoneTaken();
      return {
        kind: 'registration',
        ticket: await this.tokens.signRegistration(verified.phone, verified.challengeId),
      };
    }

    if (!user) throw invalidCredentials();
    this.assertActive(user.status);
    return { kind: 'session', session: await this.sessions.start(user.id, client, 'otp') };
  }

  /**
   * Creates a parent account from a registration ticket and signs it in.
   * @throws ProblemException 401 for a bad ticket, 409 if the phone is taken, 422 for a weak password.
   */
  async register(input: RegisterInput, client: ClientContext): Promise<IssuedSession> {
    const phone = await this.tokens.verifyRegistration(input.registrationToken);
    if (!phone) {
      throw new ProblemException(401, 'REGISTRATION_EXPIRED', 'Verify your phone number again.');
    }
    if (await this.liveUserByPhone(phone)) throw phoneTaken();
    await this.passwords.assertAcceptable(input.password, { phone });

    const passwordHash = await this.passwords.hash(input.password);
    const now = this.clock.now();
    const userId = newId();
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('users')
          .values({
            id: userId,
            phone_e164: phone,
            phone_verified_at: now,
            password_hash: passwordHash,
            first_name: input.firstName,
            last_name: input.lastName ?? null,
            ...(input.locale ? { locale: input.locale } : {}),
            terms_version: input.acceptedTermsVersion,
            terms_accepted_at: now,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await trx
          .insertInto('user_roles')
          .values({ user_id: userId, role: 'parent', granted_at: now })
          .execute();
        await this.audit.record(
          {
            action: 'user.register',
            actorId: userId,
            actorRoles: ['parent'],
            targetType: 'user',
            targetId: userId,
            ipPrefix: client.ipPrefix,
            requestId: client.requestId,
            metadata: { termsVersion: input.acceptedTermsVersion },
          },
          trx,
        );
      });
    } catch (error) {
      // Two sign-ups for the same number at the same moment: the unique index decides.
      if (/users_phone_live_uq/.test(String((error as Error).message))) throw phoneTaken();
      throw error;
    }
    return this.sessions.start(userId, client, 'registration');
  }

  /**
   * Signs in with phone and password (C-04).
   *
   * Failures are limited per account and per network prefix. The limits are
   * checked before the password, so a locked-out attacker gets no signal
   * about whether a guess was right.
   */
  async login(phone: string, password: string, client: ClientContext): Promise<IssuedSession> {
    const accountKey = `login:account:${phone}`;
    const ipKey = `login:ip:${client.ipPrefix ?? 'unknown'}`;
    const accountWindow = perMinutes(this.limits.loginFailuresPerAccount);
    const ipWindow = perMinutes(this.limits.loginFailuresPerIpPrefix);

    for (const [key, window] of [
      [accountKey, accountWindow],
      [ipKey, ipWindow],
    ] as const) {
      const result = await this.limiter.check(key, window);
      if (!result.allowed) throw tooMany(result.retryAfterS);
    }

    const user = await this.liveUserByPhone(phone);
    const check = await this.passwords.verify(user?.password_hash ?? null, password);
    if (!user || !check.ok) {
      await this.limiter.record(accountKey, accountWindow);
      await this.limiter.record(ipKey, ipWindow);
      // The phone number is not logged; for an unknown number nothing identifies the target.
      await this.audit.record({
        action: 'auth.login_failed',
        targetType: user ? 'user' : null,
        targetId: user?.id ?? null,
        ipPrefix: client.ipPrefix,
        requestId: client.requestId,
        metadata: { reason: user ? 'wrong_password' : 'unknown_account' },
      });
      throw invalidCredentials();
    }
    this.assertActive(user.status);

    if (check.needsRehash) {
      // Upgrade old hashes while we briefly hold the plain password (C-02).
      const passwordHash = await this.passwords.hash(password);
      await this.db
        .updateTable('users')
        .set({ password_hash: passwordHash })
        .where('id', '=', user.id)
        .execute();
    }
    return this.sessions.start(user.id, client, 'password');
  }

  private assertActive(status: string): void {
    if (status !== 'active') {
      throw new ProblemException(423, 'ACCOUNT_LOCKED', 'This account is locked. Contact support.');
    }
  }

  private async liveUserByPhone(phone: string) {
    return this.db
      .selectFrom('users')
      .select(['id', 'password_hash', 'status'])
      .where('phone_e164', '=', phone)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  }
}
