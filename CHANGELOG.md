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
- Permissions: every route declares `@Access(...)`; undeclared routes are refused,
  staff permissions need 2FA, and a route-scan test keeps code and the OpenAPI
  `x-permission` values in sync (C-09).
- Audit log with a SHA-256 hash chain for sign-up, sign-in, failed sign-in,
  logout and refresh-token reuse, plus `verifyAuditChain` to detect edits (C-33).
- Risk scoring for code requests and sign-in (security plan §6.2): flagged
  phone prefixes, automated clients, per-network code velocity, recent failures
  and new networks; actions from config (allow, Turnstile CAPTCHA, interactive
  CAPTCHA, block with a manual review); every decision stored as a `risk_event`.
- SMS spend guard with hourly and daily caps in Tashkent time; at the cap every
  code request needs a CAPTCHA (C-20). Account lock after 10 failures in an hour,
  with an SMS to the owner (C-04).
- Redis-backed rate limiter, counters and revoked-session list (Lua scripts,
  atomic across instances); Eskiz.uz SMS sender; Cloudflare Turnstile verifier.
- Children and family (`apps/api` family module): parents add a child with
  consent confirmed by a `confirm_action` SMS code to their own phone; consent
  history is kept, never edited; nicknames are unique per family; trivial PINs
  are refused. Children sign in with family code, nickname and PIN; wrong PINs
  lock the profile and notify the parent; failures per family code are limited.
  Parents can switch to a child profile (linked session). A student keeps at
  most two live sessions (C-24).
- Staff 2FA (C-08): TOTP enrolment and verification (`/auth/mfa/totp`,
  `/auth/mfa/verify`) with secrets encrypted at rest, replay protection per time
  step, ten one-time recovery codes and a per-user limit on wrong codes. Staff
  sessions end after 8 hours, or 30 minutes idle (`config/auth.yaml`).
- Web app sign-in screens (`apps/web`): welcome with language choice, parent
  sign-up (phone, SMS code, name and password), parent sign-in, student sign-in
  with family code and PIN, and placeholder home pages. Texts in Uzbek, Russian
  and English. Turnstile appears when the API asks for a CAPTCHA. Tokens stay
  in HttpOnly cookies; refreshes are serialised across tabs (Web Locks). A
  per-request CSP nonce is set in middleware.
- Content (`apps/api` content module, migration `2026111601_content`): tracks,
  courses, chapters, topics and versioned lessons with a draft → review →
  publish workflow (four-eyes review, ETag-protected saves, one open draft per
  topic, published versions frozen by a database trigger). Catalogue API in the
  reader's language; free topics open, paid topics answer 402 until billing.
  `pnpm db:seed` loads three demo grade 5 fraction topics in Uzbek and Russian.
- `config/auth.yaml` for token lifetimes, OTP resend delay and password rules.
- Migration `2026111502_terms_acceptance`: the terms version each user accepted.
- Errors are returned as RFC 9457 problem details with a stable `code` and request ID.
- CI (format, lint, typecheck, tests with an 80% coverage gate, build) and security
  scanning (gitleaks, pnpm audit, OSV-Scanner, Semgrep, CodeQL); Renovate.
