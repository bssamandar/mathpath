/**
 * Admin console models and helpers for the studio (API: /admin/users,
 * /admin/risk-reviews, /admin/audit-log). Pure functions, tested in
 * admin.test.ts; the pages only render and call the API.
 */

export const MANAGED_ROLES = ['teacher', 'author', 'reviewer', 'admin', 'support'] as const;
export type ManagedRole = (typeof MANAGED_ROLES)[number];
const STAFF = new Set<string>(['author', 'reviewer', 'admin', 'support']);

export type UserStatus = 'active' | 'locked' | 'suspended' | 'pending_deletion';

export interface AdminUser {
  id: string;
  firstName: string;
  lastName: string | null;
  phoneMasked: string | null;
  roles: string[];
  status: UserStatus;
  riskLevel: string;
  mfaEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export type RiskStatus = 'open' | 'cleared' | 'restricted' | 'banned';
export type RiskDecision = Exclude<RiskStatus, 'open'>;

export interface RiskReview {
  id: string;
  subjectUserId: string;
  reason: string;
  status: RiskStatus;
  createdAt: string;
  decidedAt: string | null;
  notes: string | null;
  subject: {
    firstName: string;
    phoneMasked: string | null;
    status: string;
    riskLevel: string;
    createdAt: string;
  };
  signals: { type: string; scoreDelta: number; names: string[]; at: string }[];
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorRoles: string[];
  action: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const TASHKENT_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;

/** An instant as "YYYY-MM-DD HH:mm" in Tashkent time, the time staff work in. */
export function tashkentTime(iso: string): string {
  return new Date(new Date(iso).getTime() + TASHKENT_MS)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}

/** Whole days between two instants, for "account is N days old". */
export function daysBetween(fromIso: string, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - new Date(fromIso).getTime()) / DAY_MS));
}

/** What the edit form holds for one user. */
export interface UserDraft {
  status: 'active' | 'locked' | 'suspended';
  roles: ManagedRole[];
  reason: string;
}

export function draftOf(user: AdminUser): UserDraft {
  return {
    status: user.status === 'pending_deletion' ? 'active' : user.status,
    roles: MANAGED_ROLES.filter((r) => user.roles.includes(r)),
    reason: '',
  };
}

/** The PATCH body for a draft, or null when nothing would change. */
export function changeBody(user: AdminUser, draft: UserDraft) {
  const addRoles = draft.roles.filter((r) => !user.roles.includes(r));
  const removeRoles = MANAGED_ROLES.filter(
    (r) => user.roles.includes(r) && !draft.roles.includes(r),
  );
  const status = draft.status !== user.status ? draft.status : undefined;
  if (!status && addRoles.length === 0 && removeRoles.length === 0) return null;
  return {
    ...(status ? { status } : {}),
    ...(addRoles.length ? { addRoles } : {}),
    ...(removeRoles.length ? { removeRoles } : {}),
    reason: draft.reason.trim(),
  };
}

/** Problems that stop the save, in Uzbek; the API checks the same rules. */
export function changeProblems(
  user: AdminUser,
  draft: UserDraft,
  myId: string,
): { reason?: string; roles?: string; form?: string } {
  const out: { reason?: string; roles?: string; form?: string } = {};
  if (user.id === myId) out.form = 'O‘z hisobingizni boshqa admin o‘zgartiradi.';
  if (user.status === 'pending_deletion')
    out.form = 'Bu hisob o‘chirilmoqda, uni o‘zgartirib bo‘lmaydi.';
  const reason = draft.reason.trim();
  if (reason.length < 5) out.reason = 'Sababni yozing (kamida 5 belgi).';
  else if (reason.length > 500) out.reason = 'Sabab 500 belgidan oshmasin.';
  const newStaff = draft.roles.filter((r) => STAFF.has(r) && !user.roles.includes(r));
  if (newStaff.length > 0 && !user.mfaEnabled) {
    out.roles =
      'Xodim roli uchun bu odam avval 2FA ni yoqishi kerak: u Studio kirish sahifasida o‘z telefoni va paroli bilan kirib, autentifikator ilovasini ulasin.';
  }
  return out;
}

/** Audit log filters as typed in the form; dates are Tashkent days. */
export interface AuditFilters {
  action: string;
  actorId: string;
  targetId: string;
  fromDay: string;
  toDay: string;
}

export const emptyAuditFilters: AuditFilters = {
  action: '',
  actorId: '',
  targetId: '',
  fromDay: '',
  toDay: '',
};

/** The audit log query string: whole Tashkent days, `to` day included. */
export function auditQuery(filters: AuditFilters, cursor?: string | null): string {
  const params = new URLSearchParams();
  const action = filters.action.trim().toLowerCase();
  if (action) params.set('action', action);
  if (filters.actorId.trim()) params.set('actorId', filters.actorId.trim());
  if (filters.targetId.trim()) params.set('targetId', filters.targetId.trim());
  if (filters.fromDay) params.set('from', `${filters.fromDay}T00:00:00+05:00`);
  if (filters.toDay) {
    const next = new Date(Date.parse(`${filters.toDay}T00:00:00Z`) + DAY_MS)
      .toISOString()
      .slice(0, 10);
    params.set('to', `${next}T00:00:00+05:00`);
  }
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

/** Short, readable audit metadata: `key: value` pairs, nested values as JSON. */
export function metadataText(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}

/** Badge tone for an account status or a review outcome. */
export function tone(status: string): 'published' | 'in_review' | 'danger' | 'draft' {
  if (status === 'active' || status === 'cleared' || status === 'normal') return 'published';
  if (
    status === 'locked' ||
    status === 'restricted' ||
    status === 'open' ||
    status === 'elevated' ||
    status === 'high'
  ) {
    return 'in_review';
  }
  if (status === 'suspended' || status === 'banned' || status === 'blocked') return 'danger';
  return 'draft';
}
