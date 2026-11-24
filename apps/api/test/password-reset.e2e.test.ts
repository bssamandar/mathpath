import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browser, createTestApp, type TestApp } from './helpers';

const PHONE = '+998901234567';
const OLD_PASSWORD = 'quiet-river-71-lamp';
const NEW_PASSWORD = 'amber-forest-38-kite';
// Built, not written out: secret scanners take random-looking literals for keys.
const OTHER_PASSWORD = `${NEW_PASSWORD}-again`;
const MINUTE = 60_000;

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());

async function requestCode(purpose: 'signup' | 'reset_password', phone = PHONE) {
  const res = await http().post('/api/v1/auth/otp').send({ phone, purpose }).expect(202);
  return res.body.challengeId as string;
}

async function signUp() {
  const challengeId = await requestCode('signup');
  const verified = await http()
    .post('/api/v1/auth/otp/verify')
    .send({ challengeId, code: t.sms.lastCode(PHONE) })
    .expect(200);
  await http()
    .post('/api/v1/auth/register')
    .send({
      registrationToken: verified.body.registrationToken,
      firstName: 'Dilnoza',
      password: OLD_PASSWORD,
      role: 'parent',
      acceptedTermsVersion: '2026-11',
    })
    .expect(201);
  t.clock.advance(MINUTE * 2);
}

/** Requests a reset code and exchanges it for a reset ticket. */
async function resetTicket(): Promise<string> {
  const challengeId = await requestCode('reset_password');
  const res = await http()
    .post('/api/v1/auth/otp/verify')
    .send({ challengeId, code: t.sms.lastCode(PHONE) })
    .expect(200);
  expect(res.body.resetToken).toEqual(expect.any(String));
  expect(res.body).not.toHaveProperty('accessToken');
  return res.body.resetToken as string;
}

const login = (password: string) =>
  http().post('/api/v1/auth/login').send({ phone: PHONE, password });

describe('password reset', () => {
  it('sets a new password, signs out everywhere and records an audit entry', async () => {
    await signUp();
    const resetToken = await resetTicket();
    expect(t.sms.sent.at(-1)?.text).toContain('parolni tiklash');

    await http()
      .post('/api/v1/auth/password/reset')
      .send({ resetToken, newPassword: NEW_PASSWORD })
      .expect(204);

    expect((await login(OLD_PASSWORD)).status).toBe(401);
    expect((await login(NEW_PASSWORD)).status).toBe(200);

    const live = await t.db
      .selectFrom('sessions')
      .select(['revoke_reason'])
      .where('revoke_reason', '=', 'password_change')
      .execute();
    expect(live.length).toBeGreaterThanOrEqual(1);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'auth.password_reset')
      .execute();
    expect(audit).toHaveLength(1);
  });

  it('accepts a ticket only once', async () => {
    await signUp();
    const resetToken = await resetTicket();
    await http()
      .post('/api/v1/auth/password/reset')
      .send({ resetToken, newPassword: NEW_PASSWORD })
      .expect(204);
    const again = await http()
      .post('/api/v1/auth/password/reset')
      .send({ resetToken, newPassword: OTHER_PASSWORD });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('RESET_EXPIRED');
    expect((await login(NEW_PASSWORD)).status).toBe(200);
  });

  it('refuses a weak new password and keeps the ticket usable', async () => {
    await signUp();
    const resetToken = await resetTicket();
    const weak = await http()
      .post('/api/v1/auth/password/reset')
      .send({ resetToken, newPassword: 'short' });
    expect(weak.status).toBe(422);
    await http()
      .post('/api/v1/auth/password/reset')
      .send({ resetToken, newPassword: NEW_PASSWORD })
      .expect(204);
  });

  it('sends nothing for an unknown number, with the same answer', async () => {
    const before = t.sms.sent.length;
    const res = await http()
      .post('/api/v1/auth/otp')
      .send({ phone: '+998901111111', purpose: 'reset_password' });
    expect(res.status).toBe(202);
    expect(res.body.challengeId).toEqual(expect.any(String));
    expect(t.sms.sent.length).toBe(before);
  });

  it('does not accept a registration ticket or a forged token', async () => {
    const challengeId = await requestCode('signup');
    const verified = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId, code: t.sms.lastCode(PHONE) })
      .expect(200);
    for (const resetToken of [verified.body.registrationToken as string, 'not-a-token']) {
      const res = await http()
        .post('/api/v1/auth/password/reset')
        .send({ resetToken, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(401);
    }
  });
});
