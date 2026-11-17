/**
 * The daily billing reconciliation (security plan C-28, C-39; ADR-0008).
 *
 * Checks that payments, orders, subscriptions and refunds agree with each
 * other, and that nothing waits too long on a provider. Each check counts
 * rows; the worker exports the counts as a metric and the alert fires on any
 * count above zero. The IDs of the first few rows go to the log so the
 * maintainer can start from them.
 *
 * Comparing with the providers' own statements is a manual monthly step for
 * now (docs/guides/payments.md): Payme has no statement API for merchants, and
 * Click's payment-status codes must be confirmed with Click before we alert on
 * them.
 */
import type { Kysely } from 'kysely';
import type { Database } from './schema';

export const RECONCILIATION_CHECKS = [
  /** A payment is paid but granted no subscription (fulfilment failed). */
  'paid_without_subscription',
  /** A paid order has no paid or refunded payment, or a paid payment's order is not paid. */
  'order_payment_mismatch',
  /** A paid or refunded payment's amount differs from its order's. */
  'amount_mismatch',
  /** A refunded payment's subscription is still running. */
  'refund_not_revoked',
  /** A succeeded refund's payment is not refunded, or a refunded payment has no succeeded refund. */
  'refund_record_mismatch',
  /** A payment has waited for the provider for over a day. */
  'stuck_payment',
  /** A Payme refund was requested but nobody cancelled it in the Payme cabinet. */
  'stale_refund_request',
] as const;

export type ReconciliationCheck = (typeof RECONCILIATION_CHECKS)[number];

export interface ReconciliationOptions {
  /** A pending payment older than this is stuck. Default 24 hours. */
  stuckAfterHours?: number;
  /** A requested refund older than this is stale. Default 72 hours. */
  refundStaleAfterHours?: number;
  /** IDs kept per check for the log. Default 5. */
  sampleSize?: number;
}

export interface ReconciliationResult {
  counts: Record<ReconciliationCheck, number>;
  /** A few IDs (payment, order or refund) per check with problems. */
  samples: Partial<Record<ReconciliationCheck, string[]>>;
  /** True when every count is zero. */
  ok: boolean;
}

const LIVE_PAYMENT = ['paid', 'refunded', 'partially_refunded'] as const;

/** Runs every check; read-only, so it is safe to run at any time and in parallel. */
export async function reconcileBilling(
  db: Kysely<Database>,
  now: Date,
  options: ReconciliationOptions = {},
): Promise<ReconciliationResult> {
  const stuckBefore = hoursBefore(now, options.stuckAfterHours ?? 24);
  const staleBefore = hoursBefore(now, options.refundStaleAfterHours ?? 72);
  const sampleSize = options.sampleSize ?? 5;

  const queries: Record<ReconciliationCheck, () => Promise<{ id: string }[]>> = {
    paid_without_subscription: () =>
      db
        .selectFrom('payments')
        .select('id')
        .where('status', '=', 'paid')
        .where('subscription_id', 'is', null)
        .execute(),
    order_payment_mismatch: async () => [
      ...(await db
        .selectFrom('orders as o')
        .select('o.id')
        .where('o.status', '=', 'paid')
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('payments as p')
                .select('p.id')
                .whereRef('p.order_id', '=', 'o.id')
                .where('p.status', 'in', LIVE_PAYMENT),
            ),
          ),
        )
        .execute()),
      ...(await db
        .selectFrom('payments as p')
        .innerJoin('orders as o', 'o.id', 'p.order_id')
        .select('p.id')
        .where('p.status', 'in', LIVE_PAYMENT)
        .where('o.status', '<>', 'paid')
        .execute()),
    ],
    amount_mismatch: () =>
      db
        .selectFrom('payments as p')
        .innerJoin('orders as o', 'o.id', 'p.order_id')
        .select('p.id')
        .where('p.status', 'in', LIVE_PAYMENT)
        .whereRef('p.amount_tiyin', '<>', 'o.amount_tiyin')
        .execute(),
    refund_not_revoked: () =>
      db
        .selectFrom('payments as p')
        .innerJoin('subscriptions as s', 's.order_id', 'p.order_id')
        .select('p.id')
        .where('p.status', '=', 'refunded')
        .where('s.status', '<>', 'cancelled')
        .where('s.current_period_end', '>', now)
        .execute(),
    refund_record_mismatch: async () => [
      ...(await db
        .selectFrom('refunds as r')
        .innerJoin('payments as p', 'p.id', 'r.payment_id')
        .select('r.id')
        .where('r.status', '=', 'succeeded')
        .where('p.status', 'not in', ['refunded', 'partially_refunded'])
        .execute()),
      ...(await db
        .selectFrom('payments as p')
        .select('p.id')
        .where('p.status', 'in', ['refunded', 'partially_refunded'])
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('refunds as r')
                .select('r.id')
                .whereRef('r.payment_id', '=', 'p.id')
                .where('r.status', '=', 'succeeded'),
            ),
          ),
        )
        .execute()),
    ],
    stuck_payment: () =>
      db
        .selectFrom('payments')
        .select('id')
        .where('status', '=', 'pending')
        .where('created_at', '<', stuckBefore)
        .execute(),
    stale_refund_request: () =>
      db
        .selectFrom('refunds')
        .select('id')
        .where('status', '=', 'requested')
        .where('created_at', '<', staleBefore)
        .execute(),
  };

  const counts = {} as Record<ReconciliationCheck, number>;
  const samples: ReconciliationResult['samples'] = {};
  for (const check of RECONCILIATION_CHECKS) {
    const rows = await queries[check]();
    counts[check] = rows.length;
    if (rows.length > 0) samples[check] = rows.slice(0, sampleSize).map((r) => r.id);
  }
  return { counts, samples, ok: Object.values(counts).every((n) => n === 0) };
}

function hoursBefore(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}
