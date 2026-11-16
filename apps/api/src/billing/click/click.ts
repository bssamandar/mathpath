/**
 * Click Shop API adapter (ADR-0008; security plan C-27).
 *
 * Click calls two URLs with a form-encoded body: Prepare (`action=0`), when
 * the parent confirms the payment, and Complete (`action=1`), after Click has
 * charged the card or failed to. Every call carries `sign_string`, an MD5 of
 * the call's fields and our secret key; it is recomputed and compared in
 * constant time before anything else is read. Answers are JSON with Click's
 * error codes, and a repeated call for the same Click transaction gets the
 * same answer, because the state lives in `payments` and moves forward only.
 *
 * Click wants integer IDs for our side (`merchant_prepare_id`,
 * `merchant_confirm_id`); both are the payment's `merchant_ref`.
 */
import { createHash } from 'node:crypto';
import type { Database, PaymentStatus } from '@mathpath/db';
import { newId } from '@mathpath/db';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import type { Clock } from '../../common/clock';
import { safeEqual } from '../../identity/crypto';
import type { BillingService } from '../billing.service';
import { type CheckoutRequest, PaymentProvider } from '../payment-provider';

export interface ClickSettings {
  serviceId: string;
  merchantId: string;
  secretKey: string;
  checkoutUrl: string;
}

export type ClickStage = 'prepare' | 'complete';

/** Click's error codes (Shop API documentation). */
export const ClickError = {
  SUCCESS: 0,
  SIGN_CHECK_FAILED: -1,
  WRONG_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  ORDER_NOT_FOUND: -5,
  TRANSACTION_NOT_FOUND: -6,
  UPDATE_FAILED: -7,
  BAD_REQUEST: -8,
  TRANSACTION_CANCELLED: -9,
} as const;

const NOTES: Record<number, string> = {
  [ClickError.SUCCESS]: 'Success',
  [ClickError.SIGN_CHECK_FAILED]: 'SIGN CHECK FAILED!',
  [ClickError.WRONG_AMOUNT]: 'Incorrect parameter amount',
  [ClickError.ACTION_NOT_FOUND]: 'Action not found',
  [ClickError.ALREADY_PAID]: 'Already paid',
  [ClickError.ORDER_NOT_FOUND]: 'Order does not exist',
  [ClickError.TRANSACTION_NOT_FOUND]: 'Transaction does not exist',
  [ClickError.UPDATE_FAILED]: 'Failed to update the order',
  [ClickError.BAD_REQUEST]: 'Error in request from click',
  [ClickError.TRANSACTION_CANCELLED]: 'Transaction cancelled',
};

class ClickFault extends Error {
  constructor(readonly code: number) {
    super(`click error ${code}`);
  }
}

const digits = (max: number) => z.string().regex(new RegExp(`^\\d{1,${max}}$`));

const callBody = z
  .object({
    click_trans_id: digits(20),
    service_id: digits(10),
    click_paydoc_id: digits(20),
    merchant_trans_id: z.string().min(1).max(64),
    merchant_prepare_id: digits(20).optional(),
    amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
    action: z.enum(['0', '1']),
    error: z.string().regex(/^-?\d{1,6}$/),
    error_note: z.string().max(1000).optional(),
    sign_time: z.string().min(1).max(32),
    sign_string: z.string().regex(/^[0-9a-f]{32}$/i),
  })
  .loose();
