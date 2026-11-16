import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@mathpath/config';
import { CounterStore } from '../src/common/counter-store';
import { browser, createTestApp, type TestApp } from './helpers';

const PHONE = '+998901234567';
const PASSWORD = 'quiet-river-71-lamp';
const MINUTE = 60_000;
const rules = loadConfig();

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());
/** A client that sends no user agent, which the risk engine treats as automated. */
const script = () => request(t.app.getHttpServer());

async function blockPrefix(prefix: string) {
  await t.db.insertInto('blocked_prefixes').values({ prefix, reason: 'test' }).execute();
}

async function signUp() {
  const otp = await http().post('/api/v1/auth/otp').send({ phone: PHONE, purpose: 'signup' });
  const verified = await http()
    .post('/api/v1/auth/otp/verify')
    .send({ challengeId: otp.body.challengeId, code: t.sms.lastCode(PHONE) });
  const reg = await http()
    .post('/api/v1/auth/register')
    .send({
      registrationToken: verified.body.registrationToken,
      firstName: 'Dilnoza',
      password: PASSWORD,
      role: 'parent',
      acceptedTermsVersion: '2026-11',
    })
    .expect(201);
  return reg.body.userId as string;
}

describe('risk scoring for code requests (C-20, C-21)', () => {
  it('lets an ordinary browser request through without a CAPTCHA', async () => {
    await http().post('/api/v1/auth/otp').send({ phone: PHONE, purpose: 'signup' }).expect(202);
    expect(await t.db.selectFrom('risk_events').selectAll().execute()).toHaveLength(0);
  });

  it('asks for a CAPTCHA for a flagged prefix and accepts a valid token', async () => {
    await blockPrefix('+99890');
    const res = await http()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'signup' })
      .expect(428);
    expect(res.body.code).toBe('CAPTCHA_REQUIRED');
    expect(t.sms.sent).toHaveLength(0);

    await http()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'signup', captchaToken: 'wrong' })
      .expect(428);
    await http()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'signup', captchaToken: 'dev-pass' })
      .expect(202);

    const events = await t.db.selectFrom('risk_events').selectAll().execute();
    expect(events.map((e) => e.type)).toEqual([
      'otp_request.invisible_captcha',
      'otp_request.invisible_captcha',
      'otp_request.invisible_captcha',
    ]);
    expect(events[2]?.details).toMatchObject({
      signals: ['phonePrefixFlagged'],
      captchaPassed: true,
    });
  });

  it('asks for an interactive CAPTCHA when signals add up (step-up)', async () => {
    await blockPrefix('+99890');
    const res = await script()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'signup' })
      .expect(428);
    expect(res.body.code).toBe('CAPTCHA_INTERACTIVE_REQUIRED');
  });

  it('flags many codes requested from one network', async () => {
    const half = Math.ceil(rules.risk.otp.perIpPrefix.limit / 2);
    for (let i = 0; i < half; i++) {
      await script()
        .post('/api/v1/auth/otp')
        .send({ phone: `+9989000000${String(i).padStart(2, '0')}`, purpose: 'signup' })
        .expect(202);
    }
    // Automated client (25) + velocity (20) = 45: CAPTCHA.
    const res = await script()
      .post('/api/v1/auth/otp')
      .send({ phone: '+998909999999', purpose: 'signup' })
      .expect(428);
    expect(res.body.code).toBe('CAPTCHA_REQUIRED');
  });

  it('requires a CAPTCHA for every code once the SMS budget is spent', async () => {
    // The fake clock is 10:00 UTC, which is 15:00 in Tashkent.
    await t.app
      .get(CounterStore)
      .add('sms:hour:2026-11-15T15', rules.risk.smsBudget.hourlyCapTiyin, 3_600_000);
    const res = await http()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'signup' })
      .expect(428);
    expect(res.body.code).toBe('CAPTCHA_REQUIRED');
    await http()
      .post('/api/v1/auth/otp')
      .send({ phone: PHONE, purpose: 'signup', captchaToken: 'dev-pass' })
      .expect(202);
  });

  it('counts the cost of each SMS sent', async () => {
    await http().post('/api/v1/auth/otp').send({ phone: PHONE, purpose: 'signup' }).expect(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await t.app.get(CounterStore).get('sms:day:2026-11-15')).toBe(
      rules.risk.smsBudget.costPerSmsTiyin,
    );
  });
});

describe('risk scoring and lockout for sign-in (C-04)', () => {
  it('opens a review when the score reaches the block band', async () => {
    const userId = await signUp();
    await blockPrefix('+99890');
    for (let i = 0; i < 4; i++) {
      await script()
        .post('/api/v1/auth/login')
        .send({ phone: PHONE, password: `wrong-password-${i}`, captchaToken: 'dev-pass' });
    }
    // 40 + 25 + min(4 × 5, 25) = 85: blocked even with a valid CAPTCHA.
    const res = await script()
      .post('/api/v1/auth/login')
      .send({ phone: PHONE, password: PASSWORD, captchaToken: 'dev-pass' })
      .expect(403);
    expect(res.body.code).toBe('BLOCKED_FOR_REVIEW');
    const reviews = await t.db.selectFrom('risk_reviews').selectAll().execute();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ subject_user_id: userId, status: 'open' });

    // A second blocked attempt does not open a second review.
    await script()
      .post('/api/v1/auth/login')
      .send({ phone: PHONE, password: PASSWORD, captchaToken: 'dev-pass' })
      .expect(403);
    expect(await t.db.selectFrom('risk_reviews').selectAll().execute()).toHaveLength(1);
  });

  it('locks the account after 10 failures in an hour and tells the owner', async () => {
    await signUp();
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 5; i++) {
        await http()
          .post('/api/v1/auth/login')
          .send({ phone: PHONE, password: `wrong-password-${i}`, captchaToken: 'dev-pass' })
          .expect(401);
      }
      t.clock.advance(16 * MINUTE);
    }
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ phone: PHONE, password: PASSWORD, captchaToken: 'dev-pass' })
      .expect(423);
    expect(res.body.code).toBe('ACCOUNT_TEMPORARILY_LOCKED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(t.sms.sent.at(-1)?.text).toMatch(/noto‘g‘ri parol/);

    const audit = await t.db.selectFrom('audit_log').select('action').execute();
    expect(audit.map((a) => a.action)).toContain('auth.account_temporarily_locked');

    // The lock ends with its window.
    t.clock.advance(61 * MINUTE);
    await http()
      .post('/api/v1/auth/login')
      .send({ phone: PHONE, password: PASSWORD, captchaToken: 'dev-pass' })
      .expect(200);
  });

  it('adds risk for a sign-in from a network the account has never used', async () => {
    await t.close();
    process.env.TRUST_PROXY_HOPS = '1';
    try {
      t = await createTestApp();
    } finally {
      delete process.env.TRUST_PROXY_HOPS;
    }
    await signUp();
    await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.7')
      .send({ phone: PHONE, password: PASSWORD })
      .expect(200);
    const events = await t.db.selectFrom('risk_events').selectAll().execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'login.allow', ip_prefix: '198.51.100.0/24' });
    expect(events[0]?.details).toMatchObject({ signals: ['newDeviceAndNewIpPrefix'] });
  });
});
