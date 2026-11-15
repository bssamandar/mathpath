# ADR-0008: Payment provider adapters, integer money and layered idempotency

- Status: Proposed
- Date: 2026-11-15

## Context
The MVP launches with Payme and Click. Uzum Bank, direct Uzcard/Humo and
Visa/Mastercard come later. Each provider has its own callback protocol and
authentication. Payments must never be duplicated or lost, and card data must
never touch our servers.

## Decision
- A `PaymentProvider` interface: `createCheckout`, `handleCallback`,
  `chargeSavedToken`, `refund`, `getStatus`. One adapter per provider, selected by
  config.
- Money as `bigint` **tiyin**. The plan price is snapshotted onto the order at
  creation.
- Idempotency at three levels: our `Idempotency-Key` header, a unique
  `(provider, provider_txn_id)` constraint, and a forward-only payment state
  machine.
- Every callback is authenticated using the provider's own mechanism before
  parsing business data. It is stored raw in `payment_callbacks` for audit and
  replay.
- We store only provider tokens, card last 4 digits, expiry and a provider-issued
  card fingerprint (used for the one-trial-per-card rule).

## Alternatives considered
- **Single aggregator for everything.** Fewer integrations, but higher fees, less
  control over recurring payments, and dependence on one vendor.
- **Floats or decimal UZS.** Rounding bugs; providers such as Payme already work
  in tiyin.

## Consequences
- Adding a provider means one adapter, its tests and one config entry (documented
  in the "how to add a payment provider" guide).
- A daily reconciliation job compares our payments with the provider's statement
  and alerts on mismatches.
