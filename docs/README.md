# MathPath documentation

| Document                                                                                                                                                                                 | What it covers                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [PRD](PRD.md)                                                                                                                                                                            | Product requirements and MVP scope                                                     |
| [Architecture](architecture.md)                                                                                                                                                          | Modules, key flows, caching, scaling, extensibility                                    |
| [ADRs](adr/)                                                                                                                                                                             | Architecture Decision Records, one per major choice ([template](adr/0000-template.md)) |
| [Database schema](database-schema.md)                                                                                                                                                    | Tables, conventions, indexing, migrations, personal-data map                           |
| [API contract](api/openapi.yaml)                                                                                                                                                         | OpenAPI 3.1, the source of truth for the API                                           |
| [Threat model](security/threat-model.md)                                                                                                                                                 | STRIDE analysis and top risks                                                          |
| [Security plan](security/security-plan.md)                                                                                                                                               | Controls (C-xx), abuse protection, CI security, DR                                     |
| [UX design](ux/ux-design.md)                                                                                                                                                             | User flows, key screens, accessibility                                                 |
| [Extending MathPath](guides/extending.md)                                                                                                                                                | How to add a grade, topic, question type or payment provider                           |
| [Launch checklist](guides/launch-checklist.md)                                                                                                                                           | Everything the owner must supply or confirm before going live                          |
| [Deploy](guides/deploy.md), [backups](guides/backups.md), [monitoring](guides/monitoring.md), [payments](guides/payments.md), [reports](guides/reports.md), [testing](guides/testing.md) | Running MathPath in production                                                         |

To view the API contract as a browsable reference:

```bash
npx @redocly/cli@2.11.0 preview-docs docs/api/openapi.yaml
```

## Writing an ADR

Copy [`adr/0000-template.md`](adr/0000-template.md) to the next number, fill it
in, and add it in the same pull request as the change it explains. Never edit an
accepted ADR's decision. Write a new ADR that supersedes it instead.