type CallBody = z.infer<typeof callBody>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "1500.5" sum → 150050 tiyin, without floating point. */
export function sumToTiyin(amount: string): number {
  const [whole, fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** 150050 tiyin → "1500.50" sum. */
export function tiyinToSum(tiyin: number): string {
  return `${Math.floor(tiyin / 100)}.${String(tiyin % 100).padStart(2, '0')}`;
}

type PaymentRow = {
  id: string;
  order_id: string;
  amount_tiyin: unknown;
  status: PaymentStatus;
  merchant_ref: unknown;
};

export class ClickProvider extends PaymentProvider {
  readonly code = 'click' as const;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly billing: BillingService,
    private readonly settings: ClickSettings,
  ) {
    super();
  }

  /**
   * Click's hosted payment page. `transaction_param` is the order ID that
   * Click sends back as `merchant_trans_id`; the amount is in sum.
   */
  checkoutUrl(request: CheckoutRequest): string {
    const url = new URL(this.settings.checkoutUrl);
    url.searchParams.set('service_id', this.settings.serviceId);
    url.searchParams.set('merchant_id', this.settings.merchantId);
    url.searchParams.set('amount', tiyinToSum(request.amountTiyin));
    url.searchParams.set('transaction_param', request.orderId);
    if (request.returnUrl) url.searchParams.set('return_url', request.returnUrl);
    return url.toString();
  }

  /**
   * Handles one Prepare or Complete call and returns Click's JSON answer.
   * Never throws for a bad call: every failure becomes a Click error, and
   * every call is logged in `payment_callbacks` with the answer given.
   */
  async handle(stage: ClickStage, body: unknown): Promise<Record<string, unknown>> {
    const raw = (body ?? {}) as Record<string, unknown>;
    const field = (name: string) => (typeof raw[name] === 'string' ? raw[name] : '');

    if (!this.signatureValid(stage, field)) {
      // Nothing from an unsigned body is trusted or stored.
      const response = this.answer(raw, ClickError.SIGN_CHECK_FAILED);
      await this.log(stage, null, false, {}, response);
      return response;
    }

    let response: Record<string, unknown>;
    const parsed = callBody.safeParse(raw);
    if (!parsed.success) {
      response = this.answer(raw, ClickError.BAD_REQUEST);
    } else {
      const call = parsed.data;
      try {
        if (call.service_id !== this.settings.serviceId)
          throw new ClickFault(ClickError.BAD_REQUEST);
        if (call.action !== (stage === 'prepare' ? '0' : '1')) {
          throw new ClickFault(ClickError.ACTION_NOT_FOUND);
        }
        const ids = stage === 'prepare' ? await this.prepare(call) : await this.complete(call);
        response = this.answer(raw, ClickError.SUCCESS, ids);
      } catch (error) {
        if (!(error instanceof ClickFault)) throw error;
        response = this.answer(raw, error.code);
      }
    }
    await this.log(stage, field('click_trans_id') || null, true, this.payload(raw), response);
    return response;
  }

  /**
   * MD5(click_trans_id + service_id + secret + merchant_trans_id
   * [+ merchant_prepare_id on Complete] + amount + action + sign_time),
   * over the strings exactly as Click sent them.
   */
  private signatureValid(stage: ClickStage, field: (name: string) => string): boolean {
    const parts = [
      field('click_trans_id'),
      field('service_id'),
      this.settings.secretKey,
      field('merchant_trans_id'),
      ...(stage === 'complete' ? [field('merchant_prepare_id')] : []),
      field('amount'),
      field('action'),
      field('sign_time'),
    ];
    const expected = createHash('md5').update(parts.join('')).digest('hex');
    return safeEqual(field('sign_string').toLowerCase(), expected);
  }

  /**
   * Prepare: may this order be paid with this amount? Records the Click
   * transaction as a pending payment. A repeated Prepare returns the same ID.
   */
  private prepare(call: CallBody): Promise<Record<string, unknown>> {
    return this.db.transaction().execute(async (trx) => {
      const amountTiyin = sumToTiyin(call.amount);
      const existing = await this.lockPayment(trx, call.click_trans_id);
      if (existing) {
        if (existing.order_id !== call.merchant_trans_id)
          throw new ClickFault(ClickError.BAD_REQUEST);
        this.refuseUnlessPending(existing.status);
        return { merchant_prepare_id: Number(existing.merchant_ref) };
      }
      const order = await this.payableOrder(trx, call.merchant_trans_id, amountTiyin);
      const now = this.clock.now();
      if (order.status === 'pending') {
        // A new Prepare for the same order means the parent started again
        // (for example in a second tab). The older attempt is cancelled; if
        // Click completes it later, it gets -9 and Click returns the money.
        await trx
          .updateTable('payments')
          .set({ status: 'cancelled', cancelled_at: now })
          .where('order_id', '=', order.id)
          .where('status', '=', 'pending')
          .execute();
      }
      const payment = await trx
        .insertInto('payments')
        .values({
          id: newId(),
          order_id: order.id,
          provider: 'click',
          provider_txn_id: call.click_trans_id,
          amount_tiyin: amountTiyin,
          created_at: now,
        })
        .returning('merchant_ref')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('orders')
        .set({ status: 'pending', updated_at: now })
        .where('id', '=', order.id)
        .execute();
      return { merchant_prepare_id: Number(payment.merchant_ref) };
    });
  }

  /**
   * Complete: Click charged the card (`error` 0) or could not (`error` < 0).
   * On success the order is fulfilled; on failure the payment and order are
   * cancelled. A repeated Complete for a paid transaction returns success.
   */
  private async complete(call: CallBody): Promise<Record<string, unknown>> {
    const outcome = await this.db.transaction().execute(async (trx) => {
      const payment = await this.lockPayment(trx, call.click_trans_id);
      if (
        !payment ||
        payment.order_id !== call.merchant_trans_id ||
        String(payment.merchant_ref) !== call.merchant_prepare_id
      ) {
        throw new ClickFault(ClickError.TRANSACTION_NOT_FOUND);
      }
      if (Number(payment.amount_tiyin) !== sumToTiyin(call.amount)) {
        throw new ClickFault(ClickError.WRONG_AMOUNT);
      }
      const ids = { merchant_confirm_id: Number(payment.merchant_ref) };
      const now = this.clock.now();
      if (Number(call.error) < 0) {
        if (payment.status !== 'pending') this.refuseUnlessPending(payment.status);
        await trx
          .updateTable('payments')
          .set({ status: 'cancelled', cancelled_at: now })
          .where('id', '=', payment.id)
          .execute();
        await trx
          .updateTable('orders')
          .set({ status: 'cancelled', updated_at: now })
          .where('id', '=', payment.order_id)
          .execute();
        // Commit the cancellation, then answer -9.
        return 'cancelled' as const;
      }
      if (payment.status === 'paid') return ids;
      this.refuseUnlessPending(payment.status);
      await trx
        .updateTable('payments')
        .set({ status: 'paid', paid_at: now })
        .where('id', '=', payment.id)
        .execute();
      await this.billing.fulfil(trx, payment.order_id, payment.id, now);
      return ids;
    });
    if (outcome === 'cancelled') throw new ClickFault(ClickError.TRANSACTION_CANCELLED);
    return outcome;
  }

  /** @throws ClickFault -4 for a paid payment, -9 for a cancelled or refunded one. */
  private refuseUnlessPending(status: PaymentStatus): void {
    if (status === 'pending') return;
    throw new ClickFault(
      status === 'paid' ? ClickError.ALREADY_PAID : ClickError.TRANSACTION_CANCELLED,
    );
  }

  /**
   * The order behind `merchant_trans_id`, locked and checked.
   * @throws ClickFault -5 unknown order, -2 wrong amount, -4 already paid,
   *   -9 cancelled or expired.
   */
  private async payableOrder(trx: Transaction<Database>, orderId: string, amountTiyin: number) {
    if (!UUID.test(orderId)) throw new ClickFault(ClickError.ORDER_NOT_FOUND);
    const order = await trx
      .selectFrom('orders')
      .select(['id', 'status', 'amount_tiyin', 'expires_at', 'provider'])
      .where('id', '=', orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!order || order.provider !== 'click') throw new ClickFault(ClickError.ORDER_NOT_FOUND);
    if (Number(order.amount_tiyin) !== amountTiyin) throw new ClickFault(ClickError.WRONG_AMOUNT);
    if (order.status === 'paid') throw new ClickFault(ClickError.ALREADY_PAID);
    const expired = order.status === 'created' && order.expires_at <= this.clock.now();
    if (expired || (order.status !== 'created' && order.status !== 'pending')) {
      throw new ClickFault(ClickError.TRANSACTION_CANCELLED);
    }
    return order;
  }

  private lockPayment(trx: Transaction<Database>, clickTransId: string) {
    return trx
      .selectFrom('payments')
      .select(['id', 'order_id', 'amount_tiyin', 'status', 'merchant_ref'])
      .where('provider', '=', 'click')
      .where('provider_txn_id', '=', clickTransId)
      .forUpdate()
      .executeTakeFirst() as Promise<PaymentRow | undefined>;
  }

  private answer(
    raw: Record<string, unknown>,
    code: number,
    ids: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const numeric = (value: unknown) =>
      typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : null;
    return {
      click_trans_id: numeric(raw.click_trans_id),
      merchant_trans_id:
        typeof raw.merchant_trans_id === 'string' ? raw.merchant_trans_id.slice(0, 64) : null,
      ...ids,
      error: code,
      error_note: NOTES[code],
    };
  }

  /** The fields worth keeping; the signature is dropped. */
  private payload(raw: Record<string, unknown>): Record<string, unknown> {
    const keep = [
      'click_trans_id',
      'service_id',
      'click_paydoc_id',
      'merchant_trans_id',
      'merchant_prepare_id',
      'amount',
      'action',
      'error',
      'error_note',
      'sign_time',
    ];
    return Object.fromEntries(
      keep.filter((k) => typeof raw[k] === 'string').map((k) => [k, String(raw[k]).slice(0, 200)]),
    );
  }

  private async log(
    stage: ClickStage,
    externalId: string | null,
    authValid: boolean,
    payload: Record<string, unknown>,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .insertInto('payment_callbacks')
      .values({
        id: newId(),
        provider: 'click',
        method: stage,
        external_id: externalId ? externalId.slice(0, 64) : null,
        auth_valid: authValid,
        payload,
        response,
        received_at: this.clock.now(),
      })
      .execute();
  }
}
