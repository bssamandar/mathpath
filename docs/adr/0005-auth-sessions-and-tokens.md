# ADR-0005: Own authentication module with short JWTs and rotating refresh tokens

- Status: Proposed (the CSRF part is refined by [ADR-0010](0010-csrf-token-bound-to-session.md))
- Date: 2026-11-15

## Context

Sign-up is phone + SMS OTP. Children have no phone and sign in with a family code
and PIN. Staff need mandatory TOTP 2FA. The brief requires short-lived tokens with
refresh rotation, Argon2id, and protection against credential stuffing and
account sharing.

## Decision

- Implement auth in the `identity` module.
- **Access token:** JWT signed with EdDSA (Ed25519), 15 minutes, containing user ID,
  session ID and roles. The signing key comes from the secret manager and
  rotates, and the key ID goes in the header.
- **Refresh token:** a random 256-bit opaque value, stored as a SHA-256 hash,
  valid for 30 days and rotated on every use. Presenting an old token
  revokes the whole token family and session (stolen-token detection).
- **Browser:** both tokens in `HttpOnly; Secure; SameSite=Lax` cookies, plus a
  double-submit CSRF token. **Mobile (future):** Bearer header.
- Passwords hashed with Argon2id (parameters in config, reviewed yearly) and
  checked against breached passwords through a k-anonymity range API.
- Session limits per plan (concurrent sessions, devices) are enforced when a
  session is created.

## Alternatives considered

- **Keycloak or another hosted IdP.** Mature, but heavy to run and harder to
  customise for phone OTP, child PIN login and Uzbek SMS gateways. It would also be
  another stateful system to secure and keep in the country.
- **Server sessions only (no JWT).** Simpler revocation, but every request
  needs a DB or Redis lookup. Our 15-minute JWT plus a Redis revocation list for
  revoked sessions gives near-instant revocation at low cost.
- **Tokens in localStorage.** Exposed to any XSS, so rejected.

## Consequences

- We own security-critical code, so it gets the most tests and comments, and
  it is a focus of the penetration test.
- Revocation takes effect within at most 15 minutes, or immediately through the
  Redis deny-list of session IDs.
