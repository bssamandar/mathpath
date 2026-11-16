/**
 * Staff two-factor authentication with TOTP and recovery codes (C-08).
 *
 * Enrolment: POST /auth/mfa/totp creates an unconfirmed factor and returns the
 * otpauth URI; the first correct code confirms it, marks the session as
 * verified and returns recovery codes once. Sign-in: a staff session starts
 * with `mfaRequired`, and a code (or a recovery code) marks it verified.
 *
 * Any signed-in user may enrol, because a staff role may only be granted to an
 * account that already has 2FA; only staff permissions require it.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { AppConfig } from '@mathpath/config';
import { type Database, newId, type Role } from '@mathpath/db';
import type { Kysely } from 'kysely';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import { perMinutes, type RateLimiter } from '../common/rate-limiter';
import type { AuthKeys } from './keys';
import type { ClientContext, IssuedSession, SessionService } from './session.service';
import { maskPhone } from './sms/sms-sender';
import { matchTotp, otpauthUri } from './totp';

export interface MfaActor {
  userId: string;
  sessionId: string;
  roles: readonly Role[];
  mfaVerified: boolean;
}

export type MfaProof =
  | { kind: 'totp'; code: string; factorId?: string | undefined }
  | { kind: 'recovery'; recoveryCode: string };

export interface MfaResult {
  session: IssuedSession;
  /** Only on first confirmation of a factor; shown to the user once. */
  recoveryCodes?: string[];
}

