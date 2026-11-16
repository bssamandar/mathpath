import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/audit/audit.service';
import { browser, createTestApp, type TestApp } from './helpers';

const PHONE = '+998901234567';
const OTHER_PHONE = '+998907654321';
const PASSWORD = 'quiet-river-71-lamp';
const MINUTE = 60_000;

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());

interface Parent {
  token: string;
  userId: string;
  phone: string;
}

/** Signs a parent up as a mobile client, so the access token comes back in the body. */
async function signUpParent(phone = PHONE): Promise<Parent> {
  const otp = await http().post('/api/v1/auth/otp').send({ phone, purpose: 'signup' }).expect(202);
  const verified = await http()
    .post('/api/v1/auth/otp/verify')
    .send({ challengeId: otp.body.challengeId, code: t.sms.lastCode(phone) })
    .expect(200);
  const reg = await http()
    .post('/api/v1/auth/register')
    .set('X-Client-Type', 'mobile')
    .send({
      registrationToken: verified.body.registrationToken,
      firstName: 'Dilnoza',
      password: PASSWORD,
      role: 'parent',
      acceptedTermsVersion: '2026-11',
    })
    .expect(201);
  return { token: reg.body.accessToken, userId: reg.body.userId, phone };
}

/** Requests a `confirm_action` code to the parent's phone and returns consent fields. */
async function confirmation(parent: Parent, phone = parent.phone) {
  // Past the resend wait and the per-phone window of earlier codes.
  t.clock.advance(5 * MINUTE);
  const res = await http()
    .post('/api/v1/auth/otp')
    .set('Authorization', `Bearer ${parent.token}`)
    .send({ phone, purpose: 'confirm_action' })
    .expect(202);
  return { otpChallengeId: res.body.challengeId as string, otpCode: t.sms.lastCode(phone) };
}

async function consent(parent: Parent, scopes = ['learning']) {
  return { policyVersion: '2026-11', scopes, ...(await confirmation(parent)) };
}

function addChild(parent: Parent, body: Record<string, unknown>) {
  return http().post('/api/v1/children').set('Authorization', `Bearer ${parent.token}`).send(body);
}

async function addAziz(parent: Parent) {
  const res = await addChild(parent, {
    firstName: 'Aziz',
    nickname: 'Aziz_5',
    grade: 5,
    pin: '2580',
    consent: await consent(parent),
  }).expect(201);
  return res.body.id as string;
}

async function familyCode(parent: Parent): Promise<string> {
  const res = await http()
    .get('/api/v1/children')
    .set('Authorization', `Bearer ${parent.token}`)
    .expect(200);
  return res.body.familyCode as string;
}

function childLogin(body: { familyCode: string; nickname: string; pin: string }) {
  return http().post('/api/v1/auth/child-login').set('X-Client-Type', 'mobile').send(body);
}

