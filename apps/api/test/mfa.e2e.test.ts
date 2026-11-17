import { Controller, Get } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Access } from '../src/identity/permissions';
import { hotp, totpStep } from '../src/identity/totp';
import { browser, createTestApp, type TestApp } from './helpers';

/** A staff-only route, to check that 2FA unlocks staff permissions. */
@Controller('probe')
class ProbeController {
  @Get('content')
  @Access('content:author')
  content() {
    return { reached: true };
  }
}

const PHONE = '+998901234567';
const PASSWORD = 'quiet-river-71-lamp';
const MINUTE = 60_000;
const STEP_MS = 30_000;

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp([ProbeController]);
});

afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code an authenticator app would show now, with an optional step offset. */
function codeFor(secret: Buffer, offset = 0): string {
  return hotp(secret, totpStep(t.clock.now()) + offset);
}

/** Creates a parent account, then makes it an author, as an admin would. */
async function createStaff(): Promise<string> {
  const otp = await http().post('/api/v1/auth/otp').send({ phone: PHONE, purpose: 'signup' });
  const verified = await http()
    .post('/api/v1/auth/otp/verify')
    .send({ challengeId: otp.body.challengeId, code: t.sms.lastCode(PHONE) });
  const reg = await http()
    .post('/api/v1/auth/register')
    .set('X-Client-Type', 'mobile')
    .send({
      registrationToken: verified.body.registrationToken,
      firstName: 'Nodira',
      password: PASSWORD,
      role: 'parent',
      acceptedTermsVersion: '2026-11',
    })
    .expect(201);
  await t.db
    .insertInto('user_roles')
    .values({ user_id: reg.body.userId, role: 'author' })
    .execute();
  return reg.body.userId as string;
}

async function login(): Promise<{
  accessToken: string;
  refreshToken: string;
  mfaRequired: boolean;
}> {
  const res = await http()
    .post('/api/v1/auth/login')
    .set('X-Client-Type', 'mobile')
    .send({ phone: PHONE, password: PASSWORD })
    .expect(200);
  return res.body;
}

async function enrol(token: string): Promise<{ factorId: string; secret: Buffer; uri: string }> {
  const res = await http()
    .post('/api/v1/auth/mfa/totp')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  const uri = new URL(res.body.otpauthUri as string);
  return {
    factorId: res.body.factorId,
    secret: base32Decode(uri.searchParams.get('secret')!),
    uri: res.body.otpauthUri,
  };
}

