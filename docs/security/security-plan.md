# MathPath: Security Plan

|           |                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------- |
| Status    | Draft for approval (Phase 4)                                                                        |
| Version   | 0.1.0                                                                                               |
| Date      | 2026-11-15                                                                                          |
| Standards | OWASP Top 10 (2021), OWASP ASVS 4.0 **Level 2** target, Uzbekistan Law "On Personal Data" (ZRU-547) |
| Related   | [Threat model](threat-model.md) · [Architecture](../architecture.md)                                |

Every control has an ID (**C-xx**) that the [threat model](threat-model.md) refers
to. Each control states **how it is enforced** (code, config, CI or process),
because a control that only exists in a document will be forgotten.

---

## 1. Principles

1. **Deny by default.** Every route, DB role, network path and outbound host is
   closed unless explicitly opened.
2. **The server decides.** Grading, XP, prices, permissions and entitlements are
   computed on the server. The client is only a display.
3. **Collect less.** The safest child data is data we never store.
4. **Automate the check.** Any rule that matters gets a test, a lint rule or an
   alert.
5. **Thresholds in config.** Every limit (rates, attempts, risk weights) lives in
   `config/*.yaml` with a comment explaining the value.

**Why ASVS Level 2 and not Level 3?** Level 2 is the recommended level for
applications that handle sensitive personal data, which includes children's data.
Level 3 targets critical systems such as banking cores or medical devices, and its
extra cost (for example formal verification) is not justified here. The alternative,
Level 1, is too weak for children's data.

---

## 2. Identity and sessions

| ID   | Control                                                                                                                                                                                                                                                                                                                                                                    | Enforcement                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| C-01 | **Passwords:** minimum 10 characters, maximum 128, no composition rules (NIST 800-63B), checked against a list of common passwords                                                                                                                                                                                                                                         | Zod schema + `identity` service; unit tests                      |
| C-02 | **Argon2id hashing** (initial parameters: m = 64 MiB, t = 3, p = 1, tuned so a hash takes ~250 ms on production hardware). Parameters in config; old hashes rehashed on login. **Breached-password check** through a k-anonymity range API (only the first 5 hex chars of the SHA-1 are sent). If the API is down, the check is skipped and logged, never blocking sign-up | `identity/password.ts`; tests                                    |
| C-03 | **OTP:** 6 digits, valid 5 minutes, max 5 attempts per challenge, code stored as HMAC-SHA-256. The response is identical whether or not the phone exists, with constant-time delays                                                                                                                                                                                        | `identity/otp.ts`; tests for enumeration-safe responses          |
| C-04 | **Login limits:** sliding windows in Redis per account (5 failures/15 min → progressive delay; 10 → temporary lock + SMS to owner), per IP prefix (30/15 min), and per family code for child PINs (lock after 5)                                                                                                                                                           | `config/limits.yaml`; integration tests                          |
| C-05 | **New-device login alert** by SMS or in-app notification, with a "This wasn't me" link that revokes all sessions                                                                                                                                                                                                                                                           | `identity` + `notifications`                                     |
| C-06 | **Tokens:** EdDSA JWT access token (15 min; `alg` pinned, `kid` required, `iss`/`aud` checked) + opaque refresh token (30 days, SHA-256 hashed, rotated on use, **reuse revokes the family**). Signing keys rotate every 90 days, with the old key accepted for 15 minutes after rotation                                                                                  | `identity/tokens.ts`; tests for reuse detection                  |
| C-07 | **Browser cookies:** `HttpOnly; Secure; SameSite=Lax`, `__Host-` prefix, refresh cookie path-scoped to `/api/v1/auth/refresh`. **CSRF:** token in `X-CSRF-Token` (an HMAC of the session ID, returned at sign-in; [ADR-0010](../adr/0010-csrf-token-bound-to-session.md)), required on non-GET requests                                                                    | Global NestJS guard; e2e test                                    |
| C-08 | **Staff 2FA (TOTP)** mandatory for `author`, `reviewer`, `admin`, `support`. A staff role cannot be granted to a user without confirmed 2FA. TOTP step replay blocked (`last_used_step`). Recovery codes hashed. Staff sessions expire after 8 hours of total time and 30 minutes idle                                                                                     | Guard checks `session.mfa_verified` for staff permissions; tests |

