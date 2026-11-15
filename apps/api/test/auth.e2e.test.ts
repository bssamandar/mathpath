import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@mathpath/db';
import { createTestApp, type TestApp } from './helpers';

const PHONE = '+998901234567';
const PASSWORD = 'quiet-river-71-lamp';
const MINUTE = 60_000;

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

const http = () => request(t.app.getHttpServer());

/** Reads one cookie's value from a response's Set-Cookie headers. */
function cookie(res: request.Response, name: string): string | undefined {
  const headers = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const line = headers.find((h) => h.startsWith(`${name}=`));
  return line ? decodeURIComponent(line.slice(name.length + 1).split(';')[0]!) : undefined;
}

async function requestCode(phone = PHONE, purpose: 'signup' | 'login' = 'signup') {
  const res = await http().post('/api/v1/auth/otp').send({ phone, purpose }).expect(202);
  return res.body.challengeId as string;
}

/** Runs the whole sign-up flow and returns the register response. */
async function signUp(phone = PHONE) {
  const challengeId = await requestCode(phone);
  const verified = await http()
    .post('/api/v1/auth/otp/verify')
    .send({ challengeId, code: t.sms.lastCode(phone) })
    .expect(200);
  return http()
    .post('/api/v1/auth/register')
    .send({
      registrationToken: verified.body.registrationToken,
      firstName: 'Dilnoza',
      password: PASSWORD,
      role: 'parent',
      acceptedTermsVersion: '2026-11',
    })
    .expect(201);
}

describe('POST /auth/otp', () => {
  it('sends a 6-digit code for sign-up and stores only its hash', async () => {
    const challengeId = await requestCode();
    const code = t.sms.lastCode(PHONE);
    expect(code).toMatch(/^\d{6}$/);
    const row = await t.db
      .selectFrom('otp_challenges')
      .selectAll()
      .where('id', '=', challengeId)
      .executeTakeFirstOrThrow();
    expect(row.code_hash).not.toContain(code);
  });

  it('answers the same for registered and unknown numbers (no enumeration, C-03)', async () => {
    await signUp();
    t.clock.advance(MINUTE * 2);
    const known = await http().post('/api/v1/auth/otp').send({ phone: PHONE, purpose: 'signup' });
    const unknown = await http()
      .post('/api/v1/auth/otp')
      .send({ phone: '+998901111111', purpose: 'login' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(Object.keys(known.body).sort()).toEqual(Object.keys(unknown.body).sort());
  });

  it('tells an existing account owner by SMS instead of sending a sign-up code', async () => {
    await signUp();
    t.clock.advance(MINUTE * 2);
    await requestCode(PHONE, 'signup');
    expect(t.sms.sent.at(-1)?.text).toMatch(/ro‘yxatdan o‘tgan/);
    expect(t.sms.sent.at(-1)?.text).not.toMatch(/\d{6}/);
  });

  it('sends nothing for a login code to an unknown number (no SMS cost)', async () => {
    await requestCode('+998902222222', 'login');
    expect(t.sms.sent).toHaveLength(0);
  });

  it('refuses countries we do not serve (SMS pumping, C-20)', async () => {
    const res = await http()
      .post('/api/v1/auth/otp')
      .send({ phone: '+447700900123', purpose: 'signup' })
      .expect(400);
    expect(res.body.code).toBe('PHONE_COUNTRY_NOT_SUPPORTED');
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('enforces the resend delay and the per-phone limit with Retry-After', async () => {
    await requestCode();
    const tooSoon = await http()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'signup' })
      .expect(429);
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0);

    t.clock.advance(MINUTE + 1000);
    await requestCode();
    t.clock.advance(MINUTE + 1000);
    await requestCode();
    t.clock.advance(MINUTE + 1000);
    // 3 per 10 minutes (config/risk.yaml).
    const res = await http()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'signup' })
      .expect(429);
    expect(res.body.code).toBe('TOO_MANY_REQUESTS');
  });

  it('rejects unknown fields (C-12)', async () => {
    const res = await http()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'signup', role: 'admin' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /auth/otp/verify', () => {
  it('burns the challenge after 5 wrong codes, even for the right code', async () => {
    const challengeId = await requestCode();
    const code = t.sms.lastCode(PHONE);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await http()
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId, code: wrong })
        .expect(401);
      expect(res.body.code).toBe('OTP_INVALID');
    }
    const res = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId, code })
      .expect(401);
    expect(res.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('rejects an expired code', async () => {
    const challengeId = await requestCode();
    t.clock.advance(5 * MINUTE + 1000);
    const res = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId, code: t.sms.lastCode(PHONE) })
      .expect(401);
    expect(res.body.code).toBe('OTP_EXPIRED');
  });

  it('accepts a code only once', async () => {
    const challengeId = await requestCode();
    const code = t.sms.lastCode(PHONE);
    await http().post('/api/v1/auth/otp/verify').send({ challengeId, code }).expect(200);
    await http().post('/api/v1/auth/otp/verify').send({ challengeId, code }).expect(401);
  });

  it('rejects an unknown challenge', async () => {
    await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId: newId(), code: '123456' })
      .expect(401);
  });

  it('signs in with a login code', async () => {
    await signUp();
    t.clock.advance(2 * MINUTE);
    const challengeId = await requestCode(PHONE, 'login');
    const res = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId, code: t.sms.lastCode(PHONE) })
      .expect(200);
    expect(res.body.roles).toEqual(['parent']);
    expect(cookie(res, '__Host-mp_at')).toBeTruthy();
  });
});