/** No 0/O or 1/I, so codes written on paper read back correctly. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const invalidCode = (): ProblemException =>
  new ProblemException(401, 'MFA_CODE_INVALID', 'The code is not correct.');

export class MfaService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly keys: AuthKeys,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly rules: AppConfig['auth']['mfa'],
  ) {}

  /**
   * Starts TOTP enrolment.
   * @throws ProblemException 403 MFA_REQUIRED when the account already has 2FA
   *   and this session has not passed it: a stolen password alone must not be
   *   enough to replace the second factor.
   */
  async enrol(actor: MfaActor): Promise<{ factorId: string; otpauthUri: string }> {
    const confirmed = await this.confirmedFactor(actor.userId);
    if (confirmed && !actor.mfaVerified) {
      throw new ProblemException(
        403,
        'MFA_REQUIRED',
        'Confirm your sign-in with your authenticator app.',
      );
    }
    const user = await this.db
      .selectFrom('users')
      .select('phone_e164')
      .where('id', '=', actor.userId)
      .executeTakeFirstOrThrow();

    // 160 bits, the size RFC 4226 recommends for HMAC-SHA-1.
    const secret = randomBytes(20);
    const factorId = newId();
    await this.db.transaction().execute(async (trx) => {
      // Abandoned enrolments are replaced, so at most one is pending.
      await trx
        .deleteFrom('mfa_factors')
        .where('user_id', '=', actor.userId)
        .where('confirmed_at', 'is', null)
        .execute();
      await trx
        .insertInto('mfa_factors')
        .values({
          id: factorId,
          user_id: actor.userId,
          type: 'totp',
          secret: this.keys.seal('mfa-secret', secret),
          created_at: this.clock.now(),
        })
        .execute();
    });
    // The masked phone tells the user which account the entry is for without
    // putting the full number in a QR code that may end up in a screenshot.
    const account = user.phone_e164 ? maskPhone(user.phone_e164) : actor.userId.slice(0, 8);
    return { factorId, otpauthUri: otpauthUri(secret, this.rules.issuer, account) };
  }

  /**
   * Confirms enrolment or completes a sign-in that is waiting for 2FA.
   * @throws ProblemException 401 MFA_CODE_INVALID, 429 after too many wrong codes.
   */
  async verify(actor: MfaActor, proof: MfaProof, client: ClientContext): Promise<MfaResult> {
    const key = `mfa:user:${actor.userId}`;
    const window = perMinutes(this.rules.verifyFailures);
    const allowed = await this.limiter.check(key, window);
    if (!allowed.allowed) {
      throw new ProblemException(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Try again later.', {
        retryAfterS: allowed.retryAfterS,
      });
    }

    const outcome =
      proof.kind === 'recovery'
        ? await this.useRecoveryCode(actor.userId, proof.recoveryCode)
        : await this.useTotp(actor.userId, proof.code, proof.factorId);

    if (!outcome) {
      await this.limiter.record(key, window);
      await this.audit.record({
        action: 'auth.mfa_failed',
        actorId: actor.userId,
        actorRoles: actor.roles,
        targetType: 'session',
        targetId: actor.sessionId,
        ipPrefix: client.ipPrefix,
        requestId: client.requestId,
        metadata: { method: proof.kind },
      });
      throw invalidCode();
    }

    const recoveryCodes = outcome.enrolled ? await this.newRecoveryCodes(actor.userId) : undefined;
    await this.audit.record({
      action: outcome.enrolled ? 'auth.mfa_enrolled' : 'auth.mfa_verified',
      actorId: actor.userId,
      actorRoles: actor.roles,
      targetType: 'session',
      targetId: actor.sessionId,
      ipPrefix: client.ipPrefix,
      requestId: client.requestId,
      metadata: { method: proof.kind },
    });
    const session = await this.sessions.elevate(actor.sessionId);
    return recoveryCodes ? { session, recoveryCodes } : { session };
  }

  /** True when the user has a confirmed second factor (needed before a staff role is granted). */
  async hasConfirmedFactor(userId: string): Promise<boolean> {
    return (await this.confirmedFactor(userId)) !== undefined;
  }

  /**
   * Checks a TOTP code against the pending factor named by `factorId`, or
   * against the confirmed factor. The accepted step is stored with a
   * conditional update, so two requests with the same code cannot both pass.
   */
  private async useTotp(
    userId: string,
    code: string,
    factorId: string | undefined,
  ): Promise<{ enrolled: boolean } | null> {
    const now = this.clock.now();
    let query = this.db
      .selectFrom('mfa_factors')
      .select(['id', 'secret', 'confirmed_at', 'last_used_step', 'created_at'])
      .where('user_id', '=', userId)
      .where('type', '=', 'totp');
    query = factorId
      ? query.where('id', '=', factorId)
      : query.where('confirmed_at', 'is not', null);
    const factor = await query.orderBy('created_at', 'desc').executeTakeFirst();
    if (!factor) return null;

    const pending = factor.confirmed_at === null;
    const ttlMs = this.rules.enrolmentTtlMinutes * 60_000;
    if (pending && now.getTime() - factor.created_at.getTime() > ttlMs) return null;

    const secret = this.keys.open('mfa-secret', Buffer.from(factor.secret));
    const lastUsed = factor.last_used_step === null ? null : Number(factor.last_used_step);
    const step = matchTotp(secret, code, now, lastUsed);
    if (step === null) return null;

    return this.db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable('mfa_factors')
        .set({ last_used_step: step, ...(pending ? { confirmed_at: now } : {}) })
        .where('id', '=', factor.id)
        .where((eb) =>
          eb.or([eb('last_used_step', 'is', null), eb('last_used_step', '<', String(step))]),
        )
        .executeTakeFirst();
      if (claimed.numUpdatedRows === 0n) return null;
      if (pending) {
        // The new factor replaces any older one (re-enrolment on a new phone).
        await trx
          .deleteFrom('mfa_factors')
          .where('user_id', '=', userId)
          .where('id', '<>', factor.id)
          .execute();
      }
      return { enrolled: pending };
    });
  }

  private async useRecoveryCode(
    userId: string,
    recoveryCode: string,
  ): Promise<{ enrolled: boolean } | null> {
    // A recovery code only stands in for a factor the account already has.
    if (!(await this.hasConfirmedFactor(userId))) return null;
    const used = await this.db
      .updateTable('mfa_recovery_codes')
      .set({ used_at: this.clock.now() })
      .where('user_id', '=', userId)
      .where('code_hash', '=', this.recoveryHash(userId, recoveryCode))
      .where('used_at', 'is', null)
      .executeTakeFirst();
    return used.numUpdatedRows === 0n ? null : { enrolled: false };
  }

  /** Replaces all recovery codes; returns the new ones in clear, once. */
  private async newRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: this.rules.recoveryCodeCount }, () => {
      const chars = Array.from(
        { length: 10 },
        () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)],
      ).join('');
      return `${chars.slice(0, 5)}-${chars.slice(5)}`;
    });
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
      await trx
        .insertInto('mfa_recovery_codes')
        .values(
          codes.map((code) => ({
            id: newId(),
            user_id: userId,
            code_hash: this.recoveryHash(userId, code),
          })),
        )
        .execute();
    });
    return codes;
  }

  /**
   * Recovery codes carry 50 random bits and are checked under a rate limit,
   * so a keyed HMAC is enough; Argon2 is for low-entropy secrets like passwords.
   * Case and dashes are ignored, as people type codes back from paper.
   */
  private recoveryHash(userId: string, code: string): string {
    const normalised = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return this.keys.hmac('recovery', `${userId}:${normalised}`);
  }

  private async confirmedFactor(userId: string) {
    return this.db
      .selectFrom('mfa_factors')
      .select('id')
      .where('user_id', '=', userId)
      .where('confirmed_at', 'is not', null)
      .executeTakeFirst();
  }
}
