# ADR-0004: PostgreSQL, Kysely and reversible migrations; UUIDv7 keys

- Status: Proposed
- Date: 2026-11-15

## Context
The data is relational (users, enrolments, payments) with some document-shaped
parts (versioned lesson content, question templates). The brief requires
versioned migrations with rollback.

## Decision
- **PostgreSQL 16+** as the single source of truth. JSONB for versioned content
  documents and question templates.
- **Kysely** (a type-safe SQL query builder) for queries, and its migrator for
  **up/down migrations** written in TypeScript.
- **UUIDv7** primary keys: unguessable and time-ordered, so B-tree indexes
  stay compact.
- Money as `bigint` tiyin. Timestamps as `timestamptz` in UTC.
- Monthly partitions for large append-only tables.

## Alternatives considered
- **Prisma.** Excellent developer experience, but its migrations have no
  built-in down/rollback, it hides SQL, and it is weaker on partitioning and
  advanced Postgres features.
- **TypeORM.** Supports down migrations, but has a history of type-safety gaps
  and surprising behaviour.
- **MongoDB.** Flexible for content, but payments, consent and progress need
  relational integrity and transactions.
- **bigserial IDs.** Smaller, but enumerable (they invite IDOR probing) and
  they leak business volume.

## Consequences
- Queries read like SQL, which is easy to reason about and tune.
- Every migration must ship a working `down`. CI runs up → down → up on an empty
  database.
