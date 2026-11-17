import { describe, expect, it } from 'vitest';
import {
  type AdminUser,
  auditQuery,
  changeBody,
  changeProblems,
  daysBetween,
  draftOf,
  emptyAuditFilters,
  metadataText,
  tashkentTime,
  tone,
} from './admin';

const user: AdminUser = {
  id: 'u1',
  firstName: 'Aziza',
  lastName: null,
  phoneMasked: '+99890*****67',
  roles: ['parent', 'teacher'],
  status: 'active',
  riskLevel: 'normal',
  mfaEnabled: false,
  createdAt: '2026-11-01T10:00:00Z',
  lastLoginAt: null,
};

describe('user changes', () => {
  it('turns a draft into the smallest PATCH body', () => {
    const draft = draftOf(user);
    expect(draft).toEqual({ status: 'active', roles: ['teacher'], reason: '' });
    expect(changeBody(user, draft)).toBeNull();
    expect(
      changeBody(user, { status: 'locked', roles: ['author'], reason: '  Card fraud  ' }),
    ).toEqual({
      status: 'locked',
      addRoles: ['author'],
      removeRoles: ['teacher'],
      reason: 'Card fraud',
    });
  });

  it('needs a reason, 2FA for a new staff role, and someone else’s account', () => {
    expect(changeProblems(user, { status: 'locked', roles: [], reason: 'ok' }, 'me')).toEqual({
      reason: expect.any(String),
    });
    expect(
      changeProblems(user, { status: 'active', roles: ['admin'], reason: 'New admin' }, 'me'),
    ).toEqual({ roles: expect.any(String) });
    // Teacher is not a staff role, so it needs no 2FA.
    expect(
      changeProblems(user, { status: 'active', roles: ['teacher'], reason: 'Keeps it' }, 'me'),
    ).toEqual({});
    expect(changeProblems(user, draftOf(user), 'u1').form).toBeDefined();
    expect(
      changeProblems({ ...user, status: 'pending_deletion' }, draftOf(user), 'me').form,
    ).toBeDefined();
  });
});

describe('audit filters', () => {
  it('sends whole Tashkent days, with the last day included', () => {
    expect(auditQuery(emptyAuditFilters)).toBe('');
    const query = new URLSearchParams(
      auditQuery(
        { ...emptyAuditFilters, action: ' User.Role ', fromDay: '2026-11-15', toDay: '2026-11-30' },
        'abc',
      ),
    );
    expect(Object.fromEntries(query)).toEqual({
      action: 'user.role',
      from: '2026-11-15T00:00:00+05:00',
      to: '2026-12-01T00:00:00+05:00',
      cursor: 'abc',
    });
  });

  it('shows metadata as short pairs', () => {
    expect(metadataText({ role: 'author', reason: 'New author', n: 2, x: { a: 1 } })).toBe(
      'role: author · reason: New author · n: 2 · x: {"a":1}',
    );
  });
});

describe('formatting', () => {
  it('shows Tashkent time and account age', () => {
    expect(tashkentTime('2026-11-15T20:30:00Z')).toBe('2026-11-16 01:30');
    expect(daysBetween('2026-11-01T10:00:00Z', new Date('2026-11-16T09:00:00Z'))).toBe(14);
    expect(daysBetween('2026-11-20T10:00:00Z', new Date('2026-11-16T09:00:00Z'))).toBe(0);
  });

  it('colours statuses by how serious they are', () => {
    expect(tone('active')).toBe('published');
    expect(tone('open')).toBe('in_review');
    expect(tone('banned')).toBe('danger');
    expect(tone('pending_deletion')).toBe('draft');
  });
});
