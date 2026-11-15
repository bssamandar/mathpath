# ADR-0001: TypeScript monorepo (pnpm workspaces + Turborepo)

- Status: Proposed
- Date: 2026-11-15

## Context

One person (Samandar) maintains the codebase. The system has two web front-ends, an
API and a worker that share types (API contract, question model, config).
Phase 1 approved TypeScript end to end.

## Decision

Use a single repository with pnpm workspaces and Turborepo, written in TypeScript
(strict mode) everywhere: Next.js for the front-ends, NestJS for the API and worker,
Node.js LTS runtime.

## Alternatives considered

- **Python backend (Django/FastAPI) + TypeScript front-end.** A great ecosystem,
  but two languages, duplicated validation and types, and two toolchains for one
  maintainer.
- **Nx instead of Turborepo.** More powerful generators and boundary rules, but
  heavier and more opinionated. Turborepo plus eslint-plugin-boundaries covers our
  needs with less configuration.
- **Separate repositories per app.** Cross-cutting changes (an API field plus its
  UI) would need several coordinated PRs.

## Consequences

- One `pnpm install`, one lint config, one CI pipeline. Types flow from the
  OpenAPI contract to both server and client.
- Turborepo caching keeps CI fast as the repo grows.
- We must enforce module boundaries with lint rules, because a monorepo makes
  accidental imports easy.
