# Security policy

MathPath handles children's personal data, so we take reports seriously.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security problems. Instead, use
GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability")
on this repository. Include the affected URL or component, steps to reproduce, and
the impact you expect.

We aim to acknowledge reports within 2 working days and to share a fix plan within
7 days.

## Scope

In scope: the MathPath API, web app, studio and their infrastructure. Out of scope:
denial-of-service tests, social engineering, and third-party services (Payme, Click,
SMS gateway).

## How security is designed in

See the [threat model](docs/security/threat-model.md) and the
[security plan](docs/security/security-plan.md). Each security control has an ID
(C-xx) that is referenced in code comments where it is enforced.
