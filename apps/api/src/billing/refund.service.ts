/**
 * Refunds by admins (step 7.4; ADR-0008; security plan C-28, C-33, §9).
 *
 * Rules that hold for every refund:
 * - Only `admin:billing` (with 2FA) can refund; a written reason is required
 *   and goes to the audit log with the outcome.
 * - Whole payments only: Payme and Click refund a transaction in full, so a
 *   different amount is refused rather than silently rounded up.
 * - One live refund per payment (a unique index); a failed one can be retried.
 * - The subscription the payment bought ends when the money is returned, not
 *   when the refund is asked for.
 *
 * Providers:
 * - Click: reversed at once through the Merchant API. The refund row is written
 *   before Click is called, so a crash in between leaves a `requested` row that
 *   the daily reconciliation reports, never a silent double refund.
 * - Payme: its Merchant API cannot start a refund. The request is recorded and
 *   the admin cancels the transaction in the Payme business cabinet; Payme
 *   then calls CancelTransaction, which completes the refund here.
 */
import type { Database, PaymentStatus, RefundStatus } from '@mathpath/db';
import { newId } from '@mathpath/db';
import type { Kysely } from 'kysely';
import type { Actor } from '../admin/admin.service';
import { searchTerm } from '../admin/admin.service';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import type { ClientContext } from '../identity/session.service';
import { maskPhone } from '../identity/sms/sms-sender';
import type { BillingService } from './billing.service';
import type { ClickMerchantApi } from './click/merchant-api';
import { type Money, money } from './plans';

