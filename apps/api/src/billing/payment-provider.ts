/**
 * One adapter per payment provider (ADR-0008). This step needs the checkout
 * page; `chargeSavedToken`, `refund` and `getStatus` join the interface with
 * saved cards and admin refunds. Each adapter also owns its provider's
 * callback endpoint, because every provider speaks its own protocol.
 */
export interface CheckoutRequest {
  orderId: string;
  amountTiyin: number;
  /** Where the provider sends the parent afterwards; null uses the provider's default. */
  returnUrl: string | null;
  /** The parent's language, for the provider's page. */
  locale: string;
}

export abstract class PaymentProvider {
  abstract readonly code: 'payme' | 'click';
  /** The provider's hosted payment page for this order. Card data never reaches us. */
  abstract checkoutUrl(request: CheckoutRequest): string;
}

/** Injection token: the enabled adapters by provider code (a Map). */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
