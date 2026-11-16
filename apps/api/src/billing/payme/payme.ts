/**
 * Payme Merchant API adapter (ADR-0008; security plan C-27).
 *
 * Payme calls POST /payments/payme with JSON-RPC: CheckPerformTransaction,
 * CreateTransaction, PerformTransaction, CancelTransaction, CheckTransaction
 * and GetStatement. Every call is authenticated first (Basic auth with the
 * login "Paycom" and the cashbox key, compared in constant time); only then
 * is the body read. Answers follow Payme's protocol: always HTTP 200, errors
 * as JSON-RPC errors with Payme's codes, and a repeated call for the same
 * transaction returns the same result, because the state lives in `payments`
 * and moves forward only.
 *
 * Transaction states: 1 created, 2 performed, -1 cancelled before perform,
 * -2 cancelled after perform (refund). A created transaction that was not
 * performed within 12 hours is cancelled with reason 4, as Payme requires.
 */
import type { Database, PaymentStatus } from '@mathpath/db';
import { newId } from '@mathpath/db';
import { type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Clock } from '../../common/clock';
import { safeEqual } from '../../identity/crypto';
import type { BillingService } from '../billing.service';
import { type CheckoutRequest, PaymentProvider } from '../payment-provider';
import type { BillingRules } from '../plans';

export interface PaymeSettings {
  merchantId: string;
  key: string;
  checkoutUrl: string;
}

/** Payme's error codes (Merchant API documentation). */
export const PaymeError = {
  INVALID_JSON: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INSUFFICIENT_PRIVILEGE: -32504,
  SYSTEM: -32400,
  WRONG_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  CANNOT_PERFORM: -31008,
  ORDER_NOT_FOUND: -31050,
  ORDER_NOT_PAYABLE: -31051,
  ORDER_BUSY: -31052,
} as const;

/** Payme waits this long for a created transaction to be performed. */
export const TRANSACTION_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** Payme's cancel reason for a transaction that timed out. */
const REASON_TIMEOUT = 4;

type Message = { uz: string; ru: string; en: string };
const MESSAGES: Record<number, Message> = {
  [PaymeError.INSUFFICIENT_PRIVILEGE]: {
    uz: 'Ruxsat yo‘q',
    ru: 'Недостаточно привилегий',
    en: 'Insufficient privilege',
  },
  [PaymeError.INVALID_REQUEST]: {
    uz: 'So‘rov noto‘g‘ri',
    ru: 'Неверный запрос',
    en: 'Invalid request',
  },
  [PaymeError.METHOD_NOT_FOUND]: {
    uz: 'Usul topilmadi',
    ru: 'Метод не найден',
    en: 'Method not found',
  },
  [PaymeError.SYSTEM]: { uz: 'Tizim xatosi', ru: 'Системная ошибка', en: 'System error' },
  [PaymeError.WRONG_AMOUNT]: { uz: 'Summa noto‘g‘ri', ru: 'Неверная сумма', en: 'Wrong amount' },
  [PaymeError.TRANSACTION_NOT_FOUND]: {
    uz: 'Tranzaksiya topilmadi',
    ru: 'Транзакция не найдена',
    en: 'Transaction not found',
  },
  [PaymeError.CANNOT_PERFORM]: {
    uz: 'Amalni bajarib bo‘lmaydi',
    ru: 'Невозможно выполнить операцию',
    en: 'Cannot perform this operation',
  },
  [PaymeError.ORDER_NOT_FOUND]: {
    uz: 'Buyurtma topilmadi',
    ru: 'Заказ не найден',
    en: 'Order not found',
  },
  [PaymeError.ORDER_NOT_PAYABLE]: {
    uz: 'Buyurtma to‘langan, bekor qilingan yoki muddati o‘tgan',
    ru: 'Заказ уже оплачен, отменён или просрочен',
    en: 'The order is paid, cancelled or expired',
  },
  [PaymeError.ORDER_BUSY]: {
    uz: 'Buyurtma boshqa to‘lovni kutmoqda',
    ru: 'Заказ ожидает другую оплату',
    en: 'The order is waiting for another payment',
  },
};

class PaymeFault extends Error {
  constructor(
    readonly code: number,
    readonly data?: string,
  ) {
    super(`payme error ${code}`);
  }
}

const account = z.object({ order_id: z.string().min(1).max(64) }).loose();
const amount = z.number().int().positive();
const txnId = z.string().min(1).max(64);
const time = z.number().int().nonnegative();