export interface RefundView {
  refundId: string;
  paymentId: string;
  status: RefundStatus;
  amount: Money;
  reason: string;
  /** Null when the provider started the refund on its side. */
  requestedBy: string | null;
  /** Why the provider refused; null unless failed. */
  failure: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AdminPayment {
  id: string;
  orderId: string;
  provider: 'payme' | 'click';
  providerTxnId: string;
  amount: Money;
  status: PaymentStatus;
  planCode: string;
  owner: { id: string; firstName: string; phoneMasked: string | null };
  createdAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  refunds: RefundView[];
}

export interface RefundInput {
  amountTiyin: number;
  reason: string;
}

/** Payments shown per search; enough for one family's history. */
const SEARCH_LIMIT = 50;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

type RefundRow = {
  id: string;
  payment_id: string;
  status: RefundStatus;
  amount_tiyin: unknown;
  reason: string;
  requested_by: string | null;
  failure: string | null;
  created_at: Date;
  completed_at: Date | null;
};

function refundView(r: RefundRow): RefundView {
  return {
    refundId: r.id,
    paymentId: r.payment_id,
    status: r.status,
    amount: money(Number(r.amount_tiyin)),
    reason: r.reason,
    requestedBy: r.requested_by,
    failure: r.failure,
    createdAt: r.created_at.toISOString(),
    completedAt: iso(r.completed_at),
  };
}

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';

export class RefundService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly billing: BillingService,
    /** Null when CLICK_MERCHANT_USER_ID is not set: Click refunds are then done in the cabinet. */
    private readonly click: ClickMerchantApi | null,
  ) {}

  /**
   * GET /admin/payments?q=: a parent's payments by phone number, or one
   * payment by its payment, order or owner ID. Newest first, with refunds.
   */
  async search(actor: Actor, client: ClientContext, q: string): Promise<{ items: AdminPayment[] }> {
    const term = searchTerm(q);
    if (term.kind === 'name') {
      throw new ProblemException(400, 'VALIDATION_FAILED', 'Search by phone number or ID.', {
        errors: [{ field: 'q', message: 'a phone number or an ID' }],
      });
    }
    let query = this.db
      .selectFrom('payments as p')
      .innerJoin('orders as o', 'o.id', 'p.order_id')
      .innerJoin('users as u', 'u.id', 'o.owner_id')
      .select([
        'p.id',
        'p.order_id',
        'p.provider',
        'p.provider_txn_id',
        'p.amount_tiyin',
        'p.status',
        'p.created_at',
        'p.paid_at',
        'p.cancelled_at',
        'o.plan_code',
        'u.id as owner_id',
        'u.first_name',
        'u.phone_e164',
      ]);
    query =
      term.kind === 'phone'
        ? query.where('u.phone_e164', '=', term.value)
        : query.where((eb) =>
            eb.or([
              eb('p.id', '=', term.value),
              eb('o.id', '=', term.value),
              eb('u.id', '=', term.value),
            ]),
          );
    const rows = await query
      .orderBy('p.created_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(SEARCH_LIMIT)
      .execute();
    const refunds = rows.length
      ? await this.db
          .selectFrom('refunds')
          .selectAll()
          .where(
            'payment_id',
            'in',
            rows.map((r) => r.id),
          )
          .orderBy('created_at', 'desc')
          .execute()
      : [];
    await this.audit.record({
      action: 'admin.payment_search',
      actorId: actor.userId,
      actorRoles: actor.roles,
      ipPrefix: client.ipPrefix,
      requestId: client.requestId,
      metadata: { kind: term.kind, results: rows.length },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        provider: r.provider,
        providerTxnId: r.provider_txn_id,
        amount: money(Number(r.amount_tiyin)),
        status: r.status,
        planCode: r.plan_code,
        owner: {
          id: r.owner_id,
          firstName: r.first_name,
          phoneMasked: r.phone_e164 ? maskPhone(r.phone_e164) : null,
        },
        createdAt: r.created_at.toISOString(),
        paidAt: iso(r.paid_at),
        cancelledAt: iso(r.cancelled_at),
        refunds: refunds.filter((f) => f.payment_id === r.id).map(refundView),
      })),
    };
  }

  /**
   * POST /admin/payments/{paymentId}/refunds. A repeated Idempotency-Key
   * returns the refund it created.
   * @throws ProblemException 404 PAYMENT_NOT_FOUND; 409 PAYMENT_NOT_REFUNDABLE
   *   (not paid), REFUND_IN_PROGRESS (a live refund exists) or
   *   IDEMPOTENCY_KEY_REUSED; 422 PARTIAL_REFUND_UNSUPPORTED or
   *   REFUND_UNAVAILABLE (Click without Merchant API access).
   */
  async refund(
    actor: Actor,
    client: ClientContext,
    paymentId: string,
    input: RefundInput,
    key: string,
  ): Promise<RefundView> {
    const repeated = await this.db
      .selectFrom('refunds')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (repeated) {
      if (repeated.payment_id !== paymentId) {
        throw new ProblemException(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was used for another payment.',
        );
      }
      return refundView(repeated);
    }

    const now = this.clock.now();
    const auditBase = {
      actorId: actor.userId,
      actorRoles: actor.roles,
      ipPrefix: client.ipPrefix,
      requestId: client.requestId,
      targetType: 'payment',
      targetId: paymentId,
    };
    const { refund, provider, providerTxnId } = await this.db.transaction().execute(async (trx) => {
      const payment = await trx
        .selectFrom('payments')
        .select(['id', 'provider', 'provider_txn_id', 'amount_tiyin', 'status'])
        .where('id', '=', paymentId)
        .forUpdate()
        .executeTakeFirst();
      if (!payment) throw new ProblemException(404, 'PAYMENT_NOT_FOUND', 'No such payment.');
      if (payment.status !== 'paid') {
        throw new ProblemException(
          409,
          'PAYMENT_NOT_REFUNDABLE',
          `Only a paid payment can be refunded; this one is ${payment.status}.`,
        );
      }
      const amount = Number(payment.amount_tiyin);
      if (input.amountTiyin !== amount) {
        throw new ProblemException(
          422,
          'PARTIAL_REFUND_UNSUPPORTED',
          'Payme and Click refund whole payments only.',
          { errors: [{ field: 'amountTiyin', message: `must be ${amount}` }] },
        );
      }
      if (payment.provider === 'click' && !this.click) {
        throw new ProblemException(
          422,
          'REFUND_UNAVAILABLE',
          'Click refunds need CLICK_MERCHANT_USER_ID; reverse this payment in the Click cabinet.',
        );
      }
      const live = await trx
        .selectFrom('refunds')
        .select('id')
        .where('payment_id', '=', payment.id)
        .where('status', 'in', ['requested', 'succeeded'])
        .executeTakeFirst();
      if (live) throw refundInProgress();
      const row = await trx
        .insertInto('refunds')
        .values({
          id: newId(),
          payment_id: payment.id,
          amount_tiyin: amount,
          reason: input.reason,
          requested_by: actor.userId,
          idempotency_key: key,
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? refundInProgress() : error;
        });
      await this.audit.record(
        {
          ...auditBase,
          action: 'billing.refund_requested',
          metadata: {
            refundId: row.id,
            provider: payment.provider,
            amountTiyin: amount,
            reason: input.reason,
          },
        },
        trx,
      );
      return { refund: row, provider: payment.provider, providerTxnId: payment.provider_txn_id };
    });

    // Payme: the admin finishes it in the Payme cabinet (see the class comment).
    if (provider === 'payme') return refundView(refund);

    const result = await this.click!.reverse(providerTxnId, now);
    const done = this.clock.now();
    const finished = await this.db.transaction().execute(async (trx) => {
      if (result.ok) {
        const updated = await trx
          .updateTable('payments')
          .set({ status: 'refunded', cancelled_at: done })
          .where('id', '=', paymentId)
          .where('status', '=', 'paid')
          .returning('order_id')
          .executeTakeFirst();
        if (updated) await this.billing.revoke(trx, updated.order_id, done);
      }
      const row = await trx
        .updateTable('refunds')
        .set(
          result.ok
            ? { status: 'succeeded', provider_ref: result.paymentId, completed_at: done }
            : {
                status: 'failed',
                failure:
                  result.code === null
                    ? `${result.note}; check the Click cabinet before trying again`
                    : `${result.code}: ${result.note}`,
                completed_at: done,
              },
        )
        .where('id', '=', refund.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(
        {
          ...auditBase,
          action: result.ok ? 'billing.refund_succeeded' : 'billing.refund_failed',
          metadata: {
            refundId: refund.id,
            provider,
            ...(row.failure ? { failure: row.failure } : {}),
          },
        },
        trx,
      );
      return row;
    });
    return refundView(finished);
  }
}

function refundInProgress() {
  return new ProblemException(
    409,
    'REFUND_IN_PROGRESS',
    'This payment already has a refund that is requested or done.',
  );
}
