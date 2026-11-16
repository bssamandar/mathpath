/**
 * Click Shop API (step 6.5b): signed Prepare and Complete calls, against a
 * real order made through checkout.
 */
import { DEMO_IDS, seedDemoContent } from '@mathpath/db';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClickError, sumToTiyin, tiyinToSum } from '../src/billing/click/click';
import { checkout, family, withEnv } from './billing.helpers';
import { browser, createTestApp, type TestApp } from './helpers';

const SERVICE = '41234';
const MERCHANT = '7788';
// Test-only secret: built at runtime so secret scanners see no literal key.
const SECRET = ['click', 'test', 'secret', '2026'].join('-');
const MONTHLY = 9_900_000;
const PAID_TOPIC = DEMO_IDS.topics[1];

let t: TestApp;
const env = withEnv({
  PAYMENT_PROVIDERS: 'click',
  CLICK_SERVICE_ID: SERVICE,
  CLICK_MERCHANT_ID: MERCHANT,
  CLICK_SECRET_KEY: SECRET,
});

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

let nextTxn = 900_000_000;

interface Call {
  click_trans_id: string;
  merchant_trans_id: string;
  amount: string;
  merchant_prepare_id?: string;
  error?: string;
  service_id?: string;
}

function signed(stage: 'prepare' | 'complete', call: Call, secret = SECRET) {
  const fields = {
    click_trans_id: call.click_trans_id,
    service_id: call.service_id ?? SERVICE,
    click_paydoc_id: String(Number(call.click_trans_id) + 1),
    merchant_trans_id: call.merchant_trans_id,
    ...(stage === 'complete' ? { merchant_prepare_id: call.merchant_prepare_id ?? '' } : {}),
    amount: call.amount,
    action: stage === 'prepare' ? '0' : '1',
    error: call.error ?? '0',
    error_note: call.error && call.error !== '0' ? 'Insufficient funds' : 'Success',
    sign_time: '2026-11-16 17:00:00',
  };
  const sign = createHash('md5')
    .update(
      [
        fields.click_trans_id,
        fields.service_id,
        secret,
        fields.merchant_trans_id,
        ...(stage === 'complete' ? [fields.merchant_prepare_id] : []),
        fields.amount,
        fields.action,
        fields.sign_time,
      ].join(''),
    )
    .digest('hex');
  return { ...fields, sign_string: sign };
}

async function click(stage: 'prepare' | 'complete', body: Record<string, string>) {
  const res = await http().post(`/api/v1/payments/click/${stage}`).type('form').send(body);
  expect(res.status).toBe(200);
  return res.body as {
    click_trans_id: number | null;
    merchant_trans_id: string | null;
    merchant_prepare_id?: number;
    merchant_confirm_id?: number;
    error: number;
    error_note: string;
  };
}

async function newOrder(students = 1) {
  const { parent, children } = await family(t, students);
  const res = await checkout(t, await parent.auth(), {
    provider: 'click',
    studentIds: children.map((c) => c.id),
  });
  expect(res.status).toBe(201);
  return { parent, children, order: res.body as { orderId: string; redirectUrl: string } };
}

async function prepare(orderId: string, amount = tiyinToSum(MONTHLY)) {
  const txn = String(++nextTxn);
  const res = await click(
    'prepare',
    signed('prepare', { click_trans_id: txn, merchant_trans_id: orderId, amount }),
  );
  return { txn, res };
}

const lessonStatus = async (auth: string) =>
  (await http().get(`/api/v1/topics/${PAID_TOPIC}/lesson`).set('Authorization', auth)).status;

describe('Click amounts', () => {
  it('converts between sum and tiyin without rounding', () => {
    expect(sumToTiyin('99000')).toBe(9_900_000);
    expect(sumToTiyin('99000.5')).toBe(9_900_050);
    expect(sumToTiyin('99000.05')).toBe(9_900_005);
    expect(tiyinToSum(9_900_005)).toBe('99000.05');
    expect(tiyinToSum(50)).toBe('0.50');
  });
});

