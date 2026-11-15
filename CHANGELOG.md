# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Design documents: PRD, architecture overview, ADR 0001–0009, database schema,
  OpenAPI contract, STRIDE threat model, security plan and UX specification.
- pnpm + Turborepo monorepo with strict TypeScript, ESLint (with security rules),
  Prettier, commitlint and Git hooks.
- `@mathpath/config`: business rules in `config/*.yaml`, validated at start-up.
- `apps/api`: NestJS API skeleton with `GET /api/v1/health`, environment
  validation, security headers and a CORS allow-list.
- `apps/worker`: background worker skeleton.
- `apps/web` and `apps/studio`: Next.js app skeletons with security headers.
- Local PostgreSQL and Redis through Docker Compose; production Dockerfile for the API.
- `@mathpath/db`: Kysely database layer, reversible migrations (identity, family,
  risk, audit, outbox tables) and PGlite-based tests that run up → down → up.
- CI (format, lint, typecheck, tests with an 80% coverage gate, build) and security
  scanning (gitleaks, pnpm audit, OSV-Scanner, Semgrep, CodeQL); Renovate.
