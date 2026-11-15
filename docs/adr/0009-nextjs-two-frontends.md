# ADR-0009: Next.js PWA, with separate `web` and `studio` apps

- Status: Proposed
- Date: 2026-11-15

## Context

Students use low-end Android phones on slow connections. Staff tools (CMS,
admin) are large and security-sensitive.

## Decision

- Next.js (App Router) for both front-ends. Server rendering gives a fast first
  paint on slow networks and indexable marketing and catalogue pages.
- `apps/web` (students, parents, teachers) is a PWA with offline practice.
- `apps/studio` (authors, reviewers, admins) runs on a separate subdomain with a
  stricter CSP, mandatory 2FA and an optional IP allow-list.

## Alternatives considered

- **Vite single-page app.** Simpler build, but a slower first paint on 3G
  (everything renders after JS loads) and no server rendering for public
  pages.
- **SvelteKit.** Smaller bundles, but a smaller ecosystem for accessible
  components and math editors, and less familiar to future contributors.
- **One front-end app for every role.** Simpler deploy, but staff code ends up in
  children's bundles and the security policies get mixed.

## Consequences

- Two apps to deploy, sharing `packages/ui` and `packages/i18n`.
- The JS budget must be watched, because Next.js can grow heavy. CI enforces bundle
  budgets.
