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

_Status: billing arrives in step 6.5._

1. Implement the `PaymentProvider` interface in a new adapter
   ([ADR-0008](../adr/0008-payment-provider-adapters.md)), including
   callback authentication before any parsing.
2. Add adapter tests: valid callback, forged, replayed, wrong amount, duplicate.
3. Add the provider to `config/billing.yaml` and its keys to `.env.example`
   (placeholders only).
4. Add the provider to `PaymentProviderCode` in the OpenAPI contract.
