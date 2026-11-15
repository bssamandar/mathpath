# ADR-0007: Transactional outbox and BullMQ for domain events and jobs

- Status: Proposed
- Date: 2026-11-15

## Context

A single answer causes effects in several modules (mastery, XP, quests,
anti-cheat). A payment causes subscription, receipt, referral and audit effects.
These must happen exactly once in effect, even if the process crashes.

## Decision

- Modules write events to an `outbox_events` table **in the same transaction**
  as the state change.
- The worker relays new outbox rows to **BullMQ** (Redis) queues. Consumers are
  **idempotent**: each handler records `(event_id, handler)` in
  `processed_events` and skips duplicates.
- Scheduled jobs (renewals, weekly reports, league rollover, deletions) use
  BullMQ repeatable jobs.

## Alternatives considered

- **Publish straight to the queue after commit.** Events are lost if the
  process dies between the commit and the publish.
- **RabbitMQ or Kafka.** Stronger delivery semantics and replay, but extra
  infrastructure to run and secure. Redis is already needed for caching and rate
  limits.

## Consequences

- At-least-once delivery with idempotent handlers gives effectively-once results.
- The outbox needs a cleanup job (keep processed rows for 7 days).
