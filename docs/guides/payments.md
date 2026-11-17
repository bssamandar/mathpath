# Payments, refunds and reconciliation

How money moves in MathPath and what to do when it does not add up (ADR-0008;
security plan C-27, C-28, §9). Provider set-up is in the launch checklist;
settings are in `infra/env.prod.example`.

## How a payment works

| Step          | Payme (Merchant API, JSON-RPC)                         | Click (Shop API, form posts)                            |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| Parent pays   | Payme's checkout page                                  | Click's payment page                                    |
| Provider asks | `CheckPerformTransaction`, `CreateTransaction`         | Prepare (`action=0`)                                    |
| Money taken   | `PerformTransaction` → payment `paid`, subscription on | Complete (`action=1`) → payment `paid`, subscription on |
| Refund        | `CancelTransaction` after perform → `refunded`         | Merchant API reversal, started by us                    |
| Every call    | Logged raw in `payment_callbacks`, authenticated first | The same                                                |

Payments move forward only (`pending → paid → refunded`, enforced by a
database trigger), and one live payment exists per order.

## Refunding a payment

Studio → **To‘lovlar**: search by the parent's phone number, or by a payment,
order or user ID. A paid payment with no refund under way has a **Pulni
qaytarish** button. Write the reason (it goes to the audit log) and confirm.

Payme and Click refund **whole payments only**, so there are no partial refunds.
The subscription the payment bought ends when the money is returned.

- **Click:** the API reverses the payment through Click's Merchant API at once.
  The answer is "returned" or Click's reason for refusing. Click reverses only
  successful card payments made in the current month (payments from the previous
  month only on the 1st), and UZCARD may refuse. A refused refund can be tried
  again, or done in the Click cabinet.
  If the answer says "no answer from Click", **check the Click cabinet before
  trying again**: Click may have reversed it without us hearing back. If it
  did, record it by hand as in "Fixing a mismatch" (payment `refunded`,
  subscription ended, refund `succeeded`) instead of asking Click again.
- **Payme:** Payme's Merchant API does not let the merchant start a refund. The
  studio records the request and shows the Payme transaction ID. Open the Payme
  business cabinet, find that transaction and cancel it. Payme then calls
  `CancelTransaction`, and the refund completes here by itself: payment
  `refunded`, subscription ended, refund `succeeded`. A cancel done in the
  cabinet without a request in the studio is recorded too, with no admin and
  the reason "Cancelled in Payme".

Click refunds need `CLICK_MERCHANT_USER_ID` (Click cabinet → Merchant API
user). Without it the studio says so, and Click refunds are done in the Click
cabinet; the reconciliation then reports them until they are recorded.

Four-eyes approval for large refunds (security plan §9) comes after launch.

## Daily reconciliation

The worker checks the books every day at 06:00 Tashkent time and at start.
The counts go to `mathpath_billing_reconciliation_mismatches{check}`; any count
above zero fires **BillingReconciliationMismatch**. The worker log line
(`billing-reconciliation`) lists the first IDs for each check.

| Check                       | Means                                                                   | First step                                                                                            |
| --------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `paid_without_subscription` | Money taken, nothing granted                                            | Find the order's callbacks in `payment_callbacks`; grant the subscription by hand or refund           |
| `order_payment_mismatch`    | An order says paid but no payment does, or the other way round          | Compare with the provider cabinet; the callbacks log shows what the provider told us                  |
| `amount_mismatch`           | A payment's amount differs from its order's                             | Should be impossible (the adapters check amounts): treat as a possible forgery, look at the callbacks |
| `refund_not_revoked`        | Money returned but the subscription still runs                          | End the subscription by hand (set `status = 'cancelled'`, `current_period_end = now()`)               |
| `refund_record_mismatch`    | A refund row and its payment disagree                                   | Usually a cabinet refund we did not hear about, or a Click refund with no answer: check the cabinet   |
| `stuck_payment`             | A payment waits on the provider for over a day                          | Look it up in the provider cabinet; Payme cancels its own after 12 hours when it calls us             |
| `stale_refund_request`      | A Payme refund was requested over 3 days ago and not cancelled at Payme | Cancel the transaction in the Payme cabinet, or tell the parent why not                               |

### Fixing a mismatch

Fix data by hand only with a written reason, in one transaction, as the
`mathpath_migrator` role (the app role cannot bypass the audit log), and note
what you did in the incident record. The payment trigger stops a payment from
moving backwards; that is deliberate.

### Comparing with the providers' statements (monthly, by hand)

The automatic checks compare our own records. Once a month, export the
month's transactions from the Payme and Click cabinets and compare totals and
counts with:

```sql
SELECT provider, status, count(*), sum(amount_tiyin) / 100 AS sum
FROM payments
WHERE coalesce(paid_at, created_at) >= date_trunc('month', now() - interval '1 month')
  AND coalesce(paid_at, created_at) <  date_trunc('month', now())
GROUP BY provider, status ORDER BY provider, status;
```

Payme has no statement API for merchants. Click's payment-status API could
automate this once Click confirms what each `payment_status` value means; until
then a wrong guess would page someone for nothing.
