/**
 * Admin console (step 6.7b): user search and changes, the risk review queue
 * and the audit log (UX S17; security plan C-08, C-14, C-33).
 */
import { newId } from '@mathpath/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RiskService } from '../src/risk/risk.service';
import { user } from './billing.helpers';
import { browser, createTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());
const PHONE = '+998901234567';

async function withPhone(
  id: string,
  phone: string,
  firstName = 'Aziza',
  lastName: string | null = 'Karimova',
) {
  await t.db
    .updateTable('users')
    .set({ phone_e164: phone, first_name: firstName, last_name: lastName })
    .where('id', '=', id)
    .execute();
}

async function confirmMfa(userId: string) {
  await t.db
    .insertInto('mfa_factors')
    .values({
      id: newId(),
      user_id: userId,
      type: 'totp',
      secret: Buffer.from('not-a-real-secret'),
      confirmed_at: t.clock.now(),
    })
    .execute();
}

const search = async (auth: string, query: string) =>
  http().get(`/api/v1/admin/users?${query}`).set('Authorization', auth);

const patch = async (auth: string, id: string, body: Record<string, unknown>) =>
  http().patch(`/api/v1/admin/users/${id}`).set('Authorization', auth).send(body);

async function auditOf(action: string) {
  return t.db
    .selectFrom('audit_log')
    .select(['actor_id', 'target_id', 'metadata'])
    .where('action', '=', action)
    .orderBy('created_at')
    .execute();
}

