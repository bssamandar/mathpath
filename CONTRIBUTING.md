# Contributing to MathPath

## Branches

| Branch                 | Purpose                                                                           | Rules                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `main`                 | Stable, released code. Every commit on `main` is a tagged release.                | Protected: no direct pushes; merge only from `develop` (release) or `hotfix/*` through a pull request with passing checks |
| `develop`              | Integration branch for the next release                                           | Protected: pull requests only, CI must pass                                                                               |
| `feature/<short-name>` | New work, branched from `develop`                                                 | Deleted after merge                                                                                                       |
| `fix/<short-name>`     | Bug fixes, branched from `develop`                                                | Deleted after merge                                                                                                       |
| `hotfix/<short-name>`  | Urgent production fix, branched from `main`, merged into `main` **and** `develop` |                                                                                                                           |

## Commit messages: Conventional Commits

Format: `type(scope): summary in the imperative, lower case`

| Type       | Use for                                                 |
| ---------- | ------------------------------------------------------- |
| `feat`     | A new feature (minor version bump)                      |
| `fix`      | A bug fix (patch version bump)                          |
| `docs`     | Documentation only                                      |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test`     | Adding or fixing tests                                  |
| `chore`    | Tooling, dependencies, configuration                    |
| `ci`       | CI workflows                                            |
| `perf`     | Performance improvement                                 |

Scopes are the app, package or module: `api`, `worker`, `web`, `studio`, `config`,
`identity`, `content`, `assessment`, `billing`, `infra`... A breaking change adds
`!` after the type (`feat(api)!: ...`) and a `BREAKING CHANGE:` footer.

Keep commits **small and atomic**: one logical change per commit, with tests in the
same commit. The `commit-msg` hook (commitlint) rejects messages that do not follow
the format.

## Pull requests

1. Branch from `develop`.
2. Fill in the PR template: what and why, changed files with reasons, how it was tested.
3. All CI checks must pass: format, lint, typecheck, tests with ≥ 80% coverage,
   build, and the security scans.
4. Update `CHANGELOG.md` under **Unreleased**.

## Versioning and releases

We use [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

Release steps:

1. On `develop`, move the **Unreleased** entries in `CHANGELOG.md` under the new
   version and date; bump `version` in the root `package.json`.
2. Open a pull request `develop → main` titled `chore(release): vX.Y.Z`.
3. After merge, tag the merge commit on `main`: `git tag -a vX.Y.Z -m "vX.Y.Z"` and
   push the tag (`git push origin vX.Y.Z`).

## Code rules (summary)

- Business rules go in `config/*.yaml`, never hard-coded.
- Settings and secrets come from environment variables; document every new one in
  `.env.example` with a safe placeholder. Never commit real secrets.
- Database changes only through migrations with a working `down`.
- Comments explain **why**. Complex algorithms (adaptivity, risk scoring, payment
  flows) and security-critical code are always commented.
- Every public function, class and API endpoint has a docstring (purpose,
  parameters, return value, errors).
- English for code, comments and identifiers. User-facing text goes through i18n.
