/**
 * Promo codes and free trials (step 6.5c).
 */
import { DEMO_IDS, seedDemoContent } from '@mathpath/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkout, family, payWithPayme, user, withEnv } from './billing.helpers';
import { browser, createTestApp, type TestApp } from './helpers';

const KEY = ['test', 'cashbox', 'key', 'promo'].join('-');
const MONTHLY = 9_900_000;
const PAID_TOPIC = DEMO_IDS.topics[1];
const DAY = 86_400_000;

let t: TestApp;
const env = withEnv({
  PAYMENT_PROVIDERS: 'payme',
  PAYME_MERCHANT_ID: '0123456789abcdef01234567',
  PAYME_KEY: KEY,
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

async function createPromo(body: Record<string, unknown>) {
  const admin = await user(t, ['admin']);
  const now = t.clock.now().getTime();
  return http()
    .post('/api/v1/admin/promo-codes')
    .set('Authorization', await admin.auth())
    .send({
      code: 'spring25',
      discountType: 'percent',
      value: 25,
      validFrom: new Date(now - DAY).toISOString(),
      validTo: new Date(now + 30 * DAY).toISOString(),
      ...body,
    });
}

async function validate(auth: string, code: string, planCode = 'individual_monthly') {
  const res = await http()
    .post('/api/v1/promo-codes/validate')
    .set('Authorization', auth)
    .send({ code, planCode });
  return res;
}

const lessonStatus = async (auth: string) =>
  (await http().get(`/api/v1/topics/${PAID_TOPIC}/lesson`).set('Authorization', auth)).status;

describe('plans', () => {
  it('lists the providers that are on and the trial length', async () => {
    const res = await http().get('/api/v1/plans').expect(200);
    expect(res.body).toMatchObject({ providers: ['payme'], trialDays: 7 });
  });
});

describe('promo codes', () => {
  it('lets only admins create codes, stored upper-case and unique', async () => {
    const { parent } = await family(t);
    await http()
      .post('/api/v1/admin/promo-codes')
      .set('Authorization', await parent.auth())
      .send({})
      .expect(403);
    const created = await createPromo({});
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'SPRING25', value: 25, redemptions: 0 });
    expect((await createPromo({})).body.code).toBe('PROMO_CODE_EXISTS');
    expect((await createPromo({ code: 'TOOBIG', value: 120 })).status).toBe(422);
    expect((await createPromo({ code: 'NOPLAN', planCodes: ['gold'] })).body.code).toBe(
      'PLAN_NOT_FOUND',
    );
  });

  it('prices an order with the code and uses it up only when paid', async () => {
    await createPromo({ maxRedemptions: 1 });
    const { parent, children } = await family(t);
    const auth = await parent.auth();
    const check = await validate(auth, ' spring25 ');
    expect(check.status).toBe(200);
    expect(check.body).toEqual({
      valid: true,
      amount: { amountTiyin: 7_425_000, currency: 'UZS' },
      discount: { amountTiyin: 2_475_000, currency: 'UZS' },
    });

    // An unpaid order does not use the code up.
    const abandoned = await checkout(t, auth, {
      studentIds: [children[0]!.id],
      promoCode: 'SPRING25',
    });
    expect(abandoned.body.amount.amountTiyin).toBe(7_425_000);
    const order = await checkout(t, auth, { studentIds: [children[0]!.id], promoCode: 'spring25' });
    expect(order.status).toBe(201);
    await payWithPayme(t, KEY, order.body.orderId, 7_425_000);
    expect(await lessonStatus(await children[0]!.auth())).toBe(200);

    // The single use is gone, for this parent and for others.
    expect((await validate(auth, 'SPRING25')).body).toEqual({ valid: false, reason: 'used_up' });
    const other = await family(t);
    const refused = await checkout(t, await other.parent.auth(), {
      studentIds: [other.children[0]!.id],
      promoCode: 'SPRING25',
    });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({ field: 'promoCode', message: 'used_up' });

    const admin = await user(t, ['admin']);
    const list = await http()
      .get('/api/v1/admin/promo-codes')
      .set('Authorization', await admin.auth())
      .expect(200);
    expect(list.body.items[0]).toMatchObject({ code: 'SPRING25', redemptions: 1 });
  });

  it('explains why a code does not apply', async () => {
    const now = t.clock.now().getTime();
    await createPromo({ code: 'ANNUAL', planCodes: ['individual_annual'] });
    await createPromo({ code: 'LATER', validFrom: new Date(now + DAY).toISOString() });
    await createPromo({ code: 'HUGE', discountType: 'fixed', value: MONTHLY });
    const created = await createPromo({ code: 'STOPPED' });
    const admin = await user(t, ['admin']);
    await http()
      .post(`/api/v1/admin/promo-codes/${created.body.id}/deactivate`)
      .set('Authorization', await admin.auth())
      .expect(200);
    const { parent } = await family(t);
    let auth = await parent.auth();
    const reason = async (code: string) => (await validate(auth, code)).body.reason;
    expect(await reason('NOPE')).toBe('not_found');
    expect(await reason('ANNUAL')).toBe('plan');
    expect(await reason('LATER')).toBe('not_started');
    expect(await reason('HUGE')).toBe('too_large');
    expect(await reason('STOPPED')).toBe('not_found');
    expect((await validate(auth, 'ANNUAL', 'individual_annual')).body.valid).toBe(true);
    t.clock.advance(31 * DAY);
    auth = await parent.auth(); // the old session token has expired too
    expect(await reason('ANNUAL')).toBe('expired');
  });

  it('limits how often a parent can check codes', async () => {
    const auth = await (await family(t)).parent.auth();
    for (let i = 0; i < 10; i++) expect((await validate(auth, `GUESS${i}`)).status).toBe(200);
    const res = await validate(auth, 'GUESS10');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('free trial', () => {
  const startTrial = async (auth: string, body: Record<string, unknown>) =>
    http().post('/api/v1/trials').set('Authorization', auth).send(body);

  it('opens paid topics for the trial days, once per account and per child', async () => {
    const { parent, children } = await family(t, 2);
    const auth = await parent.auth();
    const before = await http().get('/api/v1/subscriptions').set('Authorization', auth);
    expect(before.body).toEqual({ items: [], trialAvailable: true });

    const res = await startTrial(auth, { studentIds: [children[0]!.id] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      planCode: 'trial',
      status: 'trialing',
      cancelAtPeriodEnd: true,
      studentIds: [children[0]!.id],
    });
    expect(await lessonStatus(await children[0]!.auth())).toBe(200);
    expect(await lessonStatus(await children[1]!.auth())).toBe(402);
    const kids = await http().get('/api/v1/children').set('Authorization', auth).expect(200);
    expect(kids.body.items.map((c: { plan: string }) => c.plan)).toEqual(['trial', 'free']);

    expect((await startTrial(auth, { studentIds: [children[1]!.id] })).body.code).toBe(
      'TRIAL_USED',
    );
    const after = await http().get('/api/v1/subscriptions').set('Authorization', auth);
    expect(after.body.trialAvailable).toBe(false);

    // A second parent of the same child cannot start another trial for them.
    const second = await user(t, ['parent']);
    await t.db
      .insertInto('consents')
      .values({
        id: '0193a0a4-0000-7000-8000-00000000c0de',
        parent_id: second.id,
        child_id: children[0]!.id,
        policy_version: 'test',
        scopes: ['learning'],
        method: 'otp_confirmed',
      })
      .execute();
    await t.db
      .insertInto('parent_child_links')
      .values({
        parent_id: second.id,
        child_id: children[0]!.id,
        consent_id: '0193a0a4-0000-7000-8000-00000000c0de',
      })
      .execute();
    expect(
      (await startTrial(await second.auth(), { studentIds: [children[0]!.id] })).body.code,
    ).toBe('TRIAL_USED');

    // The trial ends by itself after seven days.
    t.clock.advance(7 * DAY + 1000);
    expect(await lessonStatus(await children[0]!.auth())).toBe(402);
    const ended = await http()
      .get('/api/v1/subscriptions')
      .set('Authorization', await parent.auth());
    expect(ended.body.items[0].status).toBe('expired');
  });

  it('refuses a device that already had a trial, and children already covered', async () => {
    const a = await family(t);
    const b = await family(t);
    const c = await family(t);
    expect(
      (
        await startTrial(await a.parent.auth(), {
          studentIds: [a.children[0]!.id],
          deviceToken: 'dev-1',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await startTrial(await b.parent.auth(), {
          studentIds: [b.children[0]!.id],
          deviceToken: 'dev-1',
        })
      ).body.code,
    ).toBe('TRIAL_USED');
    // B's failed attempt left nothing behind, so B can still try from another device.
    expect(
      (await startTrial(await b.parent.auth(), { studentIds: [b.children[0]!.id] })).status,
    ).toBe(201);

    const order = await checkout(t, await c.parent.auth(), { studentIds: [c.children[0]!.id] });
    await payWithPayme(t, KEY, order.body.orderId, MONTHLY);
    expect(
      (await startTrial(await c.parent.auth(), { studentIds: [c.children[0]!.id] })).body.code,
    ).toBe('ALREADY_SUBSCRIBED');
    expect(
      (await startTrial(await c.parent.auth(), { studentIds: [a.children[0]!.id] })).body.code,
    ).toBe('STUDENT_NOT_FOUND');
  });
});
