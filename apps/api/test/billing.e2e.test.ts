import { DEMO_IDS, newId, type Role, seedDemoContent } from '@mathpath/db';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TRANSACTION_TIMEOUT_MS } from '../src/billing/payme/payme';
import {
  checkout as checkoutOf,
  family as familyOf,
  user as userOf,
  withEnv,
} from './billing.helpers';
import { browser, createTestApp, type TestApp } from './helpers';

const MERCHANT = '0123456789abcdef01234567';
// Test-only cashbox key: built at runtime so secret scanners see no literal key.
const KEY = ['test', 'cashbox', 'key', '2026'].join('-');
const PAYME_AUTH = `Basic ${Buffer.from(`Paycom:${KEY}`).toString('base64')}`;
const PAID_TOPIC = DEMO_IDS.topics[1];
const MONTHLY = 9_900_000;

let t: TestApp;
const env = withEnv({ PAYMENT_PROVIDERS: 'payme', PAYME_MERCHANT_ID: MERCHANT, PAYME_KEY: KEY });

beforeAll(() => env.set());
afterAll(() => env.restore());
beforeEach(async () => {
  t = await createTestApp();
  await seedDemoContent(t.db);
});
afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());
const user = (roles: Role[]) => userOf(t, roles);
const family = (n = 1) => familyOf(t, n);
const checkout = (auth: string, body: Record<string, unknown>, key?: string | null) =>
  checkoutOf(t, auth, body, key);

let rpcId = 0;
async function payme(method: string, params: unknown, auth: string | null = PAYME_AUTH) {
  const req = http().post('/api/v1/payments/payme');
  if (auth) req.set('Authorization', auth);
  const res = await req.send({ jsonrpc: '2.0', id: ++rpcId, method, params }).expect(200);
  return res.body as {
    id: number;
    result?: Record<string, unknown>;
    error?: { code: number; message: Record<string, string>; data?: string };
  };
}

async function orderFor(auth: string, studentIds: string[], planCode = 'individual_monthly') {
  const res = await checkout(auth, { studentIds, planCode });
  expect(res.status).toBe(201);
  return res.body as { orderId: string; amount: { amountTiyin: number }; redirectUrl: string };
}

async function pay(
  orderId: string,
  amount = MONTHLY,
  txn = randomUUID().replaceAll('-', '').slice(0, 24),
) {
  const created = await payme('CreateTransaction', {
    id: txn,
    time: t.clock.now().getTime(),
    amount,
    account: { order_id: orderId },
  });
  expect(created.result).toMatchObject({ state: 1 });
  const performed = await payme('PerformTransaction', { id: txn });
  expect(performed.result).toMatchObject({ state: 2 });
  return txn;
}

const lessonStatus = async (auth: string) =>
  (await http().get(`/api/v1/topics/${PAID_TOPIC}/lesson`).set('Authorization', auth)).status;

describe('plans and checkout', () => {
  it('lists plans publicly, with prices in tiyin from config', async () => {
    const res = await http().get('/api/v1/plans').expect(200);
    expect(res.body.items[0]).toMatchObject({
      code: 'individual_monthly',
      interval: 'month',
      price: { amountTiyin: MONTHLY, currency: 'UZS' },
      maxStudents: 1,
    });
  });

  it('creates one order per key and sends the parent to Payme', async () => {
    const { parent, children } = await family();
    const auth = await parent.auth();
    const key = randomUUID();
    const body = {
      studentIds: [children[0]!.id],
      returnUrl: 'http://localhost:3000/parent/billing?done=1',
    };
    const first = await checkout(auth, body, key);
    const again = await checkout(auth, body, key);
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.body.orderId).toBe(first.body.orderId);
    expect(first.body.amount).toEqual({ amountTiyin: MONTHLY, currency: 'UZS' });

    const url = new URL(first.body.redirectUrl as string);
    expect(url.origin).toBe('https://checkout.test.paycom.uz');
    const params = Buffer.from(url.pathname.slice(1), 'base64').toString();
    expect(params).toBe(
      `m=${MERCHANT};ac.order_id=${first.body.orderId};a=${MONTHLY};l=uz;c=${body.returnUrl}`,
    );
    const status = await http()
      .get(`/api/v1/orders/${first.body.orderId}`)
      .set('Authorization', auth)
      .expect(200);
    expect(status.body).toMatchObject({ status: 'created' });
  });

  it('refuses bad checkouts', async () => {
    const { parent, children } = await family(2);
    const auth = await parent.auth();
    const child = children[0]!.id;
    expect((await checkout(auth, { studentIds: [child] }, null)).body.code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    expect((await checkout(auth, { studentIds: [child], planCode: 'gold' })).body.code).toBe(
      'PLAN_NOT_FOUND',
    );
    expect((await checkout(auth, { studentIds: [child], provider: 'click' })).body.code).toBe(
      'PROVIDER_UNAVAILABLE',
    );
    expect((await checkout(auth, { studentIds: [child], promoCode: 'SALE' })).body.code).toBe(
      'PROMO_INVALID',
    );
    expect(
      (await checkout(auth, { studentIds: [child], returnUrl: 'https://evil.example/x' })).body
        .code,
    ).toBe('RETURN_URL_NOT_ALLOWED');
    expect((await checkout(auth, { studentIds: children.map((c) => c.id) })).status).toBe(409);
    const stranger = await user(['student']);
    expect((await checkout(auth, { studentIds: [stranger.id] })).body.code).toBe(
      'STUDENT_NOT_FOUND',
    );
    // Children cannot buy, and another parent cannot read the order.
    expect((await checkout(await children[0]!.auth(), { studentIds: [child] })).status).toBe(403);
    const order = await orderFor(auth, [child]);
    const other = await family();
    await http()
      .get(`/api/v1/orders/${order.orderId}`)
      .set('Authorization', await other.parent.auth())
      .expect(404);
  });
});

