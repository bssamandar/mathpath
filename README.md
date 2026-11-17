# MathPath

MathPath is a mobile-first maths learning platform for students in grades 1–11 in
Uzbekistan. It teaches each topic with short lessons and interactive practice,
checks mastery, and sends students back to missing prerequisite topics. Parents
and teachers can follow progress. The MVP covers **grade 5** and **entrance-exam
preparation for Presidential and specialised schools**, in Uzbek (Latin) and
Russian, with English in the UI.

> Status: **0.1.0, MVP in development** (Phase 6). The design documents are in
> [`docs/`](docs/README.md).

---

## Repository layout

```
apps/
  api/        NestJS HTTP API (modular monolith)           → http://localhost:4000/api/v1
  worker/     Background jobs (BullMQ consumers)
  web/        Next.js PWA for students, parents, teachers  → http://localhost:3000
  studio/     Next.js content studio and admin             → http://localhost:3001
packages/
  config/     Typed loader for the business rules in config/
config/       Business rules (mastery threshold, prices, XP, limits, risk) as YAML
infra/        Docker Compose for local services, production Dockerfiles
docs/         PRD, architecture, ADRs, database schema, API contract, security, UX
```

Why it is built this way is explained in [`docs/architecture.md`](docs/architecture.md)
and the [ADRs](docs/adr/).

---

## Prerequisites

| Tool                    | Version               | Check                                      |
| ----------------------- | --------------------- | ------------------------------------------ |
| Node.js                 | 22 LTS (see `.nvmrc`) | `node -v`                                  |
| pnpm                    | 10                    | `pnpm -v` (install with `corepack enable`) |
| Docker + Docker Compose | recent                | `docker compose version`                   |
| Git                     | 2.40+                 | `git --version`                            |
| ffmpeg                  | 6+                    | `ffmpeg -version` (worker and its tests)   |

Optional: [gitleaks](https://github.com/gitleaks/gitleaks) for the secret scan in the pre-commit hook.

---

## Install and run locally

```bash
# 1. Clone and install
git clone https://github.com/bssamandar/mathpath.git
cd mathpath
corepack enable          # makes the pinned pnpm version available
pnpm install             # also installs the Git hooks (husky)

# 2. Environment variables
cp .env.example .env     # defaults work for local development

# 3. Start local services (PostgreSQL, Redis, SeaweedFS for media)
pnpm services:up

# 4. Run all apps in watch mode
pnpm dev
```

Then open:

- API health check: <http://localhost:4000/api/v1/health>
- Student and parent app: <http://localhost:3000>
- Studio: <http://localhost:3001>. Staff accounts need an authenticator app
  (2FA is set up on first sign-in); `pnpm db:seed` loads demo lessons to edit.

Stop the local services with `pnpm services:down`.

---

## Test, lint and build

| Command                             | What it does                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm test`                         | Runs all unit and integration tests (Vitest)                                                             |
| `pnpm test:coverage`                | Same, with coverage; **fails below 80%**                                                                 |
| `pnpm lint`                         | ESLint, including the security rules (no `sql.raw`, no raw HTML, no server-only imports in browser apps) |
| `pnpm typecheck`                    | TypeScript in strict mode                                                                                |
| `pnpm format` / `pnpm format:check` | Prettier                                                                                                 |
| `pnpm build`                        | Builds every app and package                                                                             |

Run one workspace only with a filter, for example `pnpm --filter @mathpath/api test`.

The tests need the local services: Redis on port 6379 and SeaweedFS (S3) on
port 8333 (`pnpm services:up`), and `ffmpeg` on the PATH. Set
`TEST_S3_ENDPOINT=http://localhost:8333` to run the S3 storage tests; without
it they are left out and `packages/media` stays under the coverage gate.

The same checks run in CI on every pull request ([`.github/workflows`](.github/workflows)).

---

## Changing business rules

Prices, XP values, the mastery threshold, rate limits and risk weights live in
[`config/*.yaml`](config/), not in code. Edit the YAML file and open a pull
request. The apps validate every file at start-up and refuse to start with a
message that names the file and field if a value is invalid. `pnpm --filter
@mathpath/config test` checks the files locally.

---

## Deploying

Production deployment (hosting in Uzbekistan, secrets manager, monitoring) is
described in the deployment plan, which is written in Phase 7. The API's
production image is built from [`infra/docker/api.Dockerfile`](infra/docker/api.Dockerfile):

```bash
docker build -f infra/docker/api.Dockerfile -t mathpath-api .
```

---

## Contributing

Branching, commit messages, versioning and the release process are described in
[CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in
[SECURITY.md](SECURITY.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).