---

## 3. Authorisation

| ID   | Control                                                                                                                                                                                                                                                                                                       | Enforcement                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| C-09 | **RBAC on every request.** A global guard reads `@Permissions('progress:read')` on each handler. Routes without a declaration are **denied**. A unit test enumerates all routes and fails if any lacks a declaration or is missing from the OpenAPI `x-permission` list                                       | `identity/permissions.ts` (role → permission map in code); route-scan test |
| C-10 | **Object-level authorisation (anti-IDOR).** Shared policy functions such as `assertCanAccessStudent(actor, studentId)` cover: self, linked parent, teacher of a class with `teacher_sharing` consent, staff with an audited reason. Not-found and forbidden return the same 404 where existence must not leak | `identity/policies/*.ts`; generated IDOR tests (C-41)                      |
| C-14 | **Least privilege for staff.** `support` sees masked phone numbers and no learning data; `admin` actions require a written reason, which is stored in the audit log. Quarterly review of who has staff roles                                                                                                  | Permission map; audit log; calendar process                                |

**Role → permission summary (MVP)**

| Permission                                 | student | parent       | teacher                 | author | reviewer | admin        | support                                               |
| ------------------------------------------ | ------- | ------------ | ----------------------- | ------ | -------- | ------------ | ----------------------------------------------------- |
| `learning:write`, `assessment:take`        | ✅      |              |                         |        |          |              |                                                       |
| `progress:read` (object-checked)           | own     | own children | consented class members |        |          | ✅ (audited) |                                                       |
| `family:*`, `billing:*`, `privacy:request` |         | ✅           |                         |        |          |              |                                                       |
| `classroom:manage`                         |         |              | ✅                      |        |          |              |                                                       |
| `content:author`                           |         |              |                         | ✅     | ✅       |              |                                                       |
| `content:review` (not own)                 |         |              |                         |        | ✅       |              |                                                       |
| `content:publish`                          |         |              |                         |        | ✅       | ✅           |                                                       |
| `admin:users`, `admin:risk`                |         |              |                         |        |          | ✅           | read only (with the support console; none until then) |
| `admin:billing`, `admin:audit`             |         |              |                         |        |          | ✅           |                                                       |

---

## 4. Input, output and web security

| ID   | Control                                                                                                                                                                                                                                                                                                          | Enforcement                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| C-11 | **SQL injection:** Kysely parameterised queries only. `sql.raw` and string-built SQL are banned by an ESLint rule. The DB user of each app has only the grants it needs                                                                                                                                          | Lint rule; SAST (Semgrep)                |
| C-12 | **Validation:** every request body, query and path parameter is validated against Zod schemas generated from OpenAPI; `additionalProperties: false`; size limits (body ≤ 100 KB except uploads, which go directly to storage). **Responses** are validated in tests, so we never leak fields such as answer keys | Generated validators; contract tests     |
| C-13 | **XSS:** React auto-escaping; no `dangerouslySetInnerHTML` (lint rule) except in the audited KaTeX renderer with `trust: false` and `strict: true`. Authors write structured documents, not HTML. Nicknames are limited to letters, digits, space and `_-`                                                       | Lint rules; unit tests with XSS payloads |
| C-15 | **Security headers** (set by the reverse proxy and Next.js middleware)                                                                                                                                                                                                                                           | Header test in CI (see below)            |

