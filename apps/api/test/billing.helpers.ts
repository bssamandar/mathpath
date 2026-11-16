/** Shared by the billing and provider e2e tests: users, families and checkout. */
import { newId, type Role } from '@mathpath/db';
import { randomUUID } from 'node:crypto';
import { SessionService } from '../src/identity/session.service';
import { browser, type TestApp } from './helpers';

const client = {
  ipPrefix: null,
  userAgentSummary: null,
  requestId: null,
  automationSuspected: false,
};

export async function user(t: TestApp, roles: Role[]) {
  const id = newId();
  await t.db.insertInto('users').values({ id, first_name: 'Aziza' }).execute();
  await t.db
    .insertInto('user_roles')
    .values(roles.map((role) => ({ user_id: id, role })))
    .execute();
  const staff = roles.some((r) => r !== 'student' && r !== 'parent');
  const auth = async () => {
    const sessions = t.app.get(SessionService);
    const started = await sessions.start(id, client, 'password');
    // Staff permissions count only after 2FA, so staff sessions are elevated.
    return `Bearer ${(staff ? await sessions.elevate(started.sessionId) : started).accessToken}`;
  };
  return { id, auth };
}

/** A parent with `n` linked children. */
export async function family(t: TestApp, n = 1) {
  const parent = await user(t, ['parent']);
  const children = [];
  for (let i = 0; i < n; i++) {
    const child = await user(t, ['student']);
    await t.db
      .insertInto('student_profiles')
      .values({
        user_id: child.id,
        nickname: `kid${i}`,
        grade: 5,
        birth_year: null,
        avatar_code: null,
        pin_hash: 'not-used',
        daily_time_limit_min: null,
      })
      .execute();
    const consent = newId();
    await t.db
      .insertInto('consents')
      .values({
        id: consent,
        parent_id: parent.id,
        child_id: child.id,
        policy_version: 'test',
        scopes: ['learning'],
        method: 'otp_confirmed',
      })
      .execute();
    await t.db
      .insertInto('parent_child_links')
      .values({ parent_id: parent.id, child_id: child.id, consent_id: consent })
      .execute();
    children.push(child);
  }
  return { parent, children };
}

export function checkout(
  t: TestApp,
  auth: string,
  body: Record<string, unknown>,
  key: string | null = randomUUID(),
) {
  const req = browser(t.app.getHttpServer()).post('/api/v1/checkout').set('Authorization', auth);
  if (key) req.set('Idempotency-Key', key);
  return req.send({ planCode: 'individual_monthly', provider: 'payme', ...body });
}

/** Sets environment variables for a test file and restores them afterwards. */
export function withEnv(values: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  return {
    set() {
      for (const [k, v] of Object.entries(values)) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
    },
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** Creates and performs a Payme transaction for an order, as Payme would. */
export async function payWithPayme(t: TestApp, key: string, orderId: string, amount: number) {
  const auth = `Basic ${Buffer.from(`Paycom:${key}`).toString('base64')}`;
  const txn = randomUUID().replaceAll('-', '').slice(0, 24);
  const call = async (method: string, params: unknown) =>
    (
      await browser(t.app.getHttpServer())
        .post('/api/v1/payments/payme')
        .set('Authorization', auth)
        .send({ jsonrpc: '2.0', id: 1, method, params })
    ).body as { result?: Record<string, unknown>; error?: { code: number } };
  const created = await call('CreateTransaction', {
    id: txn,
    time: t.clock.now().getTime(),
    amount,
    account: { order_id: orderId },
  });
  if (!created.result) throw new Error(`CreateTransaction failed: ${JSON.stringify(created)}`);
  const performed = await call('PerformTransaction', { id: txn });
  if (!performed.result) throw new Error(`PerformTransaction failed: ${JSON.stringify(performed)}`);
  return txn;
}
