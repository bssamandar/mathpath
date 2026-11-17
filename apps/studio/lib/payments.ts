/**
 * Payments and refunds in the studio (API: /admin/payments). Pure helpers,
 * tested in payments.test.ts; the page renders and calls the API.
 */

export type PaymentStatus =
  | 'pending'
  | 'paid'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded'
  | 'failed';
export type RefundStatus = 'requested' | 'succeeded' | 'failed';

export interface Money {
  amountTiyin: number;
  currency: 'UZS';
}

export interface Refund {
  refundId: string;
  paymentId: string;
  status: RefundStatus;
  amount: Money;
  reason: string;
  requestedBy: string | null;
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
  refunds: Refund[];
}

/** 9 900 000 tiyin → "99 000 so‘m" (kopecks shown only when there are some). */
export function formatSum(money: Money): string {
  const whole = Math.floor(money.amountTiyin / 100);
  const part = money.amountTiyin % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped}${part ? `,${String(part).padStart(2, '0')}` : ''} so‘m`;
}

/** A refund that is asked for or done; a failed one does not block another try. */
export function liveRefund(payment: AdminPayment): Refund | undefined {
  return payment.refunds.find((r) => r.status === 'requested' || r.status === 'succeeded');
}

/** Only a paid payment with no refund under way can be refunded. */
export function canRefund(payment: AdminPayment): boolean {
  return payment.status === 'paid' && !liveRefund(payment);
}

/** The reason rule the API applies (5–500 characters), checked before sending. */
export function reasonProblem(reason: string): 'short' | 'long' | null {
  const length = reason.trim().length;
  if (length < 5) return 'short';
  if (length > 500) return 'long';
  return null;
}

/** The request body: always the whole amount, as the providers refund whole payments. */
export function refundBody(payment: AdminPayment, reason: string) {
  return { amountTiyin: payment.amount.amountTiyin, reason: reason.trim() };
}
