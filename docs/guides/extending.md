# Extending MathPath

How to add the four things that will change most often. Each section is filled
in with exact file paths and commands as the corresponding module is built in
Phase 6. Until then, it records the intended steps from the architecture
([architecture §8](../architecture.md)).

## Add a new grade or course

_Status: content model arrives in step 6.3._

1. In the Studio, create the course under its track (for example School → Grade 6).
2. Create chapters and topics in textbook order.
3. Link each topic to its prerequisites in the knowledge graph (cycles are rejected).
4. Map topics to equivalent topics in other tracks where they exist.
5. Write lessons and question templates, and send them through review.

No code changes are needed.

## Add a topic

_Status: arrives in step 6.3._

Same as above for a single topic. Mark it `is_free` if it is the first topic of
its chapter.

## Add a question type

_Status: question engine arrives in step 6.4._

1. `packages/question-engine`: add a generator and grader for the type, with tests.
2. `packages/question-render`: add the client renderer (no answers on the client).
3. `apps/studio`: add the editor form.
4. Add the type to `config/content.yaml` → `questionTypes` and to the
   `QuestionType` enum in `docs/api/openapi.yaml`.

## Add a payment provider

Payme (`apps/api/src/billing/payme/`, JSON-RPC with a key) and Click
(`apps/api/src/billing/click/`, form posts with an MD5 signature) are the worked
examples.

1. Extend `PaymentProvider` (`apps/api/src/billing/payment-provider.ts`,
   [ADR-0008](../adr/0008-payment-provider-adapters.md)) with the provider's
   checkout URL, and give the adapter a `handle()` for its callbacks that
   authenticates the provider before parsing anything else.
2. Register it in `billing.module.ts` with a factory that returns `null` unless
   the code is listed in `PAYMENT_PROVIDERS`, and otherwise adds it to the
   providers map. Add a route to `PaymentCallbacksController` with
   `@Access('provider:<code>')`.
3. On payment call `BillingService.fulfil()` and on a refund `revoke()`, both
   inside the transaction that changes the payment row.
4. Add tests: valid callback, forged, replayed, wrong amount, duplicate, timeout.
5. Add the code to the `provider` checks in a migration, its keys to
   `apps/api/src/config/env.ts` and `.env.example` (placeholders only), and to
   `PaymentProviderCode` in the OpenAPI contract.
