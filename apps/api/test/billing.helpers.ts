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
  const auth = async () =>
    `Bearer ${(await t.app.get(SessionService).start(id, client, 'password')).accessToken}`;
  return { id, auth };
}

/** A parent with `n` linked children. */
export async function family(t: TestApp, n = 1) {
  const parent = await user(t, ['parent']);
  const children = [];
  for (let i = 0; i < n; i++) {
    const child = await user(t, ['student']);
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
