import { describe, expect, it } from 'vitest';
import {
  type AdminPayment,
  canRefund,
  formatSum,
  liveRefund,
  reasonProblem,
  type Refund,
  refundBody,
} from './payments';

const money = (amountTiyin: number) => ({ amountTiyin, currency: 'UZS' as const });

const refund = (status: Refund['status']): Refund => ({
  refundId: `r-${status}`,
  paymentId: 'p1',
  status,
  amount: money(9_900_000),
  reason: 'Parent asked',
  requestedBy: 'a1',
  failure: status === 'failed' ? '-5017: no' : null,
  createdAt: '2026-12-01T10:00:00Z',
  completedAt: status === 'requested' ? null : '2026-12-01T10:00:01Z',
});

const payment = (over: Partial<AdminPayment> = {}): AdminPayment => ({
  id: 'p1',
  orderId: 'o1',
  provider: 'click',
  providerTxnId: '555',
  amount: money(9_900_000),
  status: 'paid',
  planCode: 'individual_monthly',
  owner: { id: 'u1', firstName: 'Aziza', phoneMasked: '+99890*****67' },
  createdAt: '2026-12-01T09:00:00Z',
  paidAt: '2026-12-01T09:01:00Z',
  cancelledAt: null,
  refunds: [],
  ...over,
});

describe('formatSum', () => {
  it('groups thousands and shows tiyin only when present', () => {
    expect(formatSum(money(9_900_000))).toBe('99 000 so‘m');
    expect(formatSum(money(123_456_705))).toBe('1 234 567,05 so‘m');
    expect(formatSum(money(50))).toBe('0,50 so‘m');
  });
});

describe('refunds', () => {
  it('allows a refund of a paid payment with no live refund', () => {
    expect(canRefund(payment())).toBe(true);
    expect(canRefund(payment({ refunds: [refund('failed')] }))).toBe(true);
    expect(canRefund(payment({ refunds: [refund('requested')] }))).toBe(false);
    expect(canRefund(payment({ status: 'refunded', refunds: [refund('succeeded')] }))).toBe(false);
    expect(canRefund(payment({ status: 'pending' }))).toBe(false);
  });

  it('finds the live refund, skipping failed tries', () => {
    expect(liveRefund(payment({ refunds: [refund('failed'), refund('requested')] }))?.status).toBe(
      'requested',
    );
    expect(liveRefund(payment({ refunds: [refund('failed')] }))).toBeUndefined();
  });

  it('checks the reason as the API does and always sends the whole amount', () => {
    expect(reasonProblem('  no  ')).toBe('short');
    expect(reasonProblem('x'.repeat(501))).toBe('long');
    expect(reasonProblem('Parent asked')).toBeNull();
    expect(refundBody(payment(), '  Parent asked  ')).toEqual({
      amountTiyin: 9_900_000,
      reason: 'Parent asked',
    });
  });
});
