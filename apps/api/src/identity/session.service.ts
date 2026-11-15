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
export type SignInMethod = 'password' | 'otp' | 'registration';

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
  ) {}

  /** Starts a session for a user who just proved who they are. */
  async start(userId: string, client: ClientContext, method: SignInMethod): Promise<IssuedSession> {
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
        mfaVerified: row.mfa_verified,
      };
    });

    if (outcome.kind === 'reused') {
      await this.revoked.add(outcome.sessionId, this.ttl.accessTokenTtlMinutes * 60_000);
    }
    if (outcome.kind !== 'ok') throw invalidRefresh();

    return this.issue({
      userId: outcome.userId,
      sessionId: outcome.sessionId,
      roles: await this.rolesOf(outcome.userId),
      mfaVerified: outcome.mfaVerified,
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

  private async rolesOf(userId: string): Promise<Role[]> {
    const rows = await this.db
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
