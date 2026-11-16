/**
 * Children, family codes, parental consent and child sign-in
 * (PRD sign-up flow, UX flows F1 and F2, security plan C-04, C-24, C-30).
 *
 * Children have no phone number or password: a parent creates the profile,
 * gives consent confirmed by an SMS code, and sets a PIN. On another device
 * the child signs in with the parent's family code, their nickname and the PIN.
 */
import { randomInt } from 'node:crypto';
import type { AppConfig } from '@mathpath/config';
import { type Database, type Locale, newId, type Role } from '@mathpath/db';
import { Logger } from '@nestjs/common';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import { perMinutes, type RateLimiter } from '../common/rate-limiter';
import type { OtpService } from '../identity/otp.service';
import type { PasswordService } from '../identity/password.service';
import type { ClientContext, IssuedSession, SessionService } from '../identity/session.service';
import { smsMessages } from '../identity/sms/messages';
import { maskPhone, type SmsSender } from '../identity/sms/sms-sender';
import { isTooSimplePin } from './pin';
import { assertParentOf } from './policies';

export type ConsentScope = 'learning' | 'leaderboard' | 'teacher_sharing' | 'marketing_to_parent';

export interface ConsentInput {
  policyVersion: string;
  scopes: ConsentScope[];
  otpChallengeId: string;
  otpCode: string;
}

export interface NewChild {
  firstName: string;
  nickname: string;
  grade: number;
  birthYear?: number | undefined;
  pin: string;
  consent: ConsentInput;
}

export interface ChildChanges {
  nickname?: string | undefined;
  grade?: number | undefined;
  pin?: string | undefined;
  dailyTimeLimitMin?: number | null | undefined;
}

/** The `Child` schema in docs/api/openapi.yaml. */
export interface ChildView {
  id: string;
  firstName: string;
  nickname: string;
  nicknameStatus: 'pending' | 'approved' | 'rejected';
  grade: number;
  birthYear: number | null;
  dailyTimeLimitMin: number | null;
  plan: 'free' | 'trial' | 'paid';
}

/** The `Consent` schema. */
export interface ConsentView {
  id: string;
  policyVersion: string;
  scopes: string[];
  grantedAt: string;
  revokedAt: string | null;
}

/** The parent as known from their access token. */
export interface Actor {
  userId: string;
  sessionId: string;
  roles: readonly Role[];
}