**Headers for `web`** (studio is stricter: no third-party sources at all):

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-{random}' 'strict-dynamic';
  style-src 'self' 'nonce-{random}'; img-src 'self' data: https://cdn.mathpath.uz;
  media-src 'self' blob: https://cdn.mathpath.uz; connect-src 'self' https://api.mathpath.uz;
  font-src 'self'; frame-src https://{captcha-provider}; frame-ancestors 'none';
  base-uri 'none'; form-action 'self' https://checkout.paycom.uz https://my.click.uz;
  object-src 'none'; upgrade-insecure-requests
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-site
```

The payment-provider hosts in `form-action` are placeholders; they are confirmed
against the providers' documentation when the adapters are built.

**TLS:** TLS 1.3 preferred, TLS 1.2 allowed with AEAD ciphers only (some
older Android devices in the market do not support 1.3). HSTS preload. Certificates
renew automatically.
_Alternative considered:_ TLS 1.3 only, as the brief says. It is stricter, but it
would lock out Android 9 and older devices that are still common. **I recommend
allowing 1.2 at launch and checking the share of 1.2 connections after 3 months.
This deviates from the brief.** _Decision (2026-11-15): TLS 1.2 allowed at
launch, adopted from this recommendation when Phase 4 was approved; review the 1.2
share after 3 months._

---

## 5. Content and assessment integrity

| ID   | Control                                                                                                                                                                                                                                                                                                                                                                                                                 | Enforcement                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| C-16 | **Answers stay on the server.** `question-engine` cannot be imported by `web` (lint boundary rule). Instance choice IDs are random per instance. Per-item `tries` limit; the attempt state machine prevents answering after submission or deadline                                                                                                                                                                      | Lint rule; contract test asserts no answer fields in student schemas |
| C-17 | **Template sandbox.** A math.js instance with a restricted function allow-list (no `import`, `createUnit`, `evaluate`, `parse`, `simplify` of user-defined functions); expression length ≤ 200; generation runs with a 50 ms budget and max 100 constraint retries                                                                                                                                                      | `question-engine/sandbox.ts`; fuzz tests                             |
| C-18 | **Four-eyes content workflow.** A reviewer must differ from the author (enforced in the service and in a DB CHECK through the review record). Published versions are immutable (DB trigger). All transitions audited                                                                                                                                                                                                    | Service + trigger; tests                                             |
| C-19 | **Uploads.** Presigned PUT to a private bucket, with content-type and size bound into the signature. A worker checks magic bytes, re-encodes images, sanitises SVG (or rejects SVG from non-admin authors), and transcodes video. Media is served from a separate cookieless domain. **No server-side fetching of user-supplied URLs** (removes SSRF in the MVP); outbound traffic is allow-listed at the network level | `media` module; network policy                                       |

---

## 6. Abuse and fraud protection

### 6.1 Controls

| ID   | Control                                                                                                                                                                                                                                                                                                                                                                    | Enforcement                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| C-20 | **SMS pumping protection.** Limits per phone (3 per 10 min, 10 per day), per IP prefix (20 per hour), per device (5 per hour). MVP accepts only `+998` numbers. Blocked prefix list (admin-editable). **Spend guard:** an hourly and daily SMS counter; alert at 70% of the budget; at 100% a circuit breaker requires CAPTCHA on every OTP request and alerts the on-call | `config/risk.yaml`; Redis counters; alerts |
| C-21 | **Invisible CAPTCHA, escalating with risk.** Not shown at low risk; an invisible challenge at medium risk; an interactive challenge at high risk. Verified server-side                                                                                                                                                                                                     | `risk` module                              |
| C-22 | **Device fingerprinting.** The client sends coarse device signals; the API issues a signed `deviceToken` and stores only an HMAC of the fingerprint. **Disposable email** domain list (for staff and teacher emails), updated monthly                                                                                                                                      | `risk/device.ts`                           |
| C-23 | **Trial and referral fraud.** One trial per account, device and card (DB unique constraints). Referral reward only after the referred account is phone-verified and active on 7 distinct days, and has not been flagged by the risk engine                                                                                                                                 | DB constraints; `billing/referrals.ts`     |
| C-24 | **Account sharing.** Limits per plan: concurrent sessions (default 2 per student) and registered devices (default 4 per family). The oldest session is revoked when the limit is exceeded, with a notice                                                                                                                                                                   | `config/limits.yaml`; `identity`           |
| C-25 | **Cheating detection.** A nightly job flags (a) answer times under a per-question floor (derived from difficulty), (b) identical wrong-answer sequences between students in the same class or IP prefix within a time window, (c) sudden mastery jumps. Flags go to teacher or admin review. **No automatic punishment of children**                                       | `assessment/integrity-job.ts`              |
| C-26 | **Fair gamification.** XP only for server-graded events with a unique ledger key; daily XP cap; leaderboards show nickname + avatar only; a schema test asserts that no name fields exist in `League`                                                                                                                                                                      | DB constraint; contract test               |

### 6.2 Risk scoring

Each request that matters (sign-up, OTP request, login, trial start, checkout)
gets a **risk score** computed from signals. The score decides the action. The
code will live in `risk/scoring.ts` with a comment for each weight.

```
score = Σ weight(signal) for each present signal       (weights in config/risk.yaml)

