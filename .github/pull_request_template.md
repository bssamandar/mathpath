## What and why

<!-- One or two sentences: what this PR changes and why. Link the issue or PRD section. -->

## Changed files

<!-- List the main files and the reason for each change. -->

## How it was tested

- [ ] Unit / integration tests added or updated
- [ ] `pnpm lint && pnpm typecheck && pnpm test:coverage` pass locally

## Checklist

- [ ] Commits follow Conventional Commits
- [ ] Business rules are in `config/`, not hard-coded
- [ ] New settings or secrets are in `.env.example` (never real values)
- [ ] Database changes are a migration with a working `down`
- [ ] Public functions and endpoints have docstrings; `docs/api/openapi.yaml` updated
- [ ] Security: new route has `@Permissions` and object-level checks; threat model reviewed if a new module, integration or trust boundary is added (C-40)
- [ ] `CHANGELOG.md` updated under "Unreleased"