describe('adding a child (C-30)', () => {
  it('creates the child with consent confirmed by an SMS code to the parent', async () => {
    const parent = await signUpParent();
    const childId = await addAziz(parent);

    const list = await http()
      .get('/api/v1/children')
      .set('Authorization', `Bearer ${parent.token}`)
      .expect(200);
    expect(list.body.familyCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        id: childId,
        firstName: 'Aziz',
        nickname: 'Aziz_5',
        nicknameStatus: 'pending',
        grade: 5,
        plan: 'free',
      }),
    ]);

    const consents = await http()
      .get(`/api/v1/children/${childId}/consents`)
      .set('Authorization', `Bearer ${parent.token}`)
      .expect(200);
    expect(consents.body.items).toHaveLength(1);
    expect(consents.body.items[0]).toMatchObject({ scopes: ['learning'], revokedAt: null });

    // The PIN is stored hashed, never in clear.
    const profile = await t.db
      .selectFrom('student_profiles')
      .select('pin_hash')
      .where('user_id', '=', childId)
      .executeTakeFirstOrThrow();
    expect(profile.pin_hash).not.toContain('2580');
    expect(await verifyAuditChain(t.db)).toMatchObject({ ok: true });
  });

  it('sends the confirmation SMS with its own wording', async () => {
    const parent = await signUpParent();
    await confirmation(parent);
    const last = t.sms.sent.at(-1)!;
    expect(last.phone).toBe(PHONE);
    // Says what the code is for, so a parent is not tricked into sharing a login code.
    expect(last.text).toContain('tasdiqlash');
  });

  it('refuses a confirmation code for somebody else’s number', async () => {
    const parent = await signUpParent();
    t.clock.advance(5 * MINUTE);
    const res = await http()
      .post('/api/v1/auth/otp')
      .set('Authorization', `Bearer ${parent.token}`)
      .send({ phone: OTHER_PHONE, purpose: 'confirm_action' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PHONE_MISMATCH');
    expect(t.sms.sent.some((m) => m.phone === OTHER_PHONE)).toBe(false);
  });

  it('asks anonymous callers to sign in before requesting a confirmation code', async () => {
    const res = await http()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'confirm_action' })
      .expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('does not accept a sign-up or login code as consent', async () => {
    const parent = await signUpParent();
    t.clock.advance(5 * MINUTE);
    const otp = await http()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'login' })
      .expect(202);
    const res = await addChild(parent, {
      firstName: 'Aziz',
      nickname: 'Aziz',
      grade: 5,
      pin: '2580',
      consent: {
        policyVersion: '2026-11',
        scopes: ['learning'],
        otpChallengeId: otp.body.challengeId,
        otpCode: t.sms.lastCode(PHONE),
      },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('OTP_INVALID');
  });

  it('refuses a confirmation that belongs to another parent', async () => {
    const parent = await signUpParent();
    t.clock.advance(5 * MINUTE);
    const other = await signUpParent(OTHER_PHONE);
    const res = await addChild(parent, {
      firstName: 'Aziz',
      nickname: 'Aziz',
      grade: 5,
      pin: '2580',
      consent: { policyVersion: '2026-11', scopes: ['learning'], ...(await confirmation(other)) },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CONSENT_NOT_CONFIRMED');
  });

  it('requires the learning scope and a PIN that is not trivial', async () => {
    const parent = await signUpParent();
    const noLearning = await addChild(parent, {
      firstName: 'Aziz',
      nickname: 'Aziz',
      grade: 5,
      pin: '2580',
      consent: await consent(parent, ['leaderboard']),
    });
    expect(noLearning.status).toBe(422);
    expect(noLearning.body.code).toBe('CONSENT_LEARNING_REQUIRED');

    const simplePin = await addChild(parent, {
      firstName: 'Aziz',
      nickname: 'Aziz',
      grade: 5,
      pin: '1234',
      consent: await consent(parent),
    });
    expect(simplePin.status).toBe(422);
    expect(simplePin.body.code).toBe('PIN_TOO_SIMPLE');
  });

  it('keeps nicknames unique within a family, ignoring case', async () => {
    const parent = await signUpParent();
    await addAziz(parent);
    const res = await addChild(parent, {
      firstName: 'Aziza',
      nickname: 'aziz_5',
      grade: 3,
      pin: '7391',
      consent: await consent(parent),
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NICKNAME_TAKEN');
  });

  it('rejects nicknames with markup characters', async () => {
    const parent = await signUpParent();
    const res = await addChild(parent, {
      firstName: 'Aziz',
      nickname: '<b>Aziz</b>',
      grade: 5,
      pin: '2580',
      consent: await consent(parent),
    });
    expect(res.status).toBe(400);
  });
});

describe('managing a child', () => {
  it('hides another family’s child behind a 404', async () => {
    const parent = await signUpParent();
    const childId = await addAziz(parent);
    t.clock.advance(5 * MINUTE);
    const other = await signUpParent(OTHER_PHONE);
    const auth = `Bearer ${other.token}`;
    const read = await http()
      .get(`/api/v1/children/${childId}/consents`)
      .set('Authorization', auth);
    expect(read.status).toBe(404);
    expect(read.body.code).toBe('CHILD_NOT_FOUND');
    await http()
      .post('/api/v1/auth/switch-profile')
      .set('Authorization', auth)
      .send({ childId })
      .expect(404);
  });

  it('records a new consent and keeps the old one as history', async () => {
    const parent = await signUpParent();
    const childId = await addAziz(parent);
    await http()
      .post(`/api/v1/children/${childId}/consents`)
      .set('Authorization', `Bearer ${parent.token}`)
      .send(await consent(parent, ['learning', 'leaderboard']))
      .expect(201);
    const res = await http()
      .get(`/api/v1/children/${childId}/consents`)
      .set('Authorization', `Bearer ${parent.token}`)
      .expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      scopes: ['learning', 'leaderboard'],
      revokedAt: null,
    });
    expect(res.body.items[1].revokedAt).not.toBeNull();
  });

  it('a new PIN lifts a lock and a new nickname goes back to moderation', async () => {
    const parent = await signUpParent();
    const childId = await addAziz(parent);
    await t.db
      .updateTable('student_profiles')
      .set({ nickname_status: 'approved', pin_locked_until: new Date('2030-01-01') })
      .where('user_id', '=', childId)
      .execute();
    const res = await http()
      .patch(`/api/v1/children/${childId}`)
      .set('Authorization', `Bearer ${parent.token}`)
      .send({ nickname: 'Aziz_new', pin: '8642' })
      .expect(200);
    expect(res.body).toMatchObject({ nickname: 'Aziz_new', nicknameStatus: 'pending' });
    const code = await familyCode(parent);
    await childLogin({ familyCode: code, nickname: 'Aziz_new', pin: '8642' }).expect(200);
  });
});

describe('child sign-in (C-04)', () => {
  it('signs a child in with family code, nickname and PIN', async () => {
    const parent = await signUpParent();
    const childId = await addAziz(parent);
    const code = await familyCode(parent);
    const res = await childLogin({
      familyCode: code.toLowerCase(),
      nickname: ' aziz_5 ',
      pin: '2580',
    }).expect(200);
    expect(res.body).toMatchObject({ userId: childId, roles: ['student'] });
    // The child token works on student routes but not on parent routes.
    await http()
      .get('/api/v1/children')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(403);
  });

  it('answers a wrong PIN, nickname and family code the same way', async () => {
    const parent = await signUpParent();
    await addAziz(parent);
    const code = await familyCode(parent);
    const answers = await Promise.all([
      childLogin({ familyCode: code, nickname: 'Aziz_5', pin: '9999' }),
      childLogin({ familyCode: code, nickname: 'Nobody', pin: '2580' }),
      childLogin({ familyCode: 'ZZZZZZZZ', nickname: 'Aziz_5', pin: '2580' }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('locks the profile after repeated wrong PINs and tells the parent by SMS', async () => {
    const parent = await signUpParent();
    const childId = await addAziz(parent);
    const code = await familyCode(parent);
    const before = t.sms.sent.length;
    for (let i = 0; i < 5; i++) {
      await childLogin({ familyCode: code, nickname: 'Aziz_5', pin: '9999' }).expect(401);
    }
    const locked = await childLogin({ familyCode: code, nickname: 'Aziz_5', pin: '2580' });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('PROFILE_LOCKED');
    const notices = t.sms.sent.slice(before);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.phone).toBe(PHONE);

    const audit = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', childId)
      .where('action', '=', 'auth.child_pin_locked')
      .execute();
    expect(audit).toHaveLength(1);

    // The lock ends with its window.
    t.clock.advance(31 * MINUTE);
    await childLogin({ familyCode: code, nickname: 'Aziz_5', pin: '2580' }).expect(200);
  });

  it('limits failures per family code, against guessing across profiles', async () => {
    const parent = await signUpParent();
    await addAziz(parent);
    const code = await familyCode(parent);
    for (let i = 0; i < 15; i++) {
      await childLogin({ familyCode: code, nickname: `Guess${i}`, pin: '2580' }).expect(401);
    }
    const res = await childLogin({ familyCode: code, nickname: 'Aziz_5', pin: '2580' });
    expect(res.status).toBe(429);
  });

  it('keeps at most two live sessions per student (C-24)', async () => {
    const parent = await signUpParent();
    const childId = await addAziz(parent);
    const code = await familyCode(parent);
    const sessions: string[] = [];
    for (let i = 0; i < 3; i++) {
      t.clock.advance(MINUTE);
      const res = await childLogin({ familyCode: code, nickname: 'Aziz_5', pin: '2580' }).expect(
        200,
      );
      sessions.push(res.body.accessToken as string);
    }
    const live = await t.db
      .selectFrom('sessions')
      .select(['id', 'revoke_reason'])
      .where('user_id', '=', childId)
      .orderBy('created_at')
      .execute();
    expect(live.map((s) => s.revoke_reason)).toEqual(['session_limit', null, null]);
  });
});

describe('switching to a child profile', () => {
  it('starts a child session linked to the parent session', async () => {
    const parent = await signUpParent();
    const childId = await addAziz(parent);
    const res = await http()
      .post('/api/v1/auth/switch-profile')
      .set('X-Client-Type', 'mobile')
      .set('Authorization', `Bearer ${parent.token}`)
      .send({ childId })
      .expect(200);
    expect(res.body).toMatchObject({ userId: childId, roles: ['student'] });
    const session = await t.db
      .selectFrom('sessions')
      .select('parent_session_id')
      .where('user_id', '=', childId)
      .executeTakeFirstOrThrow();
    expect(session.parent_session_id).not.toBeNull();
  });

  it('is not available to a child', async () => {
    const parent = await signUpParent();
    const childId = await addAziz(parent);
    const code = await familyCode(parent);
    const child = await childLogin({ familyCode: code, nickname: 'Aziz_5', pin: '2580' });
    await http()
      .post('/api/v1/auth/switch-profile')
      .set('Authorization', `Bearer ${child.body.accessToken}`)
      .send({ childId })
      .expect(403);
  });
});