describe('admin users', () => {
  it('finds a user by phone, name or ID, masks the phone and audits the search', async () => {
    const admin = await user(t, ['admin']);
    const parent = await user(t, ['parent']);
    await withPhone(parent.id, PHONE);
    const auth = await admin.auth();

    for (const q of ['901234567', '+998 90 123-45-67', '998901234567', 'kari', parent.id]) {
      const res = await search(auth, `q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
      expect(res.body.items, q).toEqual([
        expect.objectContaining({
          id: parent.id,
          firstName: 'Aziza',
          lastName: 'Karimova',
          phoneMasked: '+99890*****67',
          roles: ['parent'],
          status: 'active',
          riskLevel: 'normal',
          mfaEnabled: false,
        }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain('1234567');
    }
    // "%" is matched literally, not as a wildcard.
    expect((await search(auth, 'q=%25%25%25')).body.items).toEqual([]);
    expect((await search(auth, 'q=ab')).status).toBe(400);

    const audits = await auditOf('admin.user_search');
    expect(audits).toHaveLength(6);
    expect(audits[0]).toMatchObject({
      actor_id: admin.id,
      metadata: { kind: 'phone', results: 1 },
    });
    expect(JSON.stringify(audits)).not.toMatch(/901234567|kari/i);
  });

  it('pages through results with a cursor', async () => {
    const admin = await user(t, ['admin']);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await user(t, ['parent']);
      await withPhone(u.id, `+99890000000${i}`, 'Zarina', null);
      ids.push(u.id);
      t.clock.advance(1000);
    }
    const auth = await admin.auth();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `q=zarina&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await search(auth, query);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((u: { id: string }) => u.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual([...ids].sort());
    expect((await search(auth, 'q=zarina&cursor=not-ours')).status).toBe(400);
  });

  it('grants a staff role only after 2FA, and records each change with the reason', async () => {
    const admin = await user(t, ['admin']);
    const teacher = await user(t, ['parent']);
    const auth = await admin.auth();
    const reason = 'New maths author from the Tashkent team';

    const refused = await patch(auth, teacher.id, { addRoles: ['author'], reason });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('MFA_NOT_ENROLLED');

    await confirmMfa(teacher.id);
    const res = await patch(auth, teacher.id, { addRoles: ['author', 'teacher'], reason });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ roles: ['author', 'parent', 'teacher'], mfaEnabled: true });
    const grants = await auditOf('user.role.grant');
    expect(grants.map((g) => g.metadata)).toEqual([
      { role: 'author', reason },
      { role: 'teacher', reason },
    ]);
    expect(grants[0]).toMatchObject({ actor_id: admin.id, target_id: teacher.id });

    // Sign-up roles are not managed here, and a change needs a reason.
    expect((await patch(auth, teacher.id, { addRoles: ['student'], reason })).status).toBe(400);
    expect((await patch(auth, teacher.id, { addRoles: ['teacher'] })).status).toBe(400);
    expect((await patch(auth, teacher.id, { reason })).status).toBe(400);
    expect(
      (await patch(auth, teacher.id, { addRoles: ['author'], removeRoles: ['author'], reason }))
        .status,
    ).toBe(422);
  });

  it('signs a locked account out at once and refuses changes to one’s own account', async () => {
    const admin = await user(t, ['admin']);
    const other = await user(t, ['parent']);
    const auth = await admin.auth();
    const theirs = await other.auth();
    await http().get('/api/v1/children').set('Authorization', theirs).expect(200);

    const res = await patch(auth, other.id, { status: 'locked', reason: 'Card fraud reported' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('locked');
    await http().get('/api/v1/children').set('Authorization', theirs).expect(401);
    expect((await auditOf('user.status_change'))[0]?.metadata).toEqual({
      from: 'active',
      to: 'locked',
      reason: 'Card fraud reported',
    });

    const self = await patch(auth, admin.id, {
      removeRoles: ['admin'],
      reason: 'Leaving the team',
    });
    expect(self.status).toBe(422);
    expect(self.body.code).toBe('SELF_CHANGE_FORBIDDEN');
    expect((await patch(auth, newId(), { status: 'active', reason: 'Nobody' })).status).toBe(404);

    await t.db
      .updateTable('users')
      .set({ status: 'pending_deletion' })
      .where('id', '=', other.id)
      .execute();
    expect((await patch(auth, other.id, { status: 'active', reason: 'Unlock' })).status).toBe(409);
  });

  it('is for admins only', async () => {
    const author = await user(t, ['author']);
    const parent = await user(t, ['parent']);
    for (const who of [author, parent]) {
      const auth = await who.auth();
      expect((await search(auth, 'q=aziza')).status).toBe(403);
      expect((await http().get('/api/v1/admin/audit-log').set('Authorization', auth)).status).toBe(
        403,
      );
      expect(
        (await http().get('/api/v1/admin/risk-reviews').set('Authorization', auth)).status,
      ).toBe(403);
    }
  });
});

describe('risk review queue', () => {
  async function flagged() {
    const subject = await user(t, ['parent']);
    await withPhone(subject.id, PHONE);
    await t.db
      .insertInto('risk_events')
      .values({
        id: newId(),
        user_id: subject.id,
        ip_prefix: null,
        type: 'login.block_and_review',
        score_delta: 80,
        details: { signals: ['failedLoginEach', 'newDeviceAndNewIpPrefix'] },
      })
      .execute();
    const reviewId = newId();
    await t.db
      .insertInto('risk_reviews')
      .values({ id: reviewId, subject_user_id: subject.id, reason: 'score 80' })
      .execute();
    return { subject, reviewId };
  }

  const decide = async (auth: string, reviewId: string, body: Record<string, unknown>) =>
    http()
      .post(`/api/v1/admin/risk-reviews/${reviewId}/decision`)
      .set('Authorization', auth)
      .send(body);

  it('lists open reviews with their signals and a masked phone', async () => {
    const admin = await user(t, ['admin']);
    const { subject, reviewId } = await flagged();
    const res = await http()
      .get('/api/v1/admin/risk-reviews')
      .set('Authorization', await admin.auth())
      .expect(200);
    expect(res.body).toEqual({
      nextCursor: null,
      items: [
        expect.objectContaining({
          id: reviewId,
          subjectUserId: subject.id,
          status: 'open',
          decidedAt: null,
          subject: expect.objectContaining({ firstName: 'Aziza', phoneMasked: '+99890*****67' }),
          signals: [
            expect.objectContaining({
              type: 'login.block_and_review',
              scoreDelta: 80,
              names: ['failedLoginEach', 'newDeviceAndNewIpPrefix'],
            }),
          ],
        }),
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain(PHONE);
  });

  it('restricts an account: every sign-in then needs an interactive CAPTCHA', async () => {
    const admin = await user(t, ['admin']);
    const { subject, reviewId } = await flagged();
    const auth = await admin.auth();
    const risk = t.app.get(RiskService);
    const input = {
      kind: 'login' as const,
      phone: PHONE,
      userId: subject.id,
      ipPrefix: null,
      automationSuspected: false,
    };
    expect((await risk.assess(input)).action).toBe('allow');

    const res = await decide(auth, reviewId, {
      decision: 'restricted',
      notes: 'Many failed logins from new networks',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'restricted', notes: expect.any(String) });
    expect(res.body.decidedAt).not.toBeNull();
    expect(await risk.assess(input)).toMatchObject({
      action: 'step_up',
      signals: ['accountRestricted'],
    });
    expect((await auditOf('risk.review_decided'))[0]).toMatchObject({
      actor_id: admin.id,
      target_id: subject.id,
      metadata: { reviewId, decision: 'restricted' },
    });

    // Decided once only; then clearing goes through a new review.
    const again = await decide(auth, reviewId, { decision: 'cleared', notes: 'Changed my mind' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REVIEW_ALREADY_DECIDED');
    const listed = await http()
      .get('/api/v1/admin/risk-reviews?status=restricted')
      .set('Authorization', auth)
      .expect(200);
    expect(listed.body.items.map((r: { id: string }) => r.id)).toEqual([reviewId]);
  });

  it('bans an account: suspended and signed out everywhere', async () => {
    const admin = await user(t, ['admin']);
    const { subject, reviewId } = await flagged();
    const theirs = await subject.auth();
    const res = await decide(await admin.auth(), reviewId, {
      decision: 'banned',
      notes: 'SMS pumping from this account',
    });
    expect(res.status).toBe(200);
    expect(res.body.subject).toMatchObject({ status: 'suspended', riskLevel: 'blocked' });
    await http().get('/api/v1/children').set('Authorization', theirs).expect(401);
  });

  it('needs notes and refuses a review of one’s own account', async () => {
    const admin = await user(t, ['admin']);
    const auth = await admin.auth();
    const { reviewId } = await flagged();
    expect((await decide(auth, reviewId, { decision: 'cleared' })).status).toBe(400);
    expect((await decide(auth, reviewId, { decision: 'cleared', notes: 'ok' })).status).toBe(400);
    expect((await decide(auth, newId(), { decision: 'cleared', notes: 'Looks fine' })).status).toBe(
      404,
    );
    const own = newId();
    await t.db
      .insertInto('risk_reviews')
      .values({ id: own, subject_user_id: admin.id, reason: 'score 80' })
      .execute();
    const res = await decide(auth, own, { decision: 'cleared', notes: 'It was me travelling' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SELF_CHANGE_FORBIDDEN');
  });
});

describe('audit log', () => {
  it('filters by actor, target and action family, newest first, in pages', async () => {
    const admin = await user(t, ['admin']);
    const auth = await admin.auth();
    const a = await user(t, ['parent']);
    const b = await user(t, ['parent']);
    await patch(auth, a.id, { status: 'locked', reason: 'Card fraud reported' });
    await patch(auth, b.id, { status: 'suspended', reason: 'Abuse reported' });
    await confirmMfa(b.id);
    await patch(auth, b.id, { addRoles: ['support'], reason: 'Joins the support team' });

    const list = async (query: string) => {
      const res = await http().get(`/api/v1/admin/audit-log?${query}`).set('Authorization', auth);
      expect(res.status, query).toBe(200);
      return res.body as {
        items: { action: string; targetId: string; actorRoles: string[] }[];
        nextCursor: string | null;
      };
    };

    const forB = await list(`targetId=${b.id}`);
    expect(forB.items.map((e) => e.action)).toEqual(['user.role.grant', 'user.status_change']);
    expect(forB.items[0]?.actorRoles).toEqual(['admin']);
    const users = await list(`action=user&actorId=${admin.id}`);
    expect(users.items).toHaveLength(3);
    expect((await list('action=user.role')).items).toHaveLength(1);
    expect((await list('action=use')).items).toHaveLength(0);

    const first = await list('action=user&limit=2');
    expect(first.items).toHaveLength(2);
    const second = await list(`action=user&limit=2&cursor=${first.nextCursor}`);
    expect(second).toEqual({
      items: [expect.objectContaining({ targetId: a.id })],
      nextCursor: null,
    });

    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await list(`from=${encodeURIComponent(future)}`)).items).toEqual([]);
    const bad = await http()
      .get('/api/v1/admin/audit-log?action=DROP%20TABLE')
      .set('Authorization', auth);
    expect(bad.status).toBe(400);
  });
});
