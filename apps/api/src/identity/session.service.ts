/**
 * Sessions and refresh-token rotation (ADR-0005, C-06).
 *
 * A session is one signed-in device. Each refresh token can be used once: using
 * it returns a new one. If an already-used token is presented again, someone
 * holds a copy (a stolen token or a replayed request), so the whole session is
 * revoked and both the thief and the user must sign in again.
 *
 * Because of that rule, the web client must not refresh from two tabs at once;
 * it serialises refreshes (one request at a time, shared between tabs).
 */
import { type Database, newId, type RevokeReason, type Role } from '@mathpath/db';
import type { Kysely } from 'kysely';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import { randomToken, sha256 } from './crypto';
import type { AuthKeys } from './keys';
import type { RevokedSessions } from './revoked-sessions';
import type { TokenService } from './token.service';

/** Roles that must pass TOTP 2FA before using their permissions (C-08). */
export const STAFF_ROLES: ReadonlySet<Role> = new Set(['author', 'reviewer', 'admin', 'support']);

/** Where a request came from; see common/client-info.ts. */
export interface ClientContext {
  ipPrefix: string | null;
  userAgentSummary: string | null;
  /** For the audit log, so an entry can be matched to the request in the logs. */
  requestId: string | null;
  /** The user agent looks like a script or headless browser (a risk signal). */
  automationSuspected: boolean;
}

/** How the user proved who they are; recorded in the audit log. */
export type SignInMethod = 'password' | 'otp' | 'registration' | 'child_pin' | 'switch_profile';

/** Everything the client receives when a session starts or is refreshed. */
export interface IssuedSession {
  userId: string;
  sessionId: string;
  roles: Role[];
  mfaRequired: boolean;
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  csrfToken: string;
}

export interface SessionLimits {
  /** Concurrent sessions a student may have (C-24, config/limits.yaml). */
  maxStudentSessions?: number;
  /** Total and idle lifetime of a staff session (C-08, config/auth.yaml). */
  staffSession?: { absoluteHours: number; idleMinutes: number };
}

const invalidRefresh = (): ProblemException =>
  new ProblemException(401, 'SESSION_EXPIRED', 'Please sign in again.');