describe('POST /auth/register', () => {
  it('creates a parent, records the terms version and sets secure cookies', async () => {
    const res = await signUp();
    expect(res.body).toMatchObject({ roles: ['parent'], mfaRequired: false });
    expect(res.body.accessToken).toBeUndefined();

    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const access = setCookie.find((c) => c.startsWith('__Host-mp_at='))!;
    const refresh = setCookie.find((c) => c.startsWith('__Secure-mp_rt='))!;
    expect(access).toMatch(/HttpOnly/);
    expect(access).toMatch(/Secure/);
    expect(access).toMatch(/SameSite=Lax/);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth\/refresh/);

    const user = await t.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', res.body.userId)
      .executeTakeFirstOrThrow();
    expect(user.terms_version).toBe('2026-11');
    expect(user.password_hash).toMatch(/^\$argon2id\$/);
    expect(user.phone_verified_at).not.toBeNull();
  });

  it('refuses common passwords and passwords that are too short (C-01)', async () => {
    const challengeId = await requestCode();
    const verified = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId, code: t.sms.lastCode(PHONE) });
    const attempt = (password: string) =>
      http().post('/api/v1/auth/register').send({
        registrationToken: verified.body.registrationToken,
        firstName: 'Dilnoza',
        password,
        role: 'parent',
        acceptedTermsVersion: '2026-11',
      });
    expect((await attempt('short')).body.code).toBe('PASSWORD_TOO_SHORT');
    expect((await attempt('Qwertyuiop')).body.code).toBe('PASSWORD_TOO_COMMON');
    expect((await attempt('998901234567')).body.code).toBe('PASSWORD_TOO_COMMON');
  });

  it('refuses a forged or expired registration ticket', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({
        registrationToken: 'x.y.z',
        firstName: 'A',
        password: PASSWORD,
        role: 'parent',
        acceptedTermsVersion: '1',
      })
      .expect(401);
    expect(res.body.code).toBe('REGISTRATION_EXPIRED');
  });

  it('refuses a second account for the same phone (one account per phone, C-21)', async () => {
    const challengeId = await requestCode();
    const verified = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId, code: t.sms.lastCode(PHONE) });
    const body = {
      registrationToken: verified.body.registrationToken,
      firstName: 'Dilnoza',
      password: PASSWORD,
      role: 'parent',
      acceptedTermsVersion: '2026-11',
    };
    await http().post('/api/v1/auth/register').send(body).expect(201);
    const res = await http().post('/api/v1/auth/register').send(body).expect(409);
    expect(res.body.code).toBe('PHONE_ALREADY_REGISTERED');
  });

  it('does not allow signing up as staff or teacher', async () => {
    await http()
      .post('/api/v1/auth/register')
      .send({
        registrationToken: 'x',
        firstName: 'A',
        password: PASSWORD,
        role: 'admin',
        acceptedTermsVersion: '1',
      })
      .expect(400);
  });
});

