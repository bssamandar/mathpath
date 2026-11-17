/**
 * Admin console (UX §3.4 and S17; security plan C-08, C-14, C-33): find a
 * user and change their status or staff roles, decide the accounts the risk
 * engine flagged, and read the audit log.
 *
 * Rules that hold for every action here:
 * - A written reason is required and stored in the audit log (C-14).
 * - Phone numbers are shown masked; the search takes a full number but the
 *   result never shows it back.
 * - An admin cannot change their own account, so one person cannot lock
 *   themselves out or quietly widen their own access.
 * - Locking, banning or taking a role away ends the person's sessions at
 *   once; otherwise the change would wait for their tokens to expire.
 */
import type { Database, RiskLevel, Role, UserStatus } from '@mathpath/db';
import { type Kysely, sql } from 'kysely';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { decodeCursor, page, type Position } from '../common/cursor';
import { ProblemException } from '../common/problem';
import type { MfaService } from '../identity/mfa.service';
import { maskPhone } from '../identity/sms/sms-sender';
import { type ClientContext, type SessionService, STAFF_ROLES } from '../identity/session.service';

/**
 * Roles an admin hands out here. `student` and `parent` come from sign-up and
 * the family flow, which also create the profile and consent they need.
 */
export const MANAGED_ROLES = ['teacher', 'author', 'reviewer', 'admin', 'support'] as const;
export type ManagedRole = (typeof MANAGED_ROLES)[number];

/** How many recent risk events the queue shows per flagged account. */
const SIGNALS_PER_REVIEW = 10;

export interface Actor {
  userId: string;
  roles: readonly Role[];
}