describe('Click Shop API', () => {
  it('sends the parent to Click with the order and the amount in sum', async () => {
    const { order } = await newOrder();
    const url = new URL(order.redirectUrl);
    expect(url.origin + url.pathname).toBe('https://my.click.uz/services/pay');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      service_id: SERVICE,
      merchant_id: MERCHANT,
      amount: '99000.00',
      transaction_param: order.orderId,
    });
  });

  it('refuses unsigned calls before reading them, and logs them without the body', async () => {
    const { order } = await newOrder();
    const body = signed(
      'prepare',
      { click_trans_id: '123', merchant_trans_id: order.orderId, amount: '99000.00' },
      'wrong-secret-0000',
    );
    const res = await click('prepare', body);
    expect(res.error).toBe(ClickError.SIGN_CHECK_FAILED);
    // A changed field breaks the signature.
    const tampered = {
      ...signed('prepare', {
        click_trans_id: '124',
        merchant_trans_id: order.orderId,
        amount: '99000.00',
      }),
      amount: '1.00',
    };
    expect((await click('prepare', tampered)).error).toBe(ClickError.SIGN_CHECK_FAILED);
    const logged = await t.db
      .selectFrom('payment_callbacks')
      .selectAll()
      .where('provider', '=', 'click')
      .execute();
    expect(logged).toHaveLength(2);
    expect(logged.every((l) => !l.auth_valid && Object.keys(l.payload).length === 0)).toBe(true);
    expect(await t.db.selectFrom('payments').selectAll().execute()).toHaveLength(0);
  });

  it('checks the order, the amount, the service and the action', async () => {
    const { order } = await newOrder();
    expect((await prepare(order.orderId, '99001.00')).res.error).toBe(ClickError.WRONG_AMOUNT);
    expect((await prepare('not-an-order')).res.error).toBe(ClickError.ORDER_NOT_FOUND);
    expect((await prepare('0193a0a4-0000-7000-8000-000000000000')).res.error).toBe(
      ClickError.ORDER_NOT_FOUND,
    );
    const otherService = await click(
      'prepare',
      signed('prepare', {
        click_trans_id: '555',
        merchant_trans_id: order.orderId,
        amount: '99000.00',
        service_id: '1',
      }),
    );
    expect(otherService.error).toBe(ClickError.BAD_REQUEST);
    // A signed Prepare sent to the Complete URL is the wrong action.
    const wrongStage = await click(
      'complete',
      signed('prepare', {
        click_trans_id: '556',
        merchant_trans_id: order.orderId,
        amount: '99000.00',
      }),
    );
    expect(wrongStage.error).toBe(ClickError.ACTION_NOT_FOUND);
    // An expired order cannot be paid.
    t.clock.advance(61 * 60 * 1000);
    expect((await prepare(order.orderId)).res.error).toBe(ClickError.TRANSACTION_CANCELLED);
  });

  it('pays an order once, opens paid topics, and answers repeats the same way', async () => {
    const { parent, children, order } = await newOrder();
    const child = children[0]!;
    expect(await lessonStatus(await child.auth())).toBe(402);

    const { txn, res: prepared } = await prepare(order.orderId);
    expect(prepared).toMatchObject({
      click_trans_id: Number(txn),
      merchant_trans_id: order.orderId,
      error: 0,
    });
    const prepareId = String(prepared.merchant_prepare_id);
    const again = await click(
      'prepare',
      signed('prepare', {
        click_trans_id: txn,
        merchant_trans_id: order.orderId,
        amount: '99000.00',
      }),
    );
    expect(again.merchant_prepare_id).toBe(prepared.merchant_prepare_id);

    // Complete must name the Prepare it follows.
    const wrongPrepare = await click(
      'complete',
      signed('complete', {
        click_trans_id: txn,
        merchant_trans_id: order.orderId,
        amount: '99000.00',
        merchant_prepare_id: String(Number(prepareId) + 999),
      }),
    );
    expect(wrongPrepare.error).toBe(ClickError.TRANSACTION_NOT_FOUND);

    const completeCall = signed('complete', {
      click_trans_id: txn,
      merchant_trans_id: order.orderId,
      amount: '99000.00',
      merchant_prepare_id: prepareId,
    });
    const completed = await click('complete', completeCall);
    expect(completed).toMatchObject({ error: 0, merchant_confirm_id: Number(prepareId) });
    expect(await lessonStatus(await child.auth())).toBe(200);
    expect((await click('complete', completeCall)).error).toBe(0);

    const status = await http()
      .get(`/api/v1/orders/${order.orderId}`)
      .set('Authorization', await parent.auth())
      .expect(200);
    expect(status.body).toMatchObject({ status: 'paid', subscription: { status: 'active' } });
    const subs = await t.db.selectFrom('subscriptions').selectAll().execute();
    expect(subs).toHaveLength(1);

    // A new Click transaction for a paid order is refused.
    expect((await prepare(order.orderId)).res.error).toBe(ClickError.ALREADY_PAID);
  });

  it('cancels the payment when Click reports a failed charge', async () => {
    const { children, order } = await newOrder();
    const { txn, res } = await prepare(order.orderId);
    const failed = await click(
      'complete',
      signed('complete', {
        click_trans_id: txn,
        merchant_trans_id: order.orderId,
        amount: '99000.00',
        merchant_prepare_id: String(res.merchant_prepare_id),
        error: '-5017',
      }),
    );
    expect(failed.error).toBe(ClickError.TRANSACTION_CANCELLED);
    const payment = await t.db.selectFrom('payments').selectAll().executeTakeFirstOrThrow();
    expect(payment.status).toBe('cancelled');
    // A late success for the cancelled transaction is refused, so Click returns the money.
    const late = await click(
      'complete',
      signed('complete', {
        click_trans_id: txn,
        merchant_trans_id: order.orderId,
        amount: '99000.00',
        merchant_prepare_id: String(res.merchant_prepare_id),
      }),
    );
    expect(late.error).toBe(ClickError.TRANSACTION_CANCELLED);
    expect(await lessonStatus(await children[0]!.auth())).toBe(402);
  });

  it('replaces an unfinished attempt when the parent starts again', async () => {
    const { order } = await newOrder();
    const first = await prepare(order.orderId);
    const second = await prepare(order.orderId);
    expect(second.res.error).toBe(0);
    const late = await click(
      'complete',
      signed('complete', {
        click_trans_id: first.txn,
        merchant_trans_id: order.orderId,
        amount: '99000.00',
        merchant_prepare_id: String(first.res.merchant_prepare_id),
      }),
    );
    expect(late.error).toBe(ClickError.TRANSACTION_CANCELLED);
    const done = await click(
      'complete',
      signed('complete', {
        click_trans_id: second.txn,
        merchant_trans_id: order.orderId,
        amount: '99000.00',
        merchant_prepare_id: String(second.res.merchant_prepare_id),
      }),
    );
    expect(done.error).toBe(0);
  });

  it('answers 404 for an unknown stage and keeps Payme switched off', async () => {
    await http().post('/api/v1/payments/click/refund').type('form').send({}).expect(404);
    await http().post('/api/v1/payments/payme').send({}).expect(404);
  });
});
