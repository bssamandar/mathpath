import { Controller, Get, Post } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/audit/audit.service';
import { Access, needsMfaFor, permissionsFor } from '../src/identity/permissions';
import { createTestApp, type TestApp } from './helpers';

/** Routes that exist only in this test, to exercise the guard. */
@Controller('probe')
class ProbeController {
  @Get('undeclared')
  undeclared() {
    return { reached: true };
  }

  @Get('family')
  @Access('family:read')
  family() {
    return { reached: true };
  }

  @Get('content')
  @Access('content:author')
  content() {
    return { reached: true };
  }

  @Post('payme')
  @Access('provider:payme')
  payme() {
    return { reached: true };
  }
}

const PHONE = '+998901234567';
const PASSWORD = 'quiet-river-71-lamp';
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp([ProbeController]);
});

afterEach(async () => {
  await t.close();
});

const http = () => request(t.app.getHttpServer());

async function signUp(): Promise<{ token: string; userId: string }> {
  const otp = await http().post('/api/v1/auth/otp').send({ phone: PHONE, purpose: 'signup' });
  const code = t.sms.lastCode(PHONE);
  const verified = await http()
    .post('/api/v1/auth/otp/verify')
    .send({ challengeId: otp.body.challengeId, code });
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
  return { token: reg.body.accessToken, userId: reg.body.userId };
}

describe('permission guard (C-09)', () => {
  it('refuses a route that declares no access, even for signed-in users', async () => {
    const { token } = await signUp();
    await http().get('/api/v1/probe/undeclared').expect(403);
    await http()
      .get('/api/v1/probe/undeclared')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('asks anonymous callers to sign in', async () => {
    const res = await http().get('/api/v1/probe/family').expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('lets a parent use parent permissions and nothing else', async () => {
    const { token } = await signUp();
    await http().get('/api/v1/probe/family').set('Authorization', `Bearer ${token}`).expect(200);
    const res = await http()
      .get('/api/v1/probe/content')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('requires 2FA before staff permissions apply (C-08)', async () => {
    const { userId } = await signUp();
    await t.db.insertInto('user_roles').values({ user_id: userId, role: 'author' }).execute();
    const login = await http()
      .post('/api/v1/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ phone: PHONE, password: PASSWORD })
      .expect(200);
    const res = await http()
      .get('/api/v1/probe/content')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
    // Parent permissions keep working while 2FA is pending.
    await http()
      .get('/api/v1/probe/family')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
  });

  it('refuses payment callbacks until provider signature checks exist', async () => {
    await http().post('/api/v1/probe/payme').expect(401);
  });
});

describe('permissionsFor', () => {
  it('merges roles and drops staff roles without 2FA', () => {
    expect(permissionsFor(['parent', 'admin'], false).has('admin:users')).toBe(false);
    expect(permissionsFor(['parent', 'admin'], true).has('admin:users')).toBe(true);
    expect(permissionsFor(['support'], true).size).toBe(0);
    expect(needsMfaFor(['reviewer'], 'content:publish')).toBe(true);
    expect(needsMfaFor(['parent'], 'content:publish')).toBe(false);
  });
});

describe('audit log (C-33)', () => {
  it('records sign-up, sign-in, failures and logout without phone numbers', async () => {
    const { token, userId } = await signUp();
    await http().post('/api/v1/auth/login').send({ phone: PHONE, password: 'wrong-password-9' });
    await http().post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`).expect(204);

    const rows = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    expect(rows.map((r) => r.action)).toEqual([
      'user.register',
      'auth.login',
      'auth.login_failed',
      'auth.logout',
    ]);
    expect(rows[0]).toMatchObject({ actor_id: userId, target_id: userId });
    expect(rows[2]?.metadata).toEqual({ reason: 'wrong_password' });
    expect(rows.every((r) => r.request_id)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('998901234567');
    expect(await verifyAuditChain(t.db)).toEqual({ ok: true, entries: 4 });
  });

  it('records refresh-token reuse as a security event', async () => {
    await signUp();
    const login = await http()
      .post('/api/v1/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ phone: PHONE, password: PASSWORD });
    const body = { refreshToken: login.body.refreshToken };
    await http().post('/api/v1/auth/refresh').set('X-Client-Type', 'mobile').send(body).expect(200);
    await http().post('/api/v1/auth/refresh').set('X-Client-Type', 'mobile').send(body).expect(401);
    const actions = await t.db.selectFrom('audit_log').select('action').execute();
    expect(actions.map((a) => a.action)).toContain('auth.refresh_token_reused');
  });

  it('detects an edited entry', async () => {
    await signUp();
    expect((await verifyAuditChain(t.db)).ok).toBe(true);
    // Simulates someone with database owner rights bypassing the append-only trigger.
    await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change`.execute(t.db);
    await sql`UPDATE audit_log SET action = 'nothing.happened' WHERE action = 'auth.login'`.execute(
      t.db,
    );
    const check = await verifyAuditChain(t.db);
    expect(check.ok).toBe(false);
    expect(check.brokenAt).toBeDefined();
  });

  it('detects a deleted entry', async () => {
    await signUp();
    await http().post('/api/v1/auth/login').send({ phone: PHONE, password: PASSWORD });
    await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change`.execute(t.db);
    // Removes the first sign-in, leaving a gap in the middle of the chain.
    await sql`DELETE FROM audit_log WHERE id = (
      SELECT id FROM audit_log WHERE action = 'auth.login' ORDER BY created_at LIMIT 1
    )`.execute(t.db);
    expect((await verifyAuditChain(t.db)).ok).toBe(false);
  });
});
