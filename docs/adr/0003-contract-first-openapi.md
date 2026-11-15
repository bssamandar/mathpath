# ADR-0003: Contract-first API with OpenAPI 3.1

- Status: Proposed
- Date: 2026-11-15

## Context
The brief requires an API-first design. Future native mobile apps and school
integrations will use the same API.

## Decision
`packages/contracts/openapi.yaml` is the source of truth. From it we generate
TypeScript types and a typed client (openapi-typescript), plus Zod request
validators used by the API. CI fails if generated code is out of date, or if the
API's responses don't match the spec (contract tests).

Conventions: REST under `/api/v1`, JSON, errors as RFC 9457
`application/problem+json`, cursor pagination, `Idempotency-Key` on payment and
submission POSTs, UUIDv7 IDs.

## Alternatives considered
- **Code-first (NestJS Swagger decorators).** Less duplication, but the spec
  becomes a by-product. It is easy to break clients without noticing, and the
  contract cannot be reviewed before code exists.
- **GraphQL.** Flexible queries, but harder caching on slow networks, harder
  per-field authorisation, and more for one person to maintain.
- **tRPC.** Great type sharing, but tied to TypeScript clients and not a public
  contract for mobile or partners.

## Consequences
- Every API change starts as a reviewable diff to the spec.
- Slightly more writing up front; generators remove most of the repetition.
