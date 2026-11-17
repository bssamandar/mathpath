import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileBilling } from './billing-reconciliation';
import { newId } from './ids';
import type { Database } from './schema';
import { createTestDb } from './testing';

const NOW = new Date('2026-12-01T10:00:00Z');
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('billing reconciliation', () => {
  let db: Kysely<Database>;
  let ownerId: string;
  let studentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    ownerId = newId();
    studentId = newId();
    await db
      .insertInto('users')
      .values([
        { id: ownerId, first_name: 'Parent' },
        { id: studentId, first_name: 'Child' },
      ])
      .execute();
  });
  afterEach(async () => {
    await db.destroy();
  });

  /** A paid order with its payment and subscription, consistent as fulfil leaves it. */
  async function paidOrder(amount = 4_900_000) {
    const orderId = newId();
    const paymentId = newId();
    const subscriptionId = newId();
    await db
      .insertInto('orders')
      .values({
        id: orderId,
        owner_id: ownerId,
        plan_code: 'family-month',
        plan_interval: 'month',
        student_ids: [studentId],
        amount_tiyin: amount,
        provider: 'payme',
        status: 'paid',
        idempotency_key: newId(),
        expires_at: ago(-DAY),
        paid_at: ago(DAY),
      })
      .execute();
    await db
      .insertInto('subscriptions')
      .values({
        id: subscriptionId,
        owner_id: ownerId,
        order_id: orderId,
        plan_code: 'family-month',
        status: 'active',
        seats: 1,
        price_tiyin: amount,
        current_period_start: ago(DAY),
        current_period_end: ago(-29 * DAY),
      })
      .execute();
    await db
      .insertInto('payments')
      .values({
        id: paymentId,
        order_id: orderId,
        subscription_id: subscriptionId,
        provider: 'payme',
        provider_txn_id: newId().slice(0, 24),
        amount_tiyin: amount,
        status: 'paid',
        created_at: ago(DAY),
        paid_at: ago(DAY),
      })
      .execute();
    return { orderId, paymentId, subscriptionId };
  }

  async function refund(paymentId: string, status: 'requested' | 'succeeded', at: Date) {
    const id = newId();
    await db
      .insertInto('refunds')
      .values({
        id,
        payment_id: paymentId,
        amount_tiyin: 4_900_000,
        status,
        reason: 'parent asked',
        requested_by: ownerId,
        created_at: at,
        completed_at: status === 'requested' ? null : at,
      })
      .execute();
    return id;
  }

  it('finds nothing in consistent books', async () => {
    const { paymentId, subscriptionId } = await paidOrder();
    // A refund done right: payment refunded, subscription ended, refund recorded.
    await db
      .updateTable('payments')
      .set({ status: 'refunded', cancelled_at: NOW })
      .where('id', '=', paymentId)
      .execute();
    await db
      .updateTable('subscriptions')
      .set({ status: 'cancelled', current_period_end: NOW })
      .where('id', '=', subscriptionId)
      .execute();
    await refund(paymentId, 'succeeded', NOW);
    await paidOrder();

    const result = await reconcileBilling(db, NOW);
    expect(result.ok).toBe(true);
    expect(Object.values(result.counts).every((n) => n === 0)).toBe(true);
    expect(result.samples).toEqual({});
  });

  it('flags a paid payment without a subscription', async () => {
    const { paymentId } = await paidOrder();
    await db
      .updateTable('payments')
      .set({ subscription_id: null })
      .where('id', '=', paymentId)
      .execute();
    const result = await reconcileBilling(db, NOW);
    expect(result.ok).toBe(false);
    expect(result.counts.paid_without_subscription).toBe(1);
    expect(result.samples.paid_without_subscription).toEqual([paymentId]);
  });

  it('flags orders and payments that disagree on being paid', async () => {
    // A paid order whose payment row is gone.
    const first = await paidOrder();
    await db.deleteFrom('payments').where('id', '=', first.paymentId).execute();
    const second = await paidOrder();
    await db
      .updateTable('orders')
      .set({ status: 'cancelled', paid_at: null })
      .where('id', '=', second.orderId)
      .execute();
    const result = await reconcileBilling(db, NOW);
    expect(result.counts.order_payment_mismatch).toBe(2);
    expect(result.samples.order_payment_mismatch).toEqual([first.orderId, second.paymentId]);
  });

  it('flags a payment whose amount differs from its order', async () => {
    const { orderId, paymentId } = await paidOrder();
    await db.updateTable('orders').set({ amount_tiyin: 100 }).where('id', '=', orderId).execute();
    const result = await reconcileBilling(db, NOW);
    expect(result.samples.amount_mismatch).toEqual([paymentId]);
  });

  it('flags a refund that left the subscription running and has no record', async () => {
    const { paymentId } = await paidOrder();
    await db
      .updateTable('payments')
      .set({ status: 'refunded', cancelled_at: NOW })
      .where('id', '=', paymentId)
      .execute();
    const result = await reconcileBilling(db, NOW);
    expect(result.counts.refund_not_revoked).toBe(1);
    expect(result.counts.refund_record_mismatch).toBe(1);
  });

  it('flags a succeeded refund whose payment is still paid', async () => {
    const { paymentId } = await paidOrder();
    const refundId = await refund(paymentId, 'succeeded', NOW);
    const result = await reconcileBilling(db, NOW);
    expect(result.samples.refund_record_mismatch).toEqual([refundId]);
  });

  it('flags payments and refund requests left waiting too long', async () => {
    const first = await paidOrder();
    const old = await refund(first.paymentId, 'requested', ago(4 * DAY));
    const second = await paidOrder();
    await refund(second.paymentId, 'requested', ago(DAY));

    // Two orders waiting on Click: one for two days, one for twelve hours.
    const pending: string[] = [];
    for (const age of [2 * DAY, DAY / 2]) {
      const orderId = newId();
      await db
        .insertInto('orders')
        .values({
          id: orderId,
          owner_id: ownerId,
          plan_code: 'family-month',
          plan_interval: 'month',
          student_ids: [studentId],
          amount_tiyin: 4_900_000,
          provider: 'click',
          status: 'pending',
          idempotency_key: newId(),
          expires_at: ago(-DAY),
        })
        .execute();
      const id = newId();
      pending.push(id);
      await db
        .insertInto('payments')
        .values({
          id,
          order_id: orderId,
          provider: 'click',
          provider_txn_id: String(1000 + pending.length),
          amount_tiyin: 4_900_000,
          created_at: ago(age),
        })
        .execute();
    }

    const result = await reconcileBilling(db, NOW);
    expect(result.samples.stale_refund_request).toEqual([old]);
    expect(result.samples.stuck_payment).toEqual([pending[0]]);
    const relaxed = await reconcileBilling(db, NOW, {
      stuckAfterHours: 72,
      refundStaleAfterHours: 120,
    });
    expect(relaxed.ok).toBe(true);
  });
});
