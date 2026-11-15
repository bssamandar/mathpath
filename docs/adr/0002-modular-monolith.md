# ADR-0002: Modular monolith with a separate worker process

- Status: Proposed
- Date: 2026-11-15

## Context

The domains (identity, content, assessment, learning, billing, gamification...)
are clearly separable, but the team is one person, and the MVP load (~5k concurrent
users) fits comfortably in one horizontally scaled service.

## Decision

Build one NestJS API split into domain modules with strict public interfaces,
plus a worker app built from the same code for background jobs. Modules
communicate through in-process calls to public services and through domain events
(see ADR-0007). Each module owns its tables.

## Alternatives considered

- **Microservices.** Independent scaling and deploys, but network calls,
  distributed transactions, many pipelines and much harder debugging. That
  cost is not justified for one maintainer or for this load.
- **Unstructured monolith.** The fastest start, but boundaries erode and the code
  becomes hard to change or split.

## Consequences

- One deploy, one database, real ACID transactions across a request.
- A module can be extracted later (video processing and payments are the likely
  candidates) because callers already use its interface and events.
- Boundary discipline relies on lint rules and code review.