function verify(token: string, body: Record<string, unknown>) {
  return http()
    .post('/api/v1/auth/mfa/verify')
    .set('X-Client-Type', 'mobile')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

/** Staff account with a confirmed authenticator; returns the secret and recovery codes. */
async function enrolledStaff() {
  await createStaff();
  const session = await login();
  const { factorId, secret } = await enrol(session.accessToken);
  const res = await verify(session.accessToken, { factorId, code: codeFor(secret) }).expect(200);
  return { secret, recoveryCodes: res.body.recoveryCodes as string[] };
}

describe('TOTP enrolment (C-08)', () => {
  it('confirms the authenticator, returns recovery codes once and unlocks staff permissions', async () => {
    await createStaff();
    const session = await login();
    expect(session.mfaRequired).toBe(true);
    await http()
      .get('/api/v1/probe/content')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(403);

    const { factorId, secret, uri } = await enrol(session.accessToken);
    expect(uri).toMatch(/^otpauth:\/\/totp\/MathPath%3A/);
    expect(uri).not.toContain('901234567');

    const res = await verify(session.accessToken, { factorId, code: codeFor(secret) }).expect(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(res.body.recoveryCodes[0]).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(res.body.session.mfaRequired).toBe(false);
    await http()
      .get('/api/v1/probe/content')
      .set('Authorization', `Bearer ${res.body.session.accessToken}`)
      .expect(200);

    // The new refresh token carries the verified session forward.
    const refreshed = await http()
      .post('/api/v1/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refreshToken: res.body.session.refreshToken })
      .expect(200);
    expect(refreshed.body.mfaRequired).toBe(false);
  });

  it('stores the secret encrypted, never in clear', async () => {
    await createStaff();
    const session = await login();
    const { factorId, secret } = await enrol(session.accessToken);
    const row = await t.db
      .selectFrom('mfa_factors')
      .select('secret')
      .where('id', '=', factorId)
      .executeTakeFirstOrThrow();
    expect(Buffer.from(row.secret).includes(secret)).toBe(false);
  });

  it('discards an enrolment that is not confirmed in time', async () => {
    await createStaff();
    const session = await login();
    const { factorId, secret } = await enrol(session.accessToken);
    t.clock.advance(16 * MINUTE);
    // The access token has expired by now too; a refresh gives a new one.
    const refreshed = await http()
      .post('/api/v1/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refreshToken: session.refreshToken })
      .expect(200);
    const res = await verify(refreshed.body.accessToken, { factorId, code: codeFor(secret) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MFA_CODE_INVALID');
  });

  it('does not let a password alone replace an existing authenticator', async () => {
    await enrolledStaff();
    t.clock.advance(MINUTE);
    const fresh = await login();
    const res = await http()
      .post('/api/v1/auth/mfa/totp')
      .set('Authorization', `Bearer ${fresh.accessToken}`)
      .expect(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
  });

  it('asks anonymous callers to sign in', async () => {
    await http().post('/api/v1/auth/mfa/totp').expect(401);
  });
});

describe('2FA at sign-in', () => {
  it('accepts the current code once and refuses it again (replay, C-08)', async () => {
    const { secret } = await enrolledStaff();
    t.clock.advance(STEP_MS);
    const first = await login();
    const code = codeFor(secret);
    await verify(first.accessToken, { code }).expect(200);

    const second = await login();
    const replay = await verify(second.accessToken, { code });
    expect(replay.status).toBe(401);
    // The next step's code works.
    t.clock.advance(STEP_MS);
    const res = await verify(second.accessToken, { code: codeFor(secret) }).expect(200);
    expect(res.body.recoveryCodes).toBeUndefined();
  });

  it('accepts each recovery code once, ignoring case and dashes', async () => {
    const { recoveryCodes } = await enrolledStaff();
    const session = await login();
    const typed = recoveryCodes[0]!.toLowerCase().replace('-', ' ');
    await verify(session.accessToken, { recoveryCode: typed }).expect(200);
    const again = await login();
    await verify(again.accessToken, { recoveryCode: recoveryCodes[0] }).expect(401);
    await verify(again.accessToken, { recoveryCode: recoveryCodes[1] }).expect(200);
  });

  it('limits wrong codes per user and audits them', async () => {
    const { secret } = await enrolledStaff();
    const session = await login();
    for (let i = 0; i < 5; i++) {
      await verify(session.accessToken, { code: '000000' }).expect(401);
    }
    const res = await verify(session.accessToken, { code: codeFor(secret, 1) });
    expect(res.status).toBe(429);
    const failures = await t.db
      .selectFrom('audit_log')
      .select('id')
      .where('action', '=', 'auth.mfa_failed')
      .execute();
    expect(failures).toHaveLength(5);
  });

  it('refuses a recovery code before any authenticator is confirmed', async () => {
    await createStaff();
    const session = await login();
    await verify(session.accessToken, { recoveryCode: 'ABCDE-FGHJK' }).expect(401);
  });

  it('rejects a body with both a code and a recovery code', async () => {
    await createStaff();
    const session = await login();
    await verify(session.accessToken, { code: '123456', recoveryCode: 'ABCDE-FGHJK' }).expect(400);
  });
});

describe('staff session lifetime (C-08)', () => {
  it('ends a staff session after 30 idle minutes', async () => {
    await createStaff();
    const session = await login();
    t.clock.advance(31 * MINUTE);
    const res = await http()
      .post('/api/v1/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');
  });

  it('ends a staff session after 8 hours even when active', async () => {
    await createStaff();
    let { refreshToken } = await login();
    for (let i = 0; i < 25; i++) {
      t.clock.advance(20 * MINUTE);
      const res = await http()
        .post('/api/v1/auth/refresh')
        .set('X-Client-Type', 'mobile')
        .send({ refreshToken });
      if (res.status !== 200) {
        expect(i).toBe(24); // 500 minutes: past the 8-hour limit
        return;
      }
      refreshToken = res.body.refreshToken;
    }
    throw new Error('the staff session outlived 8 hours');
  });

  it('keeps a family session alive across idle time', async () => {
    await createStaff();
    await t.db.deleteFrom('user_roles').where('role', '=', 'author').execute();
    const session = await login();
    t.clock.advance(3 * 60 * MINUTE);
    await http()
      .post('/api/v1/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refreshToken: session.refreshToken })
      .expect(200);
  });
});
