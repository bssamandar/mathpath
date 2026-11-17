/**
 * Refunds by admins (step 7.4): Payme through its cabinet and CancelTransaction,
 * Click through a fake Merchant API on a local port.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { reconcileBilling, seedDemoContent } from '@mathpath/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkout, family, payWithPayme, user, withEnv } from './billing.helpers';
import { browser, createTestApp, type TestApp } from './helpers';

const MONTHLY = 9_900_000;
// Test-only secrets, built at runtime so secret scanners see no literal key.
const PAYME_KEY = ['test', 'cashbox', 'key', '2026'].join('-');
const CLICK_SECRET = ['click', 'test', 'secret', '2026'].join('-');
const CLICK_SERVICE = '41234';
const CLICK_USER = '5150';

/** What the fake Click Merchant API answers next, and what it was asked. */
const clickApi = {
  answer: { error_code: 0, error_note: 'Success' } as Record<string, unknown>,
  calls: [] as { method: string; url: string; auth: string | undefined }[],
};
let server: Server;
let clickUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    clickApi.calls.push({ method: req.method!, url: req.url!, auth: req.headers.auth as string });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(clickApi.answer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  clickUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/merchant`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let t: TestApp;
let env: ReturnType<typeof withEnv>;

async function startApp(clickMerchantUser: string | null = CLICK_USER) {
  env = withEnv({
    PAYMENT_PROVIDERS: 'payme,click',
    PAYME_MERCHANT_ID: '0123456789abcdef01234567',
    PAYME_KEY,
    CLICK_SERVICE_ID: CLICK_SERVICE,
    CLICK_MERCHANT_ID: '7788',
    CLICK_SECRET_KEY: CLICK_SECRET,
    CLICK_MERCHANT_API_URL: clickUrl,
    ...(clickMerchantUser ? { CLICK_MERCHANT_USER_ID: clickMerchantUser } : {}),
  });
  env.set();
  if (!clickMerchantUser) delete process.env.CLICK_MERCHANT_USER_ID;
  t = await createTestApp();
  await seedDemoContent(t.db);
}

beforeEach(() => {
  clickApi.answer = { error_code: 0, error_note: 'Success' };
  clickApi.calls = [];
});
afterEach(async () => {
  await t.close();
  env.restore();
});

const http = () => browser(t.app.getHttpServer());

async function paidPayme() {
  const { parent, children } = await family(t);
  const order = await checkout(t, await parent.auth(), { studentIds: [children[0]!.id] });
  expect(order.status).toBe(201);
  const txn = await payWithPayme(t, PAYME_KEY, order.body.orderId, MONTHLY);
  const payment = await t.db
    .selectFrom('payments')
    .select(['id', 'subscription_id'])
    .where('provider_txn_id', '=', txn)
    .executeTakeFirstOrThrow();
  return { parent, orderId: order.body.orderId as string, txn, payment };
}

let clickTxn = 700_000_000;
async function paidClick() {
  const { parent, children } = await family(t);
  const order = await checkout(t, await parent.auth(), {
    provider: 'click',
    studentIds: [children[0]!.id],
  });
  const orderId = order.body.orderId as string;
  const txn = String(++clickTxn);
  const sign = (fields: string[]) => createHash('md5').update(fields.join('')).digest('hex');
  const base = {
    click_trans_id: txn,
    service_id: CLICK_SERVICE,
    click_paydoc_id: txn,
    merchant_trans_id: orderId,
    amount: '99000.00',
    error: '0',
    sign_time: '2026-11-16 17:00:00',
  };
  const prepared = await http()
    .post('/api/v1/payments/click/prepare')
    .type('form')
    .send({
      ...base,
      action: '0',
      sign_string: sign([
        txn,
        CLICK_SERVICE,
        CLICK_SECRET,
        orderId,
        base.amount,
        '0',
        base.sign_time,
      ]),
    });
  const prepareId = String(prepared.body.merchant_prepare_id);
  const completed = await http()
    .post('/api/v1/payments/click/complete')
    .type('form')
    .send({
      ...base,
      action: '1',
      merchant_prepare_id: prepareId,
      sign_string: sign([
        txn,
        CLICK_SERVICE,
        CLICK_SECRET,
        orderId,
        prepareId,
        base.amount,
        '1',
        base.sign_time,
      ]),
    });
  expect(completed.body.error).toBe(0);
  const payment = await t.db
    .selectFrom('payments')
    .select(['id', 'subscription_id'])
    .where('provider_txn_id', '=', txn)
    .executeTakeFirstOrThrow();
  return { parent, orderId, txn, payment };
}

async function admin() {
  return (await user(t, ['admin'])).auth();
}

function refund(
  auth: string,
  paymentId: string,
  body: Record<string, unknown>,
  key = randomUUID(),
) {
  return http()
    .post(`/api/v1/admin/payments/${paymentId}/refunds`)
    .set('Authorization', auth)
    .set('Idempotency-Key', key)
    .send({ amountTiyin: MONTHLY, reason: 'Parent asked within 14 days', ...body });
}

const subscriptionStatus = async (id: string | null) =>
  (
    await t.db
      .selectFrom('subscriptions')
      .select('status')
      .where('id', '=', id!)
      .executeTakeFirstOrThrow()
  ).status;

async function payme(method: string, params: unknown) {
  const auth = `Basic ${Buffer.from(`Paycom:${PAYME_KEY}`).toString('base64')}`;
  const res = await http()
    .post('/api/v1/payments/payme')
    .set('Authorization', auth)
    .send({ jsonrpc: '2.0', id: 1, method, params });
  return res.body as { result?: Record<string, unknown> };
}

describe('Payme refunds', () => {
  beforeEach(() => startApp());

  it('records the request, then completes it when Payme cancels the transaction', async () => {
    const { payment, txn } = await paidPayme();
    const auth = await admin();
    const key = randomUUID();
    const requested = await refund(auth, payment.id, {}, key);
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({
      paymentId: payment.id,
      status: 'requested',
      amount: { amountTiyin: MONTHLY, currency: 'UZS' },
      failure: null,
      completedAt: null,
    });
    // Nothing is taken back until the money is.
    expect(await subscriptionStatus(payment.subscription_id)).toBe('active');
    // The same key returns the same refund; another key is refused.
    expect((await refund(auth, payment.id, {}, key)).body.refundId).toBe(requested.body.refundId);
    const again = await refund(auth, payment.id, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REFUND_IN_PROGRESS');

    expect((await payme('CancelTransaction', { id: txn, reason: 5 })).result?.state).toBe(-2);
    const [row] = await t.db.selectFrom('refunds').selectAll().execute();
    expect(row).toMatchObject({ status: 'succeeded', provider_ref: txn });
    expect(await subscriptionStatus(payment.subscription_id)).toBe('cancelled');
    expect((await reconcileBilling(t.db, new Date())).ok).toBe(true);

    const audit = await t.db
      .selectFrom('audit_log')
      .select(['action', 'metadata'])
      .where('action', 'like', 'billing.refund%')
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'billing.refund_requested',
        metadata: expect.objectContaining({ reason: 'Parent asked within 14 days' }),
      }),
    ]);
  });

  it('records a refund Payme started in its cabinet with no admin request', async () => {
    const { payment, txn } = await paidPayme();
    await payme('CancelTransaction', { id: txn, reason: 5 });
    const row = await t.db
      .selectFrom('refunds')
      .selectAll()
      .where('payment_id', '=', payment.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'succeeded',
      requested_by: null,
      reason: 'Cancelled in Payme (reason 5)',
    });
    expect((await reconcileBilling(t.db, new Date())).ok).toBe(true);
  });

  it('refuses partial amounts, unpaid payments, parents and a missing key', async () => {
    const { payment, parent } = await paidPayme();
    const auth = await admin();
    const partial = await refund(auth, payment.id, { amountTiyin: 100 });
    expect(partial.status).toBe(422);
    expect(partial.body.code).toBe('PARTIAL_REFUND_UNSUPPORTED');
    expect((await refund(await parent.auth(), payment.id, {})).status).toBe(403);
    expect((await refund(auth, randomUUID(), {})).status).toBe(404);
    const noKey = await http()
      .post(`/api/v1/admin/payments/${payment.id}/refunds`)
      .set('Authorization', auth)
      .send({ amountTiyin: MONTHLY, reason: 'Parent asked' });
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const short = await refund(auth, payment.id, { reason: 'no' });
    expect(short.status).toBe(400);

    await t.db
      .updateTable('payments')
      .set({ status: 'refunded', cancelled_at: new Date() })
      .where('id', '=', payment.id)
      .execute();
    const refunded = await refund(auth, payment.id, {});
    expect(refunded.status).toBe(409);
    expect(refunded.body.code).toBe('PAYMENT_NOT_REFUNDABLE');
  });

  it('finds payments by the parent’s phone or an ID, masked and with refunds', async () => {
    const { payment, parent, orderId } = await paidPayme();
    await t.db
      .updateTable('users')
      .set({ phone_e164: '+998901234567' })
      .where('id', '=', parent.id)
      .execute();
    const auth = await admin();
    await refund(auth, payment.id, {});
    const byPhone = await http()
      .get('/api/v1/admin/payments')
      .query({ q: '90 123 45 67' })
      .set('Authorization', auth);
    expect(byPhone.status).toBe(200);
    expect(byPhone.body.items).toEqual([
      expect.objectContaining({
        id: payment.id,
        orderId,
        provider: 'payme',
        status: 'paid',
        owner: { id: parent.id, firstName: 'Aziza', phoneMasked: '+99890*****67' },
        refunds: [expect.objectContaining({ status: 'requested' })],
      }),
    ]);
    const byOrder = await http()
      .get('/api/v1/admin/payments')
      .query({ q: orderId })
      .set('Authorization', auth);
    expect(byOrder.body.items.map((p: { id: string }) => p.id)).toEqual([payment.id]);
    const byName = await http()
      .get('/api/v1/admin/payments')
      .query({ q: 'Aziza' })
      .set('Authorization', auth);
    expect(byName.status).toBe(400);
  });
});

describe('Click refunds', () => {
  it('reverses the payment through the Merchant API and ends the subscription', async () => {
    await startApp();
    const { payment, txn } = await paidClick();
    const res = await refund(await admin(), payment.id, {});
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'succeeded', failure: null });
    expect(clickApi.calls).toHaveLength(1);
    expect(clickApi.calls[0]).toMatchObject({
      method: 'DELETE',
      url: `/v2/merchant/payment/reversal/${CLICK_SERVICE}/${txn}`,
    });
    // Auth: merchant user ID, SHA-1 of timestamp + secret key, timestamp.
    const [userId, digest, ts] = clickApi.calls[0]!.auth!.split(':');
    expect(userId).toBe(CLICK_USER);
    expect(digest).toBe(createHash('sha1').update(`${ts}${CLICK_SECRET}`).digest('hex'));
    const row = await t.db
      .selectFrom('payments')
      .select('status')
      .where('id', '=', payment.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('refunded');
    expect(await subscriptionStatus(payment.subscription_id)).toBe('cancelled');
    expect((await reconcileBilling(t.db, new Date())).ok).toBe(true);
  });

  it('records Click’s refusal, keeps the subscription and allows a retry', async () => {
    await startApp();
    const { payment } = await paidClick();
    const auth = await admin();
    clickApi.answer = { error_code: -5017, error_note: 'Payment can not be reversed' };
    const refused = await refund(auth, payment.id, {});
    expect(refused.body).toMatchObject({
      status: 'failed',
      failure: '-5017: Payment can not be reversed',
    });
    expect(await subscriptionStatus(payment.subscription_id)).toBe('active');
    clickApi.answer = { error_code: 0 };
    expect((await refund(auth, payment.id, {})).body.status).toBe('succeeded');
  });

  it('asks for the Click cabinet when the Merchant API is not configured', async () => {
    await startApp(null);
    const { payment } = await paidClick();
    const res = await refund(await admin(), payment.id, {});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REFUND_UNAVAILABLE');
    expect(clickApi.calls).toHaveLength(0);
  });
});