export interface AdminUser {
  id: string;
  firstName: string;
  lastName: string | null;
  phoneMasked: string | null;
  roles: Role[];
  status: UserStatus;
  riskLevel: RiskLevel;
  mfaEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface UserChange {
  status?: 'active' | 'locked' | 'suspended' | undefined;
  addRoles?: ManagedRole[] | undefined;
  removeRoles?: ManagedRole[] | undefined;
  reason: string;
}

export type RiskDecision = 'cleared' | 'restricted' | 'banned';

export interface RiskReviewView {
  id: string;
  subjectUserId: string;
  reason: string;
  status: 'open' | RiskDecision;
  createdAt: string;
  decidedAt: string | null;
  notes: string | null;
  subject: {
    firstName: string;
    phoneMasked: string | null;
    status: UserStatus;
    riskLevel: RiskLevel;
    createdAt: string;
  };
  signals: { type: string; scoreDelta: number; names: string[]; at: string }[];
}

export interface AuditFilter {
  actorId?: string | undefined;
  targetId?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** What a search term looks like: an ID, a phone number or a name. */
export type SearchKind = 'id' | 'phone' | 'name';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads a search term. A phone is accepted the ways people type it: with or
 * without +998, spaces, dashes or brackets.
 */
export function searchTerm(q: string): { kind: SearchKind; value: string } {
  const trimmed = q.trim();
  if (UUID.test(trimmed)) return { kind: 'id', value: trimmed.toLowerCase() };
  const digits = trimmed.replace(/[\s()+-]/g, '');
  if (/^\d{9}$/.test(digits)) return { kind: 'phone', value: `+998${digits}` };
  if (/^998\d{9}$/.test(digits)) return { kind: 'phone', value: `+${digits}` };
  return { kind: 'name', value: trimmed };
}

/** Escapes `%`, `_` and `\` so a name is matched literally by LIKE. */
const likePrefix = (text: string) => `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const notFound = () => new ProblemException(404, 'USER_NOT_FOUND', 'No such user.');

export class AdminService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly clock: Clock,
  ) {}

  /**
   * GET /admin/users. Every search is audited (C-33, T18), with the kind of
   * term and the number of results but not the term itself, which is often a
   * phone number or a child's name.
   */
  async searchUsers(
    actor: Actor,
    client: ClientContext,
    q: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: AdminUser[]; nextCursor: string | null }> {
    const term = searchTerm(q);
    const after = cursor ? decodeCursor(cursor) : null;
    let query = this.db
      .selectFrom('users as u')
      .leftJoin('student_profiles as sp', 'sp.user_id', 'u.id')
      .select(['u.id', 'u.created_at'])
      .where('u.deleted_at', 'is', null);
    if (term.kind === 'id') query = query.where('u.id', '=', term.value);
    else if (term.kind === 'phone') query = query.where('u.phone_e164', '=', term.value);
    else {
      const pattern = likePrefix(term.value);
      query = query.where((eb) =>
        eb.or([
          eb('u.first_name', 'ilike', pattern),
          eb('u.last_name', 'ilike', pattern),
          eb(sql<string>`u.first_name || ' ' || coalesce(u.last_name, '')`, 'ilike', pattern),
          eb('sp.nickname', 'ilike', pattern),
        ]),
      );
    }
    if (after) query = query.where(before('u.created_at', 'u.id', after));
    const rows = await query
      .orderBy('u.created_at', 'desc')
      .orderBy('u.id', 'desc')
      .limit(limit + 1)
      .execute();
    const { rows: kept, nextCursor } = page(rows, limit, (r) => ({ at: r.created_at, id: r.id }));
    const items = await this.views(kept.map((r) => r.id));
    await this.audit.record({
      action: 'admin.user_search',
      actorId: actor.userId,
      actorRoles: actor.roles,
      ipPrefix: client.ipPrefix,
      requestId: client.requestId,
      metadata: { kind: term.kind, results: items.length },
    });
    return { items, nextCursor };
  }

  /**
   * PATCH /admin/users/{userId}.
   * @throws ProblemException 404 for an unknown user; 409 for an account
   *   being deleted; 422 for a change to one's own account, a role that is
   *   not managed here, or a staff role for someone without 2FA (C-08).
   */
  async updateUser(
    actor: Actor,
    client: ClientContext,
    userId: string,
    change: UserChange,
  ): Promise<AdminUser> {
    if (userId === actor.userId) {
      throw new ProblemException(
        422,
        'SELF_CHANGE_FORBIDDEN',
        'Ask another admin to change your own account.',
      );
    }
    const add = [...new Set(change.addRoles ?? [])];
    const remove = [...new Set(change.removeRoles ?? [])];
    if (add.some((r) => remove.includes(r))) {
      throw new ProblemException(422, 'VALIDATION_FAILED', 'A role cannot be added and removed.', {
        errors: [{ field: 'removeRoles', message: 'must not repeat a role from addRoles' }],
      });
    }
    const user = await this.db
      .selectFrom('users')
      .select(['status'])
      .where('id', '=', userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!user) throw notFound();
    if (user.status === 'pending_deletion') {
      throw new ProblemException(
        409,
        'ACCOUNT_PENDING_DELETION',
        'This account is being deleted and cannot be changed.',
      );
    }
    if (add.some((r) => STAFF_ROLES.has(r)) && !(await this.mfa.hasConfirmedFactor(userId))) {
      throw new ProblemException(
        422,
        'MFA_NOT_ENROLLED',
        'A staff role needs two-step sign-in first. Ask the person to set it up.',
      );
    }

    const audit = { actorId: actor.userId, actorRoles: actor.roles, ipPrefix: client.ipPrefix };
    const target = { targetType: 'user', targetId: userId, requestId: client.requestId };
    const { removed, statusChanged } = await this.db.transaction().execute(async (trx) => {
      const current = new Set(
        (
          await trx.selectFrom('user_roles').select('role').where('user_id', '=', userId).execute()
        ).map((r) => r.role),
      );
      const added = add.filter((r) => !current.has(r));
      const removed = remove.filter((r) => current.has(r));
      const statusChanged = change.status !== undefined && change.status !== user.status;
      if (statusChanged) {
        await trx
          .updateTable('users')
          .set({ status: change.status! })
          .where('id', '=', userId)
          .execute();
        await this.audit.record(
          {
            ...audit,
            ...target,
            action: 'user.status_change',
            metadata: { from: user.status, to: change.status, reason: change.reason },
          },
          trx,
        );
      }
      for (const role of added) {
        await trx
          .insertInto('user_roles')
          .values({ user_id: userId, role, granted_by: actor.userId })
          .execute();
        await this.audit.record(
          {
            ...audit,
            ...target,
            action: 'user.role.grant',
            metadata: { role, reason: change.reason },
          },
          trx,
        );
      }
      if (removed.length > 0) {
        await trx
          .deleteFrom('user_roles')
          .where('user_id', '=', userId)
          .where('role', 'in', removed)
          .execute();
        for (const role of removed) {
          await this.audit.record(
            {
              ...audit,
              ...target,
              action: 'user.role.revoke',
              metadata: { role, reason: change.reason },
            },
            trx,
          );
        }
      }
      return { removed, statusChanged };
    });
    // A new role arrives with the next token refresh; a lock or a lost role
    // must take effect now.
    if ((statusChanged && change.status !== 'active') || removed.length > 0) {
      await this.sessions.endAll(userId, 'admin');
    }
    return (await this.views([userId]))[0]!;
  }

  /** GET /admin/risk-reviews, newest first; open ones unless a status is asked for. */
  async riskReviews(
    status: 'open' | RiskDecision,
    limit: number,
    cursor?: string,
  ): Promise<{ items: RiskReviewView[]; nextCursor: string | null }> {
    return this.loadReviews({ status }, limit, cursor ? decodeCursor(cursor) : null);
  }

  private async loadReviews(
    by: { status: 'open' | RiskDecision } | { id: string },
    limit: number,
    after: Position | null,
  ): Promise<{ items: RiskReviewView[]; nextCursor: string | null }> {
    let query = this.db
      .selectFrom('risk_reviews as r')
      .innerJoin('users as u', 'u.id', 'r.subject_user_id')
      .select([
        'r.id',
        'r.subject_user_id',
        'r.reason',
        'r.status',
        'r.notes',
        'r.created_at',
        'r.decided_at',
        'u.first_name',
        'u.phone_e164',
        'u.status as user_status',
        'u.risk_level',
        'u.created_at as user_created_at',
      ]);
    query = 'id' in by ? query.where('r.id', '=', by.id) : query.where('r.status', '=', by.status);
    if (after) query = query.where(before('r.created_at', 'r.id', after));
    const rows = await query
      .orderBy('r.created_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(limit + 1)
      .execute();
    const { rows: kept, nextCursor } = page(rows, limit, (r) => ({ at: r.created_at, id: r.id }));
    const signals = await this.recentSignals(kept.map((r) => r.subject_user_id));
    return {
      nextCursor,
      items: kept.map((r) => ({
        id: r.id,
        subjectUserId: r.subject_user_id,
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at.toISOString(),
        decidedAt: iso(r.decided_at),
        notes: r.notes,
        subject: {
          firstName: r.first_name,
          phoneMasked: r.phone_e164 ? maskPhone(r.phone_e164) : null,
          status: r.user_status,
          riskLevel: r.risk_level,
          createdAt: r.user_created_at.toISOString(),
        },
        signals: signals.get(r.subject_user_id) ?? [],
      })),
    };
  }

  /**
   * POST /admin/risk-reviews/{reviewId}/decision.
   * - cleared: the account is back to normal risk.
   * - restricted: every sign-in and code request needs an interactive CAPTCHA.
   * - banned: the account is suspended and signed out everywhere.
   * @throws ProblemException 404 unknown review; 409 already decided; 422 own account.
   */
  async decide(
    actor: Actor,
    client: ClientContext,
    reviewId: string,
    decision: RiskDecision,
    notes: string,
  ): Promise<RiskReviewView> {
    const now = this.clock.now();
    const subject = await this.db.transaction().execute(async (trx) => {
      const review = await trx
        .selectFrom('risk_reviews')
        .select(['subject_user_id', 'status'])
        .where('id', '=', reviewId)
        .forUpdate()
        .executeTakeFirst();
      if (!review) {
        throw new ProblemException(404, 'REVIEW_NOT_FOUND', 'No such review.');
      }
      if (review.subject_user_id === actor.userId) {
        throw new ProblemException(
          422,
          'SELF_CHANGE_FORBIDDEN',
          'Ask another admin to decide a review of your own account.',
        );
      }
      if (review.status !== 'open') {
        throw new ProblemException(
          409,
          'REVIEW_ALREADY_DECIDED',
          'Someone has already decided this review.',
        );
      }
      await trx
        .updateTable('risk_reviews')
        .set({ status: decision, reviewer_id: actor.userId, notes, decided_at: now })
        .where('id', '=', reviewId)
        .execute();
      const level: RiskLevel =
        decision === 'cleared' ? 'normal' : decision === 'restricted' ? 'high' : 'blocked';
      await trx
        .updateTable('users')
        .set({
          risk_level: level,
          ...(decision === 'banned' ? { status: 'suspended' as const } : {}),
        })
        .where('id', '=', review.subject_user_id)
        .execute();
      await this.audit.record(
        {
          action: 'risk.review_decided',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'user',
          targetId: review.subject_user_id,
          ipPrefix: client.ipPrefix,
          requestId: client.requestId,
          metadata: { reviewId, decision, notes },
        },
        trx,
      );
      return review.subject_user_id;
    });
    if (decision === 'banned') await this.sessions.endAll(subject, 'admin');
    const { items } = await this.loadReviews({ id: reviewId }, 1, null);
    return items[0]!;
  }

  /** GET /admin/audit-log, newest first. `action` matches itself and the actions under it. */
  async auditLog(filter: AuditFilter, limit: number, cursor?: string) {
    const after = cursor ? decodeCursor(cursor) : null;
    let query = this.db
      .selectFrom('audit_log')
      .select([
        'id',
        'actor_id',
        'actor_roles',
        'action',
        'target_type',
        'target_id',
        'request_id',
        'metadata',
        'created_at',
      ]);
    if (filter.actorId) query = query.where('actor_id', '=', filter.actorId);
    if (filter.targetId) query = query.where('target_id', '=', filter.targetId);
    if (filter.action) {
      const action = filter.action;
      query = query.where((eb) =>
        eb.or([eb('action', '=', action), eb('action', 'like', likePrefix(`${action}.`))]),
      );
    }
    if (filter.from) query = query.where('created_at', '>=', new Date(filter.from));
    if (filter.to) query = query.where('created_at', '<', new Date(filter.to));
    if (after) query = query.where(before('created_at', 'id', after));
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const { rows: kept, nextCursor } = page(rows, limit, (r) => ({ at: r.created_at, id: r.id }));
    return {
      nextCursor,
      items: kept.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        actorRoles: r.actor_roles,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        requestId: r.request_id,
        metadata: r.metadata,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /** The admin view of users, in the order of `ids`. */
  private async views(ids: string[]): Promise<AdminUser[]> {
    if (ids.length === 0) return [];
    const [users, roles, factors] = await Promise.all([
      this.db
        .selectFrom('users')
        .select([
          'id',
          'first_name',
          'last_name',
          'phone_e164',
          'status',
          'risk_level',
          'created_at',
          'last_login_at',
        ])
        .where('id', 'in', ids)
        .execute(),
      this.db
        .selectFrom('user_roles')
        .select(['user_id', 'role'])
        .where('user_id', 'in', ids)
        .orderBy('role')
        .execute(),
      this.db
        .selectFrom('mfa_factors')
        .select('user_id')
        .where('user_id', 'in', ids)
        .where('confirmed_at', 'is not', null)
        .execute(),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    const withMfa = new Set(factors.map((f) => f.user_id));
    return ids.flatMap((id) => {
      const u = byId.get(id);
      if (!u) return [];
      return [
        {
          id: u.id,
          firstName: u.first_name,
          lastName: u.last_name,
          phoneMasked: u.phone_e164 ? maskPhone(u.phone_e164) : null,
          roles: roles.filter((r) => r.user_id === id).map((r) => r.role),
          status: u.status,
          riskLevel: u.risk_level,
          mfaEnabled: withMfa.has(id),
          createdAt: u.created_at.toISOString(),
          lastLoginAt: iso(u.last_login_at),
        },
      ];
    });
  }

  /** The latest risk events of each user, newest first. */
  private async recentSignals(userIds: string[]) {
    const out = new Map<string, RiskReviewView['signals']>();
    if (userIds.length === 0) return out;
    const rows = await this.db
      .selectFrom((eb) =>
        eb
          .selectFrom('risk_events')
          .select([
            'user_id',
            'type',
            'score_delta',
            'details',
            'created_at',
            sql<number>`row_number() over (partition by user_id order by created_at desc, id desc)`.as(
              'n',
            ),
          ])
          .where('user_id', 'in', [...new Set(userIds)])
          .as('e'),
      )
      .selectAll()
      .where('n', '<=', SIGNALS_PER_REVIEW)
      .orderBy('created_at', 'desc')
      .execute();
    for (const row of rows) {
      const list = out.get(row.user_id!) ?? [];
      const names = (row.details as { signals?: unknown }).signals;
      list.push({
        type: row.type,
        scoreDelta: row.score_delta,
        names: Array.isArray(names) ? names.map(String) : [],
        at: row.created_at.toISOString(),
      });
      out.set(row.user_id!, list);
    }
    return out;
  }
}

/** Rows strictly after `position` in newest-first order. */
function before(atColumn: string, idColumn: string, position: Position) {
  return sql<boolean>`(${sql.ref(atColumn)}, ${sql.ref(idColumn)}) < (${position.at}, ${position.id}::uuid)`;
}