describe('Payme Merchant API', () => {
  it('refuses calls without the cashbox key before reading them', async () => {
    const { parent, children } = await family();
    const order = await orderFor(await parent.auth(), [children[0]!.id]);
    const params = { amount: MONTHLY, account: { order_id: order.orderId } };
    for (const auth of [null, 'Basic ' + Buffer.from('Paycom:wrong').toString('base64')]) {
      const res = await payme('CheckPerformTransaction', params, auth);
      expect(res.error?.code).toBe(-32504);
      expect(res.result).toBeUndefined();
    }
    const logged = await t.db
      .selectFrom('payment_callbacks')
      .select(['auth_valid', 'payload'])
      .execute();
    expect(logged).toEqual([
      { auth_valid: false, payload: {} },
      { auth_valid: false, payload: {} },
    ]);
  });

  it('checks the order and the amount', async () => {
    const { parent, children } = await family();
    const order = await orderFor(await parent.auth(), [children[0]!.id]);
    const check = (amount: number, orderId: string) =>
      payme('CheckPerformTransaction', { amount, account: { order_id: orderId } });
    expect((await check(MONTHLY, order.orderId)).result).toEqual({ allow: true });
    expect((await check(MONTHLY - 100, order.orderId)).error?.code).toBe(-31001);
    expect((await check(MONTHLY, newId())).error).toMatchObject({ code: -31050, data: 'order_id' });
    expect((await check(MONTHLY, 'not-an-order')).error?.code).toBe(-31050);
    expect((await payme('CheckPerformTransaction', { amount: 'x' })).error?.code).toBe(-32600);
    expect((await payme('Explode', {})).error?.code).toBe(-32601);

    t.clock.advance(61 * 60 * 1000); // orderExpiresMinutes
    expect((await check(MONTHLY, order.orderId)).error?.code).toBe(-31051);
  });

  it('pays an order once, opens paid topics, and answers repeats the same way', async () => {
    const { parent, children } = await family();
    const auth = await parent.auth();
    const child = children[0]!;
    expect(await lessonStatus(await child.auth())).toBe(402);

    const order = await orderFor(auth, [child.id]);
    const txn = 'a1b2c3d4e5f6a1b2c3d4e5f6';
    const params = {
      id: txn,
      time: t.clock.now().getTime(),
      amount: MONTHLY,
      account: { order_id: order.orderId },
    };
    const created = await payme('CreateTransaction', params);
    expect(created.result).toMatchObject({ state: 1, transaction: expect.any(String) });
    expect((await payme('CreateTransaction', params)).result).toEqual(created.result);
    // A second Payme transaction for the same order is refused while the first is open.
    const other = await payme('CreateTransaction', { ...params, id: 'ffffffffffffffffffffffff' });
    expect(other.error?.code).toBe(-31052);

    t.clock.advance(5_000);
    const performed = await payme('PerformTransaction', { id: txn });
    expect(performed.result).toMatchObject({ state: 2, transaction: created.result!.transaction });
    t.clock.advance(5_000);
    expect((await payme('PerformTransaction', { id: txn })).result).toEqual(performed.result);
    expect((await payme('CreateTransaction', params)).error?.code).toBe(-31008);

    const checked = await payme('CheckTransaction', { id: txn });
    expect(checked.result).toMatchObject({
      state: 2,
      perform_time: performed.result!.perform_time,
      cancel_time: 0,
      reason: null,
    });

    expect(await lessonStatus(await child.auth())).toBe(200);
    const status = await http().get(`/api/v1/orders/${order.orderId}`).set('Authorization', auth);
    expect(status.body).toMatchObject({
      status: 'paid',
      subscription: { planCode: 'individual_monthly', status: 'active', studentIds: [child.id] },
    });
    const events = await t.db.selectFrom('outbox_events').select('event_type').execute();
    expect(events.map((e) => e.event_type)).toContain('PaymentSucceeded');

    const statement = await payme('GetStatement', { from: 0, to: t.clock.now().getTime() });
    expect(statement.result!.transactions).toEqual([
      expect.objectContaining({
        id: txn,
        amount: MONTHLY,
        state: 2,
        account: { order_id: order.orderId },
      }),
    ]);
  });

  it('cancels before perform, and refunds after perform by ending access', async () => {
    const { parent, children } = await family();
    const auth = await parent.auth();
    const child = children[0]!;

    const first = await orderFor(auth, [child.id]);
    const txn = 'cccccccccccccccccccccccc';
    await payme('CreateTransaction', {
      id: txn,
      time: t.clock.now().getTime(),
      amount: MONTHLY,
      account: { order_id: first.orderId },
    });
    const cancelled = await payme('CancelTransaction', { id: txn, reason: 3 });
    expect(cancelled.result).toMatchObject({ state: -1 });
    expect((await payme('CancelTransaction', { id: txn, reason: 3 })).result).toEqual(
      cancelled.result,
    );
    expect((await payme('PerformTransaction', { id: txn })).error?.code).toBe(-31008);
    const order = await http().get(`/api/v1/orders/${first.orderId}`).set('Authorization', auth);
    expect(order.body.status).toBe('cancelled');

    const second = await orderFor(auth, [child.id]);
    const paid = await pay(second.orderId);
    expect(await lessonStatus(await child.auth())).toBe(200);
    const refund = await payme('CancelTransaction', { id: paid, reason: 5 });
    expect(refund.result).toMatchObject({ state: -2 });
    expect((await payme('CheckTransaction', { id: paid })).result).toMatchObject({
      state: -2,
      reason: 5,
    });
    expect(await lessonStatus(await child.auth())).toBe(402);
    const subs = await http().get('/api/v1/subscriptions').set('Authorization', auth).expect(200);
    expect(subs.body.items[0]).toMatchObject({ status: 'cancelled' });
    expect((await payme('CheckTransaction', { id: 'nope' })).error?.code).toBe(-31003);
  });

  it('cancels a transaction that waited longer than 12 hours (reason 4)', async () => {
    const { parent, children } = await family();
    const order = await orderFor(await parent.auth(), [children[0]!.id]);
    const txn = 'dddddddddddddddddddddddd';
    await payme('CreateTransaction', {
      id: txn,
      time: t.clock.now().getTime(),
      amount: MONTHLY,
      account: { order_id: order.orderId },
    });
    t.clock.advance(TRANSACTION_TIMEOUT_MS + 1_000);
    expect((await payme('PerformTransaction', { id: txn })).error?.code).toBe(-31008);
    expect((await payme('CheckTransaction', { id: txn })).result).toMatchObject({
      state: -1,
      reason: 4,
    });
  });

  it('starts a new period where the current one ends, and cancels renewal on request', async () => {
    const { parent, children } = await family();
    const child = children[0]!.id;
    await pay((await orderFor(await parent.auth(), [child])).orderId);
    t.clock.advance(24 * 60 * 60 * 1000);
    // A fresh token: the clock moved past the first one's expiry.
    const auth = await parent.auth();
    await pay((await orderFor(auth, [child])).orderId);
    const rows = await t.db
      .selectFrom('subscriptions')
      .select(['current_period_start', 'current_period_end'])
      .orderBy('current_period_start')
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.current_period_start).toEqual(rows[0]!.current_period_end);

    const subs = await http().get('/api/v1/subscriptions').set('Authorization', auth).expect(200);
    const cancelled = await http()
      .post(`/api/v1/subscriptions/${subs.body.items[0].id}/cancel`)
      .set('Authorization', auth)
      .expect(200);
    expect(cancelled.body).toMatchObject({ cancelAtPeriodEnd: true, status: 'active' });
    const other = await family();
    await http()
      .post(`/api/v1/subscriptions/${subs.body.items[0].id}/cancel`)
      .set('Authorization', await other.parent.auth())
      .expect(404);
  });
});