signals (initial weights, tuned with real data):
  ip_is_datacenter_or_known_vpn       +25
  ip_reputation_bad                   +30
  device_seen_on_>3_accounts_24h      +30
  otp_velocity_exceeded               +20
  disposable_email                    +15
  headless_or_emulator_flags          +25
  phone_prefix_flagged                +40
  new_device_and_new_ip_prefix        +10   (login only)
  failed_logins_recent                +5 per failure, max 25

action by score:
  0–29    allow
  30–59   allow with invisible CAPTCHA
  60–79   step-up: interactive CAPTCHA + OTP re-verify; trial and referral blocked
  80+     block the action; create a risk_review for manual review
```

**Why a weighted rule score instead of a machine-learning model?** We have no
fraud data yet, and rules are transparent: an admin can see _why_ an account
was flagged. Every scored decision is logged as a `risk_event`, so a model can be
trained later. The alternative is a third-party fraud service, which is
stronger, but sends personal data abroad and conflicts with data localisation.

---

## 7. Payments

| ID   | Control                                                                                                                                                                                                                                                                                                                                                                                  | Enforcement                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| C-27 | **Callback authentication first.** Each adapter verifies the provider's authentication (Payme: merchant credentials in the `Authorization` header; Click: recomputed `sign_string`) with a constant-time compare **before** reading business fields. Then: order exists, amount equals the order amount, order state allows the transition. Optional provider IP allow-list at the proxy | Adapter tests with forged, replayed and tampered callbacks |
| C-28 | **Idempotency and integrity.** `Idempotency-Key` on our POSTs; unique `(provider, provider_txn_id)`; forward-only state transitions (DB trigger); raw callback log; **daily reconciliation** against provider statements with an alert on any mismatch                                                                                                                                   | DB constraints; reconciliation job                         |
| C-29 | **No card data.** Card entry happens only on provider pages or SDKs; we store tokens (encrypted), card mask and expiry. This keeps us out of most PCI DSS scope (the provider is responsible)                                                                                                                                                                                            | Code review rule; DB schema has no PAN column              |

Refunds require `admin:billing`, a reason, and are audited. Refunds above a
configured amount require a second admin (four-eyes) after launch.

---

## 8. Data protection and privacy

| ID   | Control                                                                                                                                                                                                                                                                                                                                                                                                          | Enforcement                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| C-30 | **Parental consent and data rights.** Consent recorded with scopes, policy version, OTP confirmation and evidence. Teacher access only with `teacher_sharing`. Export (JSON + PDF) and deletion (14-day grace, then hard delete per the data map in the schema doc) are self-service. Deletion writes an audit entry with counts only                                                                            | `family`, `privacy` modules; test that every table with a `user_id`-like column is covered |
| C-31 | **Encryption.** In transit: TLS everywhere, including inside the data centre (DB and Redis TLS). At rest: encrypted volumes and backups (provider), plus **application-level AES-256-GCM** for TOTP secrets, provider tokens and HLS keys, using keys from the secret manager (envelope encryption, key rotation yearly)                                                                                         | `packages/crypto`; key rotation runbook                                                    |
| C-32 | **Video protection.** AES-128 HLS with per-video keys, key endpoint gated by session and entitlement and rate-limited, playlist URLs signed for 10 minutes, dynamic watermark with a short user code                                                                                                                                                                                                             | `media` module                                                                             |
| C-38 | **Data localisation.** All personal data is stored and processed in Uzbekistan: DB, Redis, object storage, logs, error tracking (self-hosted GlitchTip), metrics. **No third-party analytics or ad scripts** in `web`. Any new vendor goes through a checklist: what data, where stored, contract. External calls send no personal data (the breached-password check sends a hash prefix; CAPTCHA sends a token) | Vendor checklist in `docs/security/vendors.md` (Phase 6); CSP blocks unknown hosts         |

**Data minimisation summary:** we store no child phone, email, photo, school or
exact birth date. IP addresses are stored as prefixes. Logs redact phone numbers,
tokens, OTPs and names.

**Legal follow-ups (owner: Samandar, with a local lawyer):**

- Confirm the age for independent consent, and the registration or notification
  duties as a personal data operator.
- Confirm retention periods for payment records (tax law) and audit logs.
- Prepare the privacy policy and terms in Uzbek and Russian, written so a parent
  can understand them.

---

## 9. Infrastructure

| ID    | Control                                                                                                                                                                                                                                                                                                                       | Enforcement                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| C-35  | **Edge protection.** DDoS protection from the hosting provider or CDN; WAF with the OWASP Core Rule Set (paranoia level 1 at launch, tuned up); rate limits at the edge (per IP) and in the API (per user and route, Redis token bucket)                                                                                      | `infra/proxy/` config                              |
| C-36  | **Capacity.** Autoscaling of API and worker, load tests at 2× the expected exam-season peak before launch                                                                                                                                                                                                                     | k6 scripts (Phase 7)                               |
| C-37  | **Hardening.** Distroless, non-root images; read-only root filesystems; no shell in production images; network policies (data network has no internet ingress, egress allow-list); per-service DB roles (`api_rw`, `worker_rw`, `reporting_ro`, `migrator`); SSH to hosts only through a bastion with 2FA; OS patches monthly | Dockerfiles, infra config                          |
| C-31a | **Secret manager** (self-hosted Infisical or Vault in the same data centre). Secrets are injected at start-up, never baked into images. Rotation: DB passwords 90 days, JWT keys 90 days, provider keys per provider policy                                                                                                   | Runbook; CI check that no secret appears in images |

---

## 10. Automated tests and monitors for the top risks

| Top risk                     | Automated guard                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| T13 IDOR                     | Generated test: for every route with `{studentId}`/`{childId}`, call it as an unrelated parent, teacher and student → expect 404 |
| T1 Credential stuffing       | Integration test of login limits; alert when failed logins per minute exceed a baseline                                          |
| T10 SMS pumping              | Unit tests of OTP limits; spend alerts at 70% and 100% of budget; dashboard of OTP requests by prefix                            |
| T31/T32 Payment forgery      | Adapter tests: missing, wrong and replayed authentication; amount mismatch; duplicate transaction; daily reconciliation alert    |
| T19 Stored XSS               | Unit tests feeding OWASP XSS payloads through the content renderer and nicknames; CSP violation reports collected and alerted    |
| T47 DDoS                     | Edge alerts on request rate; synthetic uptime checks every minute                                                                |
| T51 Data leaving the country | CSP report + CI check that `web` loads no third-party script; egress allow-list blocks unknown hosts                             |

---

## 11. Secure development lifecycle and CI

| ID   | Control                                                                                                                                                                                                                                                                                                       | Enforcement               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| C-40 | **Threat model review** on every new module, integration or trust boundary, and before every major release                                                                                                                                                                                                    | PR template checkbox      |
| C-41 | **Security tests** in the normal test suite: auth, rate limits, IDOR, CSRF, headers, payment callbacks                                                                                                                                                                                                        | Required CI job           |
| C-42 | **Dependencies:** pnpm lockfile committed; `pnpm audit` + OSV-Scanner on every PR (fail on high/critical with a fix available); Renovate opens update PRs weekly; no install scripts from unknown packages (`pnpm` `onlyBuiltDependencies` allow-list)                                                        | CI job                    |
| C-43 | **Secrets scanning:** gitleaks in a pre-commit hook and in CI; GitHub secret scanning and push protection enabled                                                                                                                                                                                             | Pre-commit + CI           |
| C-44 | **CI/CD hardening:** `main` protected (PR + passing checks + review required, no force pushes); GitHub Actions pinned by commit SHA; minimal `permissions:` per workflow; production deploy credentials only in a protected environment; container images built in CI, scanned with Trivy and signed (cosign) | Repo settings + workflows |
| C-45 | **SAST and DAST:** Semgrep (with the TypeScript, Node and OWASP rulesets) and CodeQL on every PR; OWASP ZAP baseline scan against a staging deploy nightly, and a full scan before each release                                                                                                               | CI jobs                   |
| C-46 | **Penetration test** by an independent tester before public launch, and yearly after that, focused on the top risks above. All high and critical findings fixed before launch                                                                                                                                 | Release checklist         |

**A note on one maintainer:** you cannot review your own PRs in a meaningful
way. Until there is a second developer, the CI checks above **are** the reviewer,
so none of them may be marked optional. Branch protection still requires a
PR, so every change has a record.

---

## 12. Logging, audit and monitoring

| ID   | Control                                                                                                                                                                                                                                                                                      | Enforcement                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| C-33 | **Audit log** for security-relevant actions: login success and failure, MFA changes, role changes, consent changes, data export and deletion, content publish, refunds, admin reads of student data, risk decisions. Append-only DB grants plus a hash chain; daily copy to separate storage | `audit` module; DB grants    |
| C-34 | **Application logs:** structured JSON with request ID; redaction list (phone, token, OTP, password, name, card mask) applied in the logger, tested; retention 30 days                                                                                                                        | Logger config + unit test    |
| C-39 | **Alerts** (to the maintainer by Telegram and email): spike in 401/403/429, refresh-token reuse, new admin role granted, SMS spend thresholds, payment reconciliation mismatch, WAF block spike, CSP violation spike, backup failure, certificate expiry within 14 days                      | Alertmanager rules (Phase 7) |

---

## 13. Backups and disaster recovery

| ID   | Control                                                                                                                                                                                    | Target           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| C-50 | **Postgres:** continuous WAL archiving (point-in-time recovery) + nightly full backups; encrypted; copied to a second location in Uzbekistan; one copy immutable (object lock) for 30 days | **RPO ≤ 15 min** |
| C-51 | **Restore drills:** monthly automated restore to a scratch environment with a data check; a full DR exercise twice a year                                                                  | **RTO ≤ 4 h**    |

Object storage (videos, certificates) is versioned and replicated. Redis holds no
data that cannot be rebuilt (rate counters, caches, queues are re-driven from the
outbox). The DR runbook lives in `docs/runbooks/disaster-recovery.md` (Phase 7).

**Why RPO 15 min / RTO 4 h?** These targets are achievable for one maintainer
with managed Postgres or a scripted restore, and they match the risk: losing
15 minutes of practice answers is tolerable, while payments can be reconciled from
provider statements. The alternative, a hot standby with RTO in minutes, roughly
doubles the database cost and is worth revisiting after launch.

---

## 14. Incident response

1. **Detect:** alert or report (a `security@` address and a page on the site).
2. **Triage (≤ 1 h):** severity by asset (any children's data = high).
3. **Contain:** runbooks for revoking all sessions, rotating JWT keys, disabling
   OTP sending, pausing payments, turning on maintenance mode.
4. **Eradicate and recover:** fix, deploy, restore if needed.
5. **Notify:** affected parents and, where the law requires it, the authorised
   state body, within the legally required time (to be confirmed by the lawyer).
6. **Learn:** a written post-incident review within 5 working days; update this plan
   and the threat model.

The runbooks are written in Phase 7 and tested in the DR exercises.

---

## 15. OWASP Top 10 (2021) mapping

| OWASP                                          | Main controls                                  |
| ---------------------------------------------- | ---------------------------------------------- |
| A01 Broken Access Control                      | C-09, C-10, C-14, C-41                         |
| A02 Cryptographic Failures                     | C-02, C-06, C-31, TLS (§4)                     |
| A03 Injection                                  | C-11, C-12, C-13, C-17                         |
| A04 Insecure Design                            | Threat model, C-16, C-18, C-23, C-27           |
| A05 Security Misconfiguration                  | C-15, C-37, C-44                               |
| A06 Vulnerable Components                      | C-42                                           |
| A07 Identification and Authentication Failures | C-01–C-08, C-20–C-22                           |
| A08 Software and Data Integrity Failures       | C-28, C-44, signed images                      |
| A09 Security Logging and Monitoring Failures   | C-33, C-34, C-39                               |
| A10 Server-Side Request Forgery                | C-19 (no user URL fetching, egress allow-list) |

An ASVS Level 2 checklist (in `docs/security/asvs-checklist.md`) is created in
Phase 6 and filled in as each module is built, so we can see coverage before the
penetration test.

---

## 16. Pre-launch security checklist

- [ ] All high and critical penetration-test findings fixed and retested
- [ ] ZAP full scan clean of high findings
- [ ] Restore drill done, with measured RPO and RTO
- [ ] Staff accounts all have 2FA; no shared accounts
- [ ] Secrets rotated from development values; secret scan clean
- [ ] SMS budget, spend alerts and circuit breaker tested
- [ ] Payment adapters tested in provider sandboxes, including forged callbacks
- [ ] Privacy policy, terms and consent texts approved by a lawyer (uz, ru)
- [ ] Data-localisation check: every service and vendor confirmed in Uzbekistan
- [ ] Incident runbooks written and the on-call alert channel tested

---

## 17. Decisions in this phase

| Decision           | Chosen                                                                  | Alternative                           | Why                                                                          |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| Verification level | ASVS Level 2                                                            | Level 1 or 3                          | Recommended level for sensitive personal data; Level 3 cost not justified    |
| TLS                | 1.3 preferred, 1.2 allowed (accepted 2026-11-15; review after 3 months) | 1.3 only (as in the brief)            | Older Android devices are still common                                       |
| Fraud detection    | Weighted rule score in config                                           | ML model or third-party fraud service | No training data yet; transparent; keeps data in the country                 |
| Cheating response  | Flag for human review                                                   | Automatic penalties                   | Children should not be punished by a false positive                          |
| Child login        | Family code + PIN                                                       | Child phone or email                  | Data minimisation; children often have no phone                              |
| Error tracking     | Self-hosted GlitchTip                                                   | Sentry SaaS                           | Data localisation                                                            |
| WAF                | OWASP CRS on the reverse proxy                                          | Commercial cloud WAF                  | Available in-country and free; commercial WAF can be added at the edge later |
| Backup targets     | RPO 15 min, RTO 4 h                                                     | Hot standby (minutes)                 | Proportionate cost for the MVP                                               |