export class SessionService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tokens: TokenService,
    private readonly keys: AuthKeys,
    private readonly revoked: RevokedSessions,
    private readonly clock: Clock,
    private readonly ttl: { accessTokenTtlMinutes: number; refreshTokenTtlDays: number },
    private readonly audit: AuditService,
    private readonly limits: SessionLimits = {},
  ) {}

  /**
   * Starts a session for a user who just proved who they are.
   * @param options.parentSessionId - Set when a parent opened a child's profile on their device.
   */
  async start(
    userId: string,
    client: ClientContext,
    method: SignInMethod,
    options: { parentSessionId?: string } = {},
  ): Promise<IssuedSession> {
    const now = this.clock.now();
    const refreshExpiresAt = this.refreshExpiry(now);
    const sessionId = newId();
    const refreshToken = randomToken();
    const roles = await this.rolesOf(userId);

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('sessions')
        .values({
          id: sessionId,
          user_id: userId,
          parent_session_id: options.parentSessionId ?? null,
          ip_prefix: client.ipPrefix,
          user_agent_summary: client.userAgentSummary,
          created_at: now,
          last_seen_at: now,
          expires_at: refreshExpiresAt,
        })
        .execute();
      await trx
        .insertInto('refresh_tokens')
        .values({
          id: newId(),
          session_id: sessionId,
          token_hash: sha256(refreshToken),
          expires_at: refreshExpiresAt,
          created_at: now,
        })
        .execute();
      await trx.updateTable('users').set({ last_login_at: now }).where('id', '=', userId).execute();
      await this.audit.record(
        {
          action: 'auth.login',
          actorId: userId,
          actorRoles: roles,
          targetType: 'session',
          targetId: sessionId,
          ipPrefix: client.ipPrefix,
          requestId: client.requestId,
          metadata: { method },
        },
        trx,
      );
    });
    // After the new session exists, so the limit counts it.
    if (roles.includes('student')) await this.enforceStudentLimit(userId, client);

    return this.issue({
      userId,
      sessionId,
      roles,
      mfaVerified: false,
      refreshToken,
      refreshExpiresAt,
    });
  }

  /**
   * Exchanges a refresh token for a new one and a new access token.
   * @throws ProblemException 401 when the token is unknown, expired, revoked or reused.
   */
  async rotate(refreshToken: string, client: ClientContext): Promise<IssuedSession> {
    const now = this.clock.now();
    const newToken = randomToken();
    const refreshExpiresAt = this.refreshExpiry(now);

    // The outcome is decided inside the transaction but acted on after it:
    // throwing inside would roll back the revocation we want to keep.
    const outcome = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('refresh_tokens as rt')
        .innerJoin('sessions as s', 's.id', 'rt.session_id')
        .select([
          'rt.id',
          'rt.used_at',
          'rt.expires_at',
          's.id as session_id',
          's.user_id',
          's.revoked_at',
          's.expires_at as session_expires_at',
          's.created_at as session_created_at',
          's.last_seen_at',
          's.mfa_verified',
        ])
        .where('rt.token_hash', '=', sha256(refreshToken))
        // Locks the token row so two concurrent refreshes cannot both succeed.
        .forUpdate('rt')
        .executeTakeFirst();

      if (!row || row.revoked_at) return { kind: 'invalid' as const };
      if (row.used_at) {
        await this.revokeIn(trx, row.session_id, 'token_reuse', now);
        // Possible token theft: worth a security review, so it is audited.
        await this.audit.record(
          {
            action: 'auth.refresh_token_reused',
            actorId: row.user_id,
            targetType: 'session',
            targetId: row.session_id,
            ipPrefix: client.ipPrefix,
            requestId: client.requestId,
          },
          trx,
        );
        return { kind: 'reused' as const, sessionId: row.session_id };
      }
      if (row.expires_at <= now || row.session_expires_at <= now)
        return { kind: 'invalid' as const };
      const roles = await this.rolesOf(row.user_id, trx);
      if (this.staffSessionOver(roles, row.session_created_at, row.last_seen_at, now)) {
        await this.revokeIn(trx, row.session_id, 'expired', now);
        return { kind: 'expired' as const, sessionId: row.session_id };
      }

      const newId_ = newId();
      await trx
        .insertInto('refresh_tokens')
        .values({
          id: newId_,
          session_id: row.session_id,
          token_hash: sha256(newToken),
          expires_at: refreshExpiresAt,
          created_at: now,
        })
        .execute();
      await trx
        .updateTable('refresh_tokens')
        .set({ used_at: now, replaced_by: newId_ })
        .where('id', '=', row.id)
        .execute();
      // Sliding expiry: an active session stays signed in; an idle one ends.
      await trx
        .updateTable('sessions')
        .set({ last_seen_at: now, expires_at: refreshExpiresAt })
        .where('id', '=', row.session_id)
        .execute();
      return {
        kind: 'ok' as const,
        sessionId: row.session_id,
        userId: row.user_id,
        roles,
        mfaVerified: row.mfa_verified,
      };
    });

    if (outcome.kind === 'reused' || outcome.kind === 'expired') {
      await this.revoked.add(outcome.sessionId, this.ttl.accessTokenTtlMinutes * 60_000);
    }
    if (outcome.kind !== 'ok') throw invalidRefresh();

    return this.issue({
      userId: outcome.userId,
      sessionId: outcome.sessionId,
      roles: outcome.roles,
      mfaVerified: outcome.mfaVerified,
      refreshToken: newToken,
      refreshExpiresAt,
    });
  }

  /**
   * Marks a session as having passed 2FA and issues new tokens that say so.
   * The session's unused refresh tokens are retired, so only the new pair
   * carries the stronger session forward.
   * @throws ProblemException 401 when the session has ended.
   */
  async elevate(sessionId: string): Promise<IssuedSession> {
    const now = this.clock.now();
    const newToken = randomToken();
    const refreshExpiresAt = this.refreshExpiry(now);
    const userId = await this.db.transaction().execute(async (trx) => {
      const session = await trx
        .updateTable('sessions')
        .set({ mfa_verified: true, last_seen_at: now, expires_at: refreshExpiresAt })
        .where('id', '=', sessionId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now)
        .returning('user_id')
        .executeTakeFirst();
      if (!session) return null;
      const tokenId = newId();
      await trx
        .insertInto('refresh_tokens')
        .values({
          id: tokenId,
          session_id: sessionId,
          token_hash: sha256(newToken),
          expires_at: refreshExpiresAt,
          created_at: now,
        })
        .execute();
      await trx
        .updateTable('refresh_tokens')
        .set({ used_at: now, replaced_by: tokenId })
        .where('session_id', '=', sessionId)
        .where('id', '<>', tokenId)
        .where('used_at', 'is', null)
        .execute();
      return session.user_id;
    });
    if (!userId) throw invalidRefresh();
    return this.issue({
      userId,
      sessionId,
      roles: await this.rolesOf(userId),
      mfaVerified: true,
      refreshToken: newToken,
      refreshExpiresAt,
    });
  }

  /**
   * Ends a session now, including its current access token.
   * @param actor - Who ended it (the user on logout, an admin otherwise).
   */
  async revoke(
    sessionId: string,
    reason: RevokeReason,
    actor: { userId: string; roles: readonly Role[] },
    client: ClientContext,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.revokeIn(trx, sessionId, reason, this.clock.now());
      await this.audit.record(
        {
          action: reason === 'logout' ? 'auth.logout' : 'auth.session_revoked',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'session',
          targetId: sessionId,
          ipPrefix: client.ipPrefix,
          requestId: client.requestId,
          metadata: { reason },
        },
        trx,
      );
    });
    await this.revoked.add(sessionId, this.ttl.accessTokenTtlMinutes * 60_000);
  }

  /**
   * Ends every live session of a user now, including the current access
   * tokens: used when an admin locks an account or takes a role away, so the
   * change does not wait for tokens to expire. The caller writes the audit
   * entry for the admin action.
   * @returns How many sessions were ended.
   */
  async endAll(userId: string, reason: RevokeReason): Promise<number> {
    const ended = await this.db
      .updateTable('sessions')
      .set({ revoked_at: this.clock.now(), revoke_reason: reason })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .returning('id')
      .execute();
    for (const { id } of ended) {
      await this.revoked.add(id, this.ttl.accessTokenTtlMinutes * 60_000);
    }
    return ended.length;
  }

  /**
   * Account sharing (C-24): a student keeps at most N live sessions; the
   * oldest are signed out. The family sees them in the session list.
   */
  private async enforceStudentLimit(userId: string, client: ClientContext): Promise<void> {
    const live = await this.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', this.clock.now())
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    for (const { id } of live.slice(this.limits.maxStudentSessions ?? Number.POSITIVE_INFINITY)) {
      await this.revoke(id, 'session_limit', { userId, roles: ['student'] }, client);
    }
  }

  /** The CSRF token for a session: an HMAC of its ID, so nothing is stored (C-07). */
  csrfToken(sessionId: string): string {
    return this.keys.hmac('csrf', sessionId);
  }

  private async revokeIn(
    db: Kysely<Database>,
    sessionId: string,
    reason: RevokeReason,
    now: Date,
  ): Promise<void> {
    await db
      .updateTable('sessions')
      .set({ revoked_at: now, revoke_reason: reason })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /**
   * Staff sessions are short (C-08): a stolen staff session reaches content
   * and user data, so it must not live for the 30 days a family session does.
   * Access tokens last 15 minutes, so an active session refreshes well within
   * the idle limit.
   */
  private staffSessionOver(roles: Role[], createdAt: Date, lastSeenAt: Date, now: Date): boolean {
    const rule = this.limits.staffSession;
    if (!rule || !roles.some((r) => STAFF_ROLES.has(r))) return false;
    const age = now.getTime() - createdAt.getTime();
    const idle = now.getTime() - lastSeenAt.getTime();
    return age > rule.absoluteHours * 3_600_000 || idle > rule.idleMinutes * 60_000;
  }

  /** @param db - Pass the transaction when called inside one. */
  private async rolesOf(userId: string, db: Kysely<Database> = this.db): Promise<Role[]> {
    const rows = await db
      .selectFrom('user_roles')
      .select('role')
      .where('user_id', '=', userId)
      .orderBy('role')
      .execute();
    return rows.map((r) => r.role);
  }

  private refreshExpiry(now: Date): Date {
    return new Date(now.getTime() + this.ttl.refreshTokenTtlDays * 86_400_000);
  }

  private async issue(input: {
    userId: string;
    sessionId: string;
    roles: Role[];
    mfaVerified: boolean;
    refreshToken: string;
    refreshExpiresAt: Date;
  }): Promise<IssuedSession> {
    const access = await this.tokens.signAccess(input);
    return {
      userId: input.userId,
      sessionId: input.sessionId,
      roles: input.roles,
      mfaRequired: !input.mfaVerified && input.roles.some((r) => STAFF_ROLES.has(r)),
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: input.refreshToken,
      refreshExpiresAt: input.refreshExpiresAt,
      csrfToken: this.csrfToken(input.sessionId),
    };
  }
}