/** Letters and digits that cannot be confused when read aloud or typed (no 0/O, 1/I). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

const invalidChildLogin = (): ProblemException =>
  new ProblemException(401, 'INVALID_CREDENTIALS', 'Family code, name or PIN is not correct.');

export class FamilyService {
  private readonly logger = new Logger('FamilyService');

  constructor(
    private readonly db: Kysely<Database>,
    private readonly otp: OtpService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiter,
    private readonly sms: SmsSender,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly limits: AppConfig['limits']['rateLimits'],
  ) {}

  /** The parent's children and family code (created on first use). */
  async listChildren(parentId: string): Promise<{ familyCode: string; items: ChildView[] }> {
    const familyCode = await this.db.transaction().execute((trx) => this.familyCode(trx, parentId));
    const rows = await this.childQuery(this.db)
      .where('l.parent_id', '=', parentId)
      .orderBy('u.created_at')
      .execute();
    return { familyCode, items: rows.map(toChildView) };
  }

  /**
   * Creates a child account with consent confirmed by an SMS code to the parent.
   * @throws ProblemException 401/403 for a bad confirmation, 409 for a nickname
   *   already used in the family, 422 for a too simple PIN.
   */
  async addChild(actor: Actor, input: NewChild, client: ClientContext): Promise<ChildView> {
    if (!input.consent.scopes.includes('learning')) {
      throw new ProblemException(422, 'CONSENT_LEARNING_REQUIRED', 'Learning consent is needed.', {
        errors: [{ field: 'consent.scopes', message: 'must include "learning"' }],
      });
    }
    this.assertPinAcceptable(input.pin);
    const parent = await this.confirmParent(actor.userId, input.consent);
    const pinHash = await this.passwords.hash(input.pin);
    const now = this.clock.now();
    const childId = newId();
    const consentId = newId();

    await this.db.transaction().execute(async (trx) => {
      await this.familyCode(trx, actor.userId); // also locks the family against parallel adds
      await this.assertNicknameFree(trx, actor.userId, input.nickname);
      await trx
        .insertInto('users')
        .values({
          id: childId,
          first_name: input.firstName,
          locale: parent.locale,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await trx
        .insertInto('user_roles')
        .values({ user_id: childId, role: 'student', granted_by: actor.userId })
        .execute();
      await trx
        .insertInto('student_profiles')
        .values({
          user_id: childId,
          nickname: input.nickname,
          grade: input.grade,
          birth_year: input.birthYear ?? null,
          pin_hash: pinHash,
        })
        .execute();
      await this.insertConsent(trx, consentId, actor.userId, childId, input.consent, client, now);
      await trx
        .insertInto('parent_child_links')
        .values({ parent_id: actor.userId, child_id: childId, consent_id: consentId })
        .execute();
      await this.audit.record(
        {
          action: 'family.child_create',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'user',
          targetId: childId,
          ipPrefix: client.ipPrefix,
          requestId: client.requestId,
          metadata: {
            consentId,
            scopes: input.consent.scopes,
            policyVersion: input.consent.policyVersion,
          },
        },
        trx,
      );
    });
    return this.childView(childId);
  }

  /** Changes a child's nickname, grade, PIN or daily time limit. */
  async updateChild(
    actor: Actor,
    childId: string,
    changes: ChildChanges,
    client: ClientContext,
  ): Promise<ChildView> {
    await assertParentOf(this.db, actor.userId, childId);
    if (changes.pin !== undefined) this.assertPinAcceptable(changes.pin);
    const pinHash = changes.pin === undefined ? undefined : await this.passwords.hash(changes.pin);

    await this.db.transaction().execute(async (trx) => {
      if (changes.nickname !== undefined) {
        await this.familyCode(trx, actor.userId);
        await this.assertNicknameFree(trx, actor.userId, changes.nickname, childId);
      }
      const set = {
        // A new nickname goes back to moderation before other children see it.
        ...(changes.nickname !== undefined
          ? { nickname: changes.nickname, nickname_status: 'pending' as const }
          : {}),
        ...(changes.grade !== undefined ? { grade: changes.grade } : {}),
        ...(changes.dailyTimeLimitMin !== undefined
          ? { daily_time_limit_min: changes.dailyTimeLimitMin }
          : {}),
        // A new PIN also lifts a lock: the parent has just chosen it.
        ...(pinHash ? { pin_hash: pinHash, pin_failed_count: 0, pin_locked_until: null } : {}),
      };
      if (Object.keys(set).length > 0) {
        await trx.updateTable('student_profiles').set(set).where('user_id', '=', childId).execute();
      }
      await this.audit.record(
        {
          action: 'family.child_update',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'user',
          targetId: childId,
          ipPrefix: client.ipPrefix,
          requestId: client.requestId,
          // Field names only: never the PIN, and nicknames are not needed here.
          metadata: {
            fields: Object.keys(changes).filter(
              (k) => changes[k as keyof ChildChanges] !== undefined,
            ),
          },
        },
        trx,
      );
    });
    return this.childView(childId);
  }

  /** Consent history, newest first. */
  async listConsents(parentId: string, childId: string): Promise<ConsentView[]> {
    await assertParentOf(this.db, parentId, childId);
    const rows = await this.db
      .selectFrom('consents')
      .selectAll()
      .where('child_id', '=', childId)
      .orderBy('granted_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toConsentView);
  }

  /**
   * Records a new consent, which replaces the current one. Consent is never
   * edited in place: the history is the evidence (C-30).
   */
  async updateConsent(
    actor: Actor,
    childId: string,
    input: ConsentInput,
    client: ClientContext,
  ): Promise<ConsentView> {
    await assertParentOf(this.db, actor.userId, childId);
    await this.confirmParent(actor.userId, input);
    const now = this.clock.now();
    const consentId = newId();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('consents')
        .set({ revoked_at: now })
        .where('child_id', '=', childId)
        .where('revoked_at', 'is', null)
        .execute();
      await this.insertConsent(trx, consentId, actor.userId, childId, input, client, now);
      await trx
        .updateTable('parent_child_links')
        .set({ consent_id: consentId })
        .where('parent_id', '=', actor.userId)
        .where('child_id', '=', childId)
        .execute();
      await this.audit.record(
        {
          action: 'family.consent_update',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'user',
          targetId: childId,
          ipPrefix: client.ipPrefix,
          requestId: client.requestId,
          metadata: { consentId, scopes: input.scopes, policyVersion: input.policyVersion },
        },
        trx,
      );
    });
    const row = await this.db
      .selectFrom('consents')
      .selectAll()
      .where('id', '=', consentId)
      .executeTakeFirstOrThrow();
    return toConsentView(row);
  }

  /**
   * Child sign-in with family code, nickname and PIN (UX F2).
   *
   * Wrong PINs lock the profile after the configured count and the parent is
   * told by SMS; failures per family code and per network are limited too.
   * All failures look the same to the caller.
   */
  async childLogin(
    input: { familyCode: string; nickname: string; pin: string },
    client: ClientContext,
  ): Promise<IssuedSession> {
    const familyCode = input.familyCode.toUpperCase();
    const familyKey = `child:family:${familyCode}`;
    const ipKey = `login:ip:${client.ipPrefix ?? 'unknown'}`;
    const familyWindow = perMinutes(this.limits.childLoginFailuresPerFamily);
    const ipWindow = perMinutes(this.limits.loginFailuresPerIpPrefix);
    for (const [key, window] of [
      [familyKey, familyWindow],
      [ipKey, ipWindow],
    ] as const) {
      const result = await this.limiter.check(key, window);
      if (!result.allowed) {
        throw new ProblemException(
          429,
          'TOO_MANY_REQUESTS',
          'Too many attempts. Try again later.',
          {
            retryAfterS: result.retryAfterS,
          },
        );
      }
    }

    const child = await this.db
      .selectFrom('family_codes as f')
      .innerJoin('parent_child_links as l', 'l.parent_id', 'f.parent_id')
      .innerJoin('student_profiles as p', 'p.user_id', 'l.child_id')
      .innerJoin('users as u', 'u.id', 'l.child_id')
      .innerJoin('users as parent', 'parent.id', 'f.parent_id')
      .select([
        'u.id',
        'u.status',
        'p.pin_hash',
        'p.pin_failed_count',
        'p.pin_locked_until',
        'parent.id as parent_id',
        'parent.phone_e164 as parent_phone',
      ])
      .where('f.code', '=', familyCode)
      .where(sql<boolean>`lower(p.nickname) = lower(${input.nickname.trim()})`)
      .where('u.deleted_at', 'is', null)
      .executeTakeFirst();

    const now = this.clock.now();
    if (child?.pin_locked_until && child.pin_locked_until > now) {
      throw new ProblemException(
        423,
        'PROFILE_LOCKED',
        'This profile is locked. Ask your parent to help.',
        {
          retryAfterS: (child.pin_locked_until.getTime() - now.getTime()) / 1000,
        },
      );
    }

    const check = await this.passwords.verify(child?.pin_hash ?? null, input.pin);
    if (!child || !check.ok) {
      await this.limiter.record(familyKey, familyWindow);
      await this.limiter.record(ipKey, ipWindow);
      if (child) await this.pinFailed(child, client);
      throw invalidChildLogin();
    }
    if (child.status !== 'active') {
      throw new ProblemException(
        423,
        'ACCOUNT_LOCKED',
        'This account is locked. Ask your parent to help.',
      );
    }
    if (child.pin_failed_count > 0) {
      await this.db
        .updateTable('student_profiles')
        .set({ pin_failed_count: 0 })
        .where('user_id', '=', child.id)
        .execute();
    }
    return this.sessions.start(child.id, client, 'child_pin');
  }

  /**
   * A parent opens a child's profile on their own device (UX F2). The parent
   * session is linked, and switching back needs the parent to sign in again,
   * so a child cannot reach billing.
   */
  async switchProfile(
    actor: Actor,
    childId: string,
    client: ClientContext,
  ): Promise<IssuedSession> {
    await assertParentOf(this.db, actor.userId, childId);
    await this.audit.record({
      action: 'family.switch_profile',
      actorId: actor.userId,
      actorRoles: actor.roles,
      targetType: 'user',
      targetId: childId,
      ipPrefix: client.ipPrefix,
      requestId: client.requestId,
    });
    return this.sessions.start(childId, client, 'switch_profile', {
      parentSessionId: actor.sessionId,
    });
  }

  /** Counts a wrong PIN; at the limit, locks the profile and tells the parent. */
  private async pinFailed(
    child: { id: string; pin_failed_count: number; parent_id: string; parent_phone: string | null },
    client: ClientContext,
  ): Promise<void> {
    const { limit, windowMinutes } = this.limits.childPinFailures;
    const failures = child.pin_failed_count + 1;
    if (failures < limit) {
      await this.db
        .updateTable('student_profiles')
        .set({ pin_failed_count: failures })
        .where('user_id', '=', child.id)
        .execute();
      return;
    }
    const lockedUntil = new Date(this.clock.now().getTime() + windowMinutes * 60_000);
    await this.db
      .updateTable('student_profiles')
      .set({ pin_failed_count: 0, pin_locked_until: lockedUntil })
      .where('user_id', '=', child.id)
      .execute();
    await this.audit.record({
      action: 'auth.child_pin_locked',
      targetType: 'user',
      targetId: child.id,
      ipPrefix: client.ipPrefix,
      requestId: client.requestId,
    });
    if (child.parent_phone) {
      const phone = child.parent_phone;
      void this.sms.send(phone, smsMessages.childPinLocked()).catch((error: unknown) => {
        this.logger.error(
          `PIN lock notice to ${maskPhone(phone)} failed: ${(error as Error).message}`,
        );
      });
    }
  }

  /**
   * Checks the SMS confirmation for consent: a `confirm_action` code sent to
   * the parent's own phone. This is the evidence that the account holder, not
   * someone holding their unlocked browser, agreed.
   */
  private async confirmParent(
    parentId: string,
    consent: ConsentInput,
  ): Promise<{ locale: Locale }> {
    const parent = await this.db
      .selectFrom('users')
      .select(['phone_e164', 'locale'])
      .where('id', '=', parentId)
      .executeTakeFirstOrThrow();
    const verified = await this.otp.verify(consent.otpChallengeId, consent.otpCode, [
      'confirm_action',
    ]);
    if (verified.phone !== parent.phone_e164) {
      throw new ProblemException(
        403,
        'CONSENT_NOT_CONFIRMED',
        'Confirm with a code sent to your own phone.',
      );
    }
    return { locale: parent.locale };
  }

  private async insertConsent(
    trx: Transaction<Database>,
    id: string,
    parentId: string,
    childId: string,
    consent: ConsentInput,
    client: ClientContext,
    now: Date,
  ): Promise<void> {
    await trx
      .insertInto('consents')
      .values({
        id,
        parent_id: parentId,
        child_id: childId,
        policy_version: consent.policyVersion,
        scopes: [...new Set(consent.scopes)],
        method: 'otp_confirmed',
        evidence: {
          otpChallengeId: consent.otpChallengeId,
          ipPrefix: client.ipPrefix,
          userAgent: client.userAgentSummary,
          requestId: client.requestId,
        },
        granted_at: now,
      })
      .execute();
  }

  /** Returns the parent's family code, creating it once. Locks the row for the transaction. */
  private async familyCode(trx: Transaction<Database>, parentId: string): Promise<string> {
    const existing = await trx
      .selectFrom('family_codes')
      .select('code')
      .where('parent_id', '=', parentId)
      .forUpdate()
      .executeTakeFirst();
    if (existing) return existing.code;
    // 32^8 ≈ 10^12 codes: a collision is unlikely, and the unique index catches one.
    const code = Array.from(
      { length: CODE_LENGTH },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
    ).join('');
    await trx.insertInto('family_codes').values({ parent_id: parentId, code }).execute();
    return code;
  }

  /** Nicknames identify a child at sign-in, so they are unique within a family (any case). */
  private async assertNicknameFree(
    trx: Transaction<Database>,
    parentId: string,
    nickname: string,
    exceptChildId?: string,
  ): Promise<void> {
    let query = trx
      .selectFrom('parent_child_links as l')
      .innerJoin('student_profiles as p', 'p.user_id', 'l.child_id')
      .select('p.user_id')
      .where('l.parent_id', '=', parentId)
      .where(sql<boolean>`lower(p.nickname) = lower(${nickname})`);
    if (exceptChildId) query = query.where('p.user_id', '<>', exceptChildId);
    if (await query.executeTakeFirst()) {
      throw new ProblemException(
        409,
        'NICKNAME_TAKEN',
        'Another child in this family has this name.',
        {
          errors: [{ field: 'nickname', message: 'already used in this family' }],
        },
      );
    }
  }

  private assertPinAcceptable(pin: string): void {
    if (isTooSimplePin(pin)) {
      throw new ProblemException(422, 'PIN_TOO_SIMPLE', 'Choose a PIN that is harder to guess.', {
        errors: [{ field: 'pin', message: 'too easy to guess' }],
      });
    }
  }

  private childQuery(db: Kysely<Database>) {
    return db
      .selectFrom('parent_child_links as l')
      .innerJoin('users as u', 'u.id', 'l.child_id')
      .innerJoin('student_profiles as p', 'p.user_id', 'l.child_id')
      .select([
        'u.id',
        'u.first_name',
        'p.nickname',
        'p.nickname_status',
        'p.grade',
        'p.birth_year',
        'p.daily_time_limit_min',
        // The child's current cover: a paid plan wins over a trial.
        sql<string | null>`(
          SELECT s.plan_code FROM subscription_members m
          JOIN subscriptions s ON s.id = m.subscription_id
          WHERE m.student_id = u.id
            AND s.status IN ('trialing', 'active')
            AND s.current_period_end > ${this.clock.now()}
          ORDER BY (s.plan_code = 'trial')
          LIMIT 1
        )`.as('covered_by'),
      ])
      .where('u.deleted_at', 'is', null);
  }

  private async childView(childId: string): Promise<ChildView> {
    const row = await this.childQuery(this.db)
      .where('u.id', '=', childId)
      .executeTakeFirstOrThrow();
    return toChildView(row);
  }
}

function toChildView(row: {
  id: string;
  first_name: string;
  nickname: string;
  nickname_status: 'pending' | 'approved' | 'rejected';
  grade: number;
  birth_year: number | null;
  daily_time_limit_min: number | null;
  covered_by: string | null;
}): ChildView {
  return {
    id: row.id,
    firstName: row.first_name,
    nickname: row.nickname,
    nicknameStatus: row.nickname_status,
    grade: row.grade,
    birthYear: row.birth_year,
    dailyTimeLimitMin: row.daily_time_limit_min,
    plan: row.covered_by === null ? 'free' : row.covered_by === 'trial' ? 'trial' : 'paid',
  };
}

function toConsentView(row: {
  id: string;
  policy_version: string;
  scopes: string[];
  granted_at: Date;
  revoked_at: Date | null;
}): ConsentView {
  return {
    id: row.id,
    policyVersion: row.policy_version,
    scopes: row.scopes,
    grantedAt: row.granted_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}
