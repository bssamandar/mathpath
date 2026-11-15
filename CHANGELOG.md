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
- Sign-up and sign-in for parents (`apps/api` identity module): SMS one-time
  codes with per-phone, per-network and resend limits; enumeration-safe responses;
  Argon2id passwords with common and breached password checks; EdDSA access
  tokens; rotating refresh tokens that revoke the session on reuse; HttpOnly
  cookies; a session-bound CSRF token (ADR-0010); logout with immediate revocation.
- `config/auth.yaml` for token lifetimes, OTP resend delay and password rules.
- Migration `2026111502_terms_acceptance`: the terms version each user accepted.
- Errors are returned as RFC 9457 problem details with a stable `code` and request ID.
- CI (format, lint, typecheck, tests with an 80% coverage gate, build) and security
  scanning (gitleaks, pnpm audit, OSV-Scanner, Semgrep, CodeQL); Renovate.
