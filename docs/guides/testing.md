# Testing

How MathPath is tested before a change reaches production (security plan
§11, C-36; UX specification, accessibility). Deployment: [deploy.md](deploy.md).

## The layers

| Layer                | Where                                       | Runs                            | What it proves                                                                                                      |
| -------------------- | ------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Unit and integration | `*.test.ts` next to the code (Vitest)       | CI on every PR; fails under 80% | Rules, services and SQL, with PGlite, real Redis and SeaweedFS                                                      |
| End-to-end (browser) | `tests/e2e` (Playwright)                    | `E2E` workflow on every PR      | The built apps work together through a real browser: sign-up, consent by SMS, child sign-in, practice, studio admin |
| Accessibility        | `expectAccessible()` in every e2e screen    | With the e2e tests              | No serious or critical WCAG 2.1 A/AA issue (axe) on any screen the journeys visit                                   |
| Security headers     | `tests/e2e/specs/web.public.spec.ts`        | With the e2e tests              | CSP `frame-ancestors`, `nosniff`, `X-Frame-Options`, no `X-Powered-By` on the built web app                         |
| Load smoke           | `tests/load/student-journey.js` (k6), smoke | `E2E` workflow on every PR      | The student flow holds 20 students at once with no errors                                                           |
| Peak load            | the same script, `peak` profile             | `Load test` workflow, by hand   | Twice the 5k concurrent-student target on staging within the latency budget (C-36)                                  |

### Decisions

| Decision                                                | Alternative considered                       | Why                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Playwright                                              | Cypress                                      | Runs phone and desktop profiles in one suite, several browser contexts in one test (parent and child), and axe has a maintained binding       |
| Tests drive the built apps (`next start`, `node dist`)  | `next dev` and a mocked API                  | Catches what only production builds do: the `/api` rewrite, headers, standalone config. The API, Postgres and Redis are real                  |
| SMS codes read from the API log (`SMS_PROVIDER=log`)    | A test-only endpoint that returns codes      | No route in the API exists only for tests, so nothing like it can be left open in production                                                  |
| Loosened OTP limits in a copy of `config/` for e2e runs | Waiting out the 60-second resend rule        | All tests share one IP and browser; the limits are covered by unit tests, so the browser tests only need them out of the way                  |
| Accessibility checked inside the journeys               | A separate crawl of every page               | Signed-in screens are checked in the state a user sees them, with no extra login code                                                         |
| k6 for load                                             | Artillery; Locust                            | One small binary or image, JavaScript like the rest of the code, thresholds that fail the run; widely used for HTTP APIs                      |
| Load students cloned in SQL from one real child         | Signing up thousands of families through SMS | Real sign-up would send thousands of OTPs; cloning keeps the real PIN hash, consent and family links, so sign-in is the real code path        |
| Latency thresholds only on the peak profile             | The same thresholds in CI                    | A shared CI runner hashing 20 PINs at once says nothing about production speed; CI checks correctness under concurrency, staging checks speed |

## Running the browser tests locally

You need Postgres, Redis and SeaweedFS (`pnpm services:up`) and a built tree.
Next.js fixes the `/api` rewrite at build time, so build with `API_ORIGIN`:

```sh
API_ORIGIN=http://127.0.0.1:4000 pnpm exec turbo run build --env-mode=loose
pnpm --filter @mathpath/e2e exec playwright install chromium   # once

PGPASSWORD=mathpath_local_only createdb -h localhost -U mathpath mathpath_e2e # an empty database
DATABASE_URL=postgres://mathpath:mathpath_local_only@localhost:5432/mathpath_e2e \
REDIS_URL=redis://localhost:6379 S3_ENDPOINT=http://localhost:8333 \
  tests/e2e/start-stack.sh

DATABASE_URL=postgres://mathpath:mathpath_local_only@localhost:5432/mathpath_e2e \
E2E_API_LOG=/tmp/mathpath-e2e/api.log pnpm --filter @mathpath/e2e e2e
```

`start-stack.sh` migrates and seeds the database, then starts the API on
:4000, web on :3000 and studio on :3001 with test settings: SMS codes go to
the log, the CAPTCHA has a "dev: I am not a robot" button, breached-password
lookups are off and a throw-away JWT key is generated. Logs are in
`/tmp/mathpath-e2e`. Stop the servers with
`pkill -f 'dist/main.js|next-server'`.

Every run signs up new parents with random phone numbers, so the suite can run
again on the same database. A failed test leaves a screenshot and an
`error-context.md` with the page's accessibility tree in `tests/e2e/test-results`.
In CI, the report and the server logs are uploaded as the `e2e-report` artifact.

### Writing a test

- Find elements by role and visible Uzbek label (`getByRole('button', { name: 'Kirish' })`,
  `getByLabel('Parol')`), as a user would. A changed label that breaks a test is
  usually a changed label users will notice too.
- Call `expectAccessible(page)` on every new screen the test reaches.
- Use `smsCode(phone)` for codes and `newPhone()` for a fresh number; never fixed
  numbers, so runs do not collide.
- Files named `web.*.spec.ts` run on a phone (Pixel 7), `studio.*.spec.ts` on a desktop.

## Load tests

`tests/load/student-journey.js` is one student per virtual user: sign in with
the family code and PIN, open the course list, a course and a lesson, start
practice, read a question, answer it and think for a few seconds. A free
student reaching the daily limit (402) is expected, not an error.

| Profile | Students            | Duration           | Fails when                                                                     |
| ------- | ------------------- | ------------------ | ------------------------------------------------------------------------------ |
| smoke   | 20                  | 1 minute           | over 1% requests fail or over 1% checks fail                                   |
| peak    | `STUDENTS` (10 000) | 30 minutes, ramped | the above, or p95 over 300 ms for reads, 500 ms for answers, 1.5 s for sign-in |

### Running the peak test on staging

Never against production: it adds fake children and starts thousands of
practice attempts.

1. On staging, sign up a parent and add one child through the app. Note the
   family code, the child's nickname and PIN.
2. Create the students (here 10 000, named `load-0001` …):
   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v family_code=ABCD2345 \
     -v template_nickname=Dilya -v count=10000 -f tests/load/prepare-students.sql
   ```
3. Raise `EDGE_RATE_LIMIT_PER_MINUTE` on staging (for example to 1000000) and
   restart the proxy: every request comes from the one runner's IP.
4. Store the PIN as the repository secret `LOAD_TEST_PIN`, and set the
   repository variable `PRODUCTION_URL` so the workflow refuses production.
5. GitHub → Actions → **Load test** → Run workflow, with the staging address and
   family code. The `load-summary` artifact holds the k6 results; watch Grafana
   (monitoring.md) during the run for database and Redis load.
6. Put `EDGE_RATE_LIMIT_PER_MINUTE` back.

Staging should match the production server size (deploy.md), or the numbers
mean little. If the run fails on latency, find the slow route in the k6
summary (`name` tag) and the Grafana API dashboard before changing limits.