describe('POST /auth/login', () => {
  it('signs in with the right password', async () => {
    await signUp();
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ phone: PHONE, password: PASSWORD })
      .expect(200);
    expect(res.body.roles).toEqual(['parent']);
  });

  it('gives the same answer for a wrong password and an unknown phone', async () => {
    await signUp();
    const wrong = await http()
      .post('/api/v1/auth/login')
      .send({ phone: PHONE, password: 'nope-nope-nope' })
      .expect(401);
    const unknown = await http()
      .post('/api/v1/auth/login')
      .send({ phone: '+998909999999', password: PASSWORD })
      .expect(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('limits failures per account, and keeps refusing even the right password (C-04)', async () => {
    await signUp();
    for (let i = 0; i < 5; i++) {
      await http()
        .post('/api/v1/auth/login')
        .send({ phone: PHONE, password: 'wrong-password-1' })
        .expect(401);
    }
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ phone: PHONE, password: PASSWORD })
      .expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);

    t.clock.advance(15 * MINUTE + 1000);
    await http().post('/api/v1/auth/login').send({ phone: PHONE, password: PASSWORD }).expect(200);
  });

  it('refuses a locked account with 423', async () => {
    const res = await signUp();
    await t.db
      .updateTable('users')
      .set({ status: 'locked' })
      .where('id', '=', res.body.userId)
      .execute();
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ phone: PHONE, password: PASSWORD })
      .expect(423);
    expect(login.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('asks staff for 2FA before granting their permissions (C-08)', async () => {
    const res = await signUp();
    await t.db
      .insertInto('user_roles')
      .values({ user_id: res.body.userId, role: 'author' })
      .execute();
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ phone: PHONE, password: PASSWORD })
      .expect(200);
    expect(login.body.mfaRequired).toBe(true);
  });
});

describe('refresh, CSRF and logout', () => {
  it('rotates the refresh token, and reuse of an old one revokes the session (C-06)', async () => {
    const reg = await signUp();
    const first = cookie(reg, '__Secure-mp_rt')!;

    const rotated = await http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `__Secure-mp_rt=${first}`)
      .expect(200);
    const second = cookie(rotated, '__Secure-mp_rt')!;
    expect(second).not.toBe(first);

    // An attacker replays the first token: the whole session ends.
    const replay = await http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `__Secure-mp_rt=${first}`)
      .expect(401);
    expect(replay.body.code).toBe('SESSION_EXPIRED');
    await http().post('/api/v1/auth/refresh').set('Cookie', `__Secure-mp_rt=${second}`).expect(401);

    const session = await t.db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();
    expect(session.revoke_reason).toBe('token_reuse');

    // The access token issued before the reuse is refused immediately too.
    const access = cookie(rotated, '__Host-mp_at')!;
    await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', `__Host-mp_at=${access}`)
      .set('X-CSRF-Token', rotated.body.csrfToken)
      .expect(401);
  });

  it('refuses a refresh after the session has been idle too long', async () => {
    const reg = await signUp();
    t.clock.advance(31 * 24 * 60 * MINUTE);
    await http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `__Secure-mp_rt=${cookie(reg, '__Secure-mp_rt')!}`)
      .expect(401);
  });

  it('refuses a refresh without a token and clears the cookies', async () => {
    const res = await http().post('/api/v1/auth/refresh').expect(401);
    expect(cookie(res, '__Secure-mp_rt')).toBe('');
  });

  it('requires the CSRF token for cookie-authenticated changes (C-07)', async () => {
    const reg = await signUp();
    const access = cookie(reg, '__Host-mp_at')!;

    const missing = await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', `__Host-mp_at=${access}`)
      .expect(403);
    expect(missing.body.code).toBe('CSRF_TOKEN_INVALID');
    await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', `__Host-mp_at=${access}`)
      .set('X-CSRF-Token', 'forged')
      .expect(403);

    await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', `__Host-mp_at=${access}`)
      .set('X-CSRF-Token', reg.body.csrfToken)
      .expect(204);

    // Signed out: the same access token no longer works.
    await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', `__Host-mp_at=${access}`)
      .set('X-CSRF-Token', reg.body.csrfToken)
      .expect(401);
  });

  it('serves mobile clients with Bearer tokens in the body and no cookies', async () => {
    await signUp();
    const login = await http()
      .post('/api/v1/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ phone: PHONE, password: PASSWORD })
      .expect(200);
    expect(login.headers['set-cookie']).toBeUndefined();
    expect(login.body.accessToken).toBeTruthy();

    const refreshed = await http()
      .post('/api/v1/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    // Bearer requests need no CSRF token.
    await http()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
      .expect(204);
  });

  it('rejects an expired access token', async () => {
    const reg = await signUp();
    t.clock.advance(16 * MINUTE);
    await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', `__Host-mp_at=${cookie(reg, '__Host-mp_at')!}`)
      .set('X-CSRF-Token', reg.body.csrfToken)
      .expect(401);
  });
});