const PARAMS = {
  CheckPerformTransaction: z.object({ amount, account }).loose(),
  CreateTransaction: z.object({ id: txnId, time, amount, account }).loose(),
  PerformTransaction: z.object({ id: txnId }).loose(),
  CancelTransaction: z.object({ id: txnId, reason: z.number().int() }).loose(),
  CheckTransaction: z.object({ id: txnId }).loose(),
  GetStatement: z.object({ from: time, to: time }).loose(),
} as const;
type Method = keyof typeof PARAMS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATE: Record<PaymentStatus, number> = {
  pending: 1,
  paid: 2,
  cancelled: -1,
  refunded: -2,
  partially_refunded: -2,
  failed: -1,
};

type PaymentRow = {
  id: string;
  order_id: string;
  provider_txn_id: string;
  amount_tiyin: unknown;
  status: PaymentStatus;
  provider_created_at: Date | null;
  created_at: Date;
  paid_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: number | null;
};

const ms = (d: Date | null) => (d ? d.getTime() : 0);

/** Returned inside a transaction whose changes must be kept although the call fails. */
const LATE = Symbol('late');

export class PaymeProvider extends PaymentProvider {
  readonly code = 'payme' as const;
  private readonly expectedAuth: string;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly billing: BillingService,
    private readonly rules: BillingRules,
    private readonly settings: PaymeSettings,
  ) {
    super();
    this.expectedAuth = `Basic ${Buffer.from(`Paycom:${settings.key}`).toString('base64')}`;
  }

  /**
   * Payme's hosted checkout: the parameters, base64-encoded, after the
   * checkout host. `ac.order_id` is the account Payme sends back in callbacks.
   */
  checkoutUrl(request: CheckoutRequest): string {
    const lang = request.locale.startsWith('ru')
      ? 'ru'
      : request.locale.startsWith('en')
        ? 'en'
        : 'uz';
    const params = [
      `m=${this.settings.merchantId}`,
      `ac.order_id=${request.orderId}`,
      `a=${request.amountTiyin}`,
      `l=${lang}`,
      ...(request.returnUrl ? [`c=${request.returnUrl}`] : []),
    ].join(';');
    const base = this.settings.checkoutUrl.replace(/\/+$/, '');
    return `${base}/${Buffer.from(params).toString('base64')}`;
  }

  /**
   * Handles one Merchant API call and returns the JSON-RPC response body.
   * Never throws: every failure becomes a Payme error, and every call is
   * logged in `payment_callbacks` with the answer given.
   */
  async handle(authorization: string | undefined, body: unknown): Promise<Record<string, unknown>> {
    const rpcId = (body as { id?: unknown } | null)?.id ?? null;
    const method = String((body as { method?: unknown } | null)?.method ?? '').slice(0, 64);

    if (!safeEqual(authorization ?? '', this.expectedAuth)) {
      // Nothing from an unauthenticated body is trusted or stored beyond the method name.
      const response = this.error(rpcId, PaymeError.INSUFFICIENT_PRIVILEGE);
      await this.log(method || '(none)', null, false, {}, response);
      return response;
    }

    let response: Record<string, unknown>;
    let externalId: string | null = null;
    const params = (body as { params?: unknown } | null)?.params;
    try {
      if (!(method in PARAMS)) {
        throw new PaymeFault(
          method === 'ChangePassword' ? PaymeError.SYSTEM : PaymeError.METHOD_NOT_FOUND,
          method === 'ChangePassword' ? 'change the key in the server settings' : undefined,
        );
      }
      const parsed = PARAMS[method as Method].safeParse(params);
      if (!parsed.success) throw new PaymeFault(PaymeError.INVALID_REQUEST);
      const p = parsed.data as Record<string, unknown>;
      externalId =
        (p.id as string | undefined) ?? (p.account as { order_id?: string })?.order_id ?? null;
      response = { jsonrpc: '2.0', id: rpcId, result: await this.dispatch(method as Method, p) };
    } catch (error) {
      if (error instanceof PaymeFault) response = this.error(rpcId, error.code, error.data);
      else throw error;
    }
    await this.log(method, externalId, true, (params ?? {}) as Record<string, unknown>, response);
    return response;
  }

  private dispatch(method: Method, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (method) {
      case 'CheckPerformTransaction':
        return this.checkPerform(p.amount as number, p.account as { order_id: string });
      case 'CreateTransaction':
        return this.create(
          p.id as string,
          p.time as number,
          p.amount as number,
          p.account as { order_id: string },
        );
      case 'PerformTransaction':
        return this.perform(p.id as string);
      case 'CancelTransaction':
        return this.cancel(p.id as string, p.reason as number);
      case 'CheckTransaction':
        return this.check(p.id as string);
      case 'GetStatement':
        return this.statement(p.from as number, p.to as number);
    }
  }

  /** May this order be paid with this amount? */
  private async checkPerform(
    amountTiyin: number,
    acc: { order_id: string },
  ): Promise<Record<string, unknown>> {
    const order = await this.payableOrder(this.db, acc.order_id, amountTiyin);
    if (order.status === 'pending') throw new PaymeFault(PaymeError.ORDER_BUSY, 'order_id');
    const detail = this.receipt(amountTiyin);
    return detail ? { allow: true, detail } : { allow: true };
  }

  private async create(
    id: string,
    providerTime: number,
    amountTiyin: number,
    acc: { order_id: string },
  ): Promise<Record<string, unknown>> {
    return this.inTransaction(async (trx) => {
      const existing = await this.lockPayment(trx, id);
      if (existing) {
        if (existing.status !== 'pending') throw new PaymeFault(PaymeError.CANNOT_PERFORM);
        if (await this.cancelIfLate(trx, existing)) return LATE;
        return { create_time: ms(existing.created_at), transaction: existing.id, state: 1 };
      }
      const order = await this.payableOrder(trx, acc.order_id, amountTiyin, true);
      if (order.status === 'pending') throw new PaymeFault(PaymeError.ORDER_BUSY, 'order_id');
      const now = this.clock.now();
      const paymentId = newId();
      await trx
        .insertInto('payments')
        .values({
          id: paymentId,
          order_id: order.id,
          provider: 'payme',
          provider_txn_id: id,
          amount_tiyin: amountTiyin,
          provider_created_at: new Date(providerTime),
          created_at: now,
        })
        .execute();
      await trx
        .updateTable('orders')
        .set({ status: 'pending', updated_at: now })
        .where('id', '=', order.id)
        .execute();
      return { create_time: now.getTime(), transaction: paymentId, state: 1 };
    });
  }

  private async perform(id: string): Promise<Record<string, unknown>> {
    return this.inTransaction(async (trx) => {
      const payment = await this.lockPayment(trx, id);
      if (!payment) throw new PaymeFault(PaymeError.TRANSACTION_NOT_FOUND);
      if (payment.status === 'paid') {
        return { transaction: payment.id, perform_time: ms(payment.paid_at), state: 2 };
      }
      if (payment.status !== 'pending') throw new PaymeFault(PaymeError.CANNOT_PERFORM);
      if (await this.cancelIfLate(trx, payment)) return LATE;
      const now = this.clock.now();
      await trx
        .updateTable('payments')
        .set({ status: 'paid', paid_at: now })
        .where('id', '=', payment.id)
        .execute();
      await this.billing.fulfil(trx, payment.order_id, payment.id, now);
      return { transaction: payment.id, perform_time: now.getTime(), state: 2 };
    });
  }

  /**
   * Cancels a transaction. Before perform the order is cancelled; after
   * perform it is a refund, and the subscription it granted ends now.
   */
  private async cancel(id: string, reason: number): Promise<Record<string, unknown>> {
    return this.db.transaction().execute(async (trx) => {
      const payment = await this.lockPayment(trx, id);
      if (!payment) throw new PaymeFault(PaymeError.TRANSACTION_NOT_FOUND);
      if (payment.status === 'pending' || payment.status === 'paid') {
        const now = this.clock.now();
        const refund = payment.status === 'paid';
        await trx
          .updateTable('payments')
          .set({
            status: refund ? 'refunded' : 'cancelled',
            cancelled_at: now,
            cancel_reason: reason,
          })
          .where('id', '=', payment.id)
          .execute();
        if (refund) await this.billing.revoke(trx, payment.order_id, now);
        else {
          await trx
            .updateTable('orders')
            .set({ status: 'cancelled', updated_at: now })
            .where('id', '=', payment.order_id)
            .execute();
        }
        return { transaction: payment.id, cancel_time: now.getTime(), state: refund ? -2 : -1 };
      }
      return {
        transaction: payment.id,
        cancel_time: ms(payment.cancelled_at),
        state: STATE[payment.status],
      };
    });
  }

  private async check(id: string): Promise<Record<string, unknown>> {
    const payment = await this.findPayment(this.db, id);
    if (!payment) throw new PaymeFault(PaymeError.TRANSACTION_NOT_FOUND);
    return {
      create_time: ms(payment.created_at),
      perform_time: ms(payment.paid_at),
      cancel_time: ms(payment.cancelled_at),
      transaction: payment.id,
      state: STATE[payment.status],
      reason: payment.cancel_reason,
    };
  }

  /** Transactions Payme created in [from, to], for its reconciliation. */
  private async statement(from: number, to: number): Promise<Record<string, unknown>> {
    const rows = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('provider', '=', 'payme')
      .where('provider_created_at', '>=', new Date(from))
      .where('provider_created_at', '<=', new Date(to))
      .orderBy('provider_created_at')
      .limit(10_000)
      .execute();
    return {
      transactions: rows.map((p) => ({
        id: p.provider_txn_id,
        time: ms(p.provider_created_at),
        amount: Number(p.amount_tiyin),
        account: { order_id: p.order_id },
        create_time: ms(p.created_at),
        perform_time: ms(p.paid_at),
        cancel_time: ms(p.cancelled_at),
        transaction: p.id,
        state: STATE[p.status],
        reason: p.cancel_reason,
      })),
    };
  }

  /**
   * The order behind an account, checked for amount and state.
   * @throws PaymeFault -31050 unknown order, -31001 wrong amount, -31051
   *   when it can no longer be paid.
   */
  private async payableOrder(
    db: Kysely<Database>,
    orderId: string,
    amountTiyin: number,
    lock = false,
  ) {
    if (!UUID.test(orderId)) throw new PaymeFault(PaymeError.ORDER_NOT_FOUND, 'order_id');
    let query = db
      .selectFrom('orders')
      .select(['id', 'status', 'amount_tiyin', 'expires_at', 'provider'])
      .where('id', '=', orderId);
    if (lock) query = query.forUpdate();
    const order = await query.executeTakeFirst();
    if (!order || order.provider !== 'payme') {
      throw new PaymeFault(PaymeError.ORDER_NOT_FOUND, 'order_id');
    }
    if (Number(order.amount_tiyin) !== amountTiyin) throw new PaymeFault(PaymeError.WRONG_AMOUNT);
    const expired = order.status === 'created' && order.expires_at <= this.clock.now();
    if (expired || (order.status !== 'created' && order.status !== 'pending')) {
      throw new PaymeFault(PaymeError.ORDER_NOT_PAYABLE, 'order_id');
    }
    return order;
  }

  /**
   * Runs `work` in a transaction. When it returns {@link LATE}, the changes
   * it made (cancelling a timed-out transaction) are committed and the call
   * then fails with -31008, as Payme expects.
   */
  private async inTransaction(
    work: (trx: Transaction<Database>) => Promise<Record<string, unknown> | typeof LATE>,
  ): Promise<Record<string, unknown>> {
    const result = await this.db.transaction().execute(work);
    if (result === LATE) throw new PaymeFault(PaymeError.CANNOT_PERFORM);
    return result;
  }

  /** Cancels (reason 4) a created transaction that is older than 12 hours. */
  private async cancelIfLate(trx: Transaction<Database>, payment: PaymentRow): Promise<boolean> {
    const now = this.clock.now();
    if (now.getTime() - payment.created_at.getTime() <= TRANSACTION_TIMEOUT_MS) return false;
    await trx
      .updateTable('payments')
      .set({ status: 'cancelled', cancelled_at: now, cancel_reason: REASON_TIMEOUT })
      .where('id', '=', payment.id)
      .execute();
    await trx
      .updateTable('orders')
      .set({ status: 'cancelled', updated_at: now })
      .where('id', '=', payment.order_id)
      .execute();
    return true;
  }

  private lockPayment(trx: Transaction<Database>, id: string) {
    return this.findPayment(trx, id, true);
  }

  private async findPayment(
    db: Kysely<Database>,
    id: string,
    lock = false,
  ): Promise<PaymentRow | undefined> {
    let query = db
      .selectFrom('payments')
      .select([
        'id',
        'order_id',
        'provider_txn_id',
        'amount_tiyin',
        'status',
        'provider_created_at',
        'created_at',
        'paid_at',
        'cancelled_at',
        'cancel_reason',
      ])
      .where('provider', '=', 'payme')
      .where('provider_txn_id', '=', id);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** Fiscal receipt items for the OFD, once the IKPU code is configured. */
  private receipt(amountTiyin: number): Record<string, unknown> | null {
    const fiscal = this.rules.fiscal;
    if (!fiscal) return null;
    return {
      receipt_type: 0,
      items: [
        {
          title: fiscal.title,
          price: amountTiyin,
          count: 1,
          code: fiscal.ikpuCode,
          package_code: fiscal.packageCode,
          vat_percent: fiscal.vatPercent,
        },
      ],
    };
  }

  private error(id: unknown, code: number, data?: string): Record<string, unknown> {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message: MESSAGES[code] ?? MESSAGES[PaymeError.SYSTEM],
        ...(data ? { data } : {}),
      },
    };
  }

  private async log(
    method: string,
    externalId: string | null,
    authValid: boolean,
    payload: Record<string, unknown>,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .insertInto('payment_callbacks')
      .values({
        id: newId(),
        provider: 'payme',
        method,
        external_id: externalId,
        auth_valid: authValid,
        payload,
        response,
        received_at: this.clock.now(),
      })
      .execute();
  }
}
