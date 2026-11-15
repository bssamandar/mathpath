# ADR-0010: CSRF token derived from the session instead of a double-submit cookie

- Status: Proposed
- Date: 2026-11-15

## Context

ADR-0005 and the security plan (C-07) planned a double-submit CSRF token: the
API sets a readable cookie and the browser app copies its value into the
`X-CSRF-Token` header. While building sign-in we found that this cannot work
with our layout. The web apps (`mathpath.uz`, `studio.mathpath.uz`) and the API
(`api.mathpath.uz`, and `localhost:4000` locally) are different origins, so the
web app's JavaScript cannot read a cookie set by the API.

## Decision

The CSRF token is `HMAC-SHA-256(key derived for "csrf", session ID)`. The API
returns it in the body of every sign-in and refresh response (`csrfToken` in
`SessionInfo`); the web app keeps it in memory and sends it as `X-CSRF-Token`
on every state-changing request. A global guard recomputes it from the session
ID inside the verified access token and compares in constant time.

Requests with an `Authorization: Bearer` header, and `POST /auth/refresh`, are
exempt: browsers never add a Bearer header on their own, and a cross-site
refresh only rotates a token the attacker cannot read (SameSite=Lax also keeps
the cookie off cross-site POSTs).

## Alternatives considered

- **Double-submit cookie (as planned).** Needs the API and the web app on the
  same origin, for example by serving the API under `mathpath.uz/api` through
  the reverse proxy. Possible later, but it ties deployment to one domain and
  still needs a fallback for local development.
- **Random token stored per session.** Same protection, but needs a column and
  a database read on every state-changing request. The HMAC needs no storage.
- **SameSite=Strict cookies only.** Breaks sign-in when a user opens a link from
  SMS or Telegram, and does not protect against a compromised sibling subdomain.

## Consequences

- No CSRF state to store or expire; the token changes with the session.
- After a page reload the web app gets a fresh token from its first refresh call,
  which it makes on start-up anyway.
- The HMAC key must be the same on every API instance (`AUTH_HMAC_SECRET`).
