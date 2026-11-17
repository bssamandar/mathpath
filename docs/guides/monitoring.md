# Monitoring and alerts

How MathPath is watched in production (architecture §7.6; security plan C-34,
C-38, C-39). Everything runs on our own servers in Uzbekistan: no SaaS
monitoring, no third-party log store.

## What runs where

| Piece                                          | Where                                            | What it does                                                                                              |
| ---------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| JSON logs                                      | API and worker stdout (`packages/observability`) | One line per entry; phone numbers, tokens and personal keys are redacted before writing                   |
| Metrics                                        | API `:9464/metrics`, worker `:9465/metrics`      | Requests by route pattern, response times, audit events, SMS spend, video jobs, scheduled tasks           |
| Readiness                                      | `GET /api/v1/health/ready`                       | 200 when the database and Redis answer; the load balancer uses it                                         |
| Audit chain check                              | worker, daily 03:30 Tashkent and at start        | Recomputes the audit log hash chain; `mathpath_audit_chain_broken` = 1 if an entry was changed or deleted |
| Prometheus, Alertmanager, Loki, Alloy, Grafana | `infra/monitoring/docker-compose.yml`            | Collect metrics and logs, send alerts, show dashboards                                                    |

The metrics ports are for the private network only. The reverse proxy must
never route them, and `/health/ready` stays internal too (`infra/proxy/Caddyfile`).

## Starting the stack

1. Create `infra/monitoring/secrets/` (ignored by Git) with:
   - `telegram_bot_token`: from @BotFather;
   - `smtp_password`: for the alert mailbox;
   - `grafana_admin_password`;
   - `postgres_monitoring_password`: the same value as `MATHPATH_MONITORING_PASSWORD`
     in `infra/.env.prod` (the `monitoring` role is created with the database).
2. In `alertmanager/alertmanager.yml`, set the Telegram chat ID, the SMTP host and the addresses.
3. In `prometheus/probes.yml`, set the real domain.
4. Run `docker compose -f infra/monitoring/docker-compose.yml up -d`, after the app stack,
   which creates the `mathpath_private` network.
5. Open Grafana through an SSH tunnel: `ssh -L 3300:127.0.0.1:3300 <server>`, then
   http://localhost:3300. The "MathPath overview" dashboard is provisioned.

CI checks every config file with the same images (`promtool`, `amtool`,
`loki -verify-config`, `alloy fmt`), and a unit test checks that every metric
in the alert rules exists in `packages/observability/src/metrics.ts`.

## Alerts and what to do

Severity `page` goes to Telegram and email; `warn` to email; `info` to Telegram
without sound. Thresholds are starting values; tune them after launch.

| Alert                                                                                         | First step                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ApiDown, WorkerDown, PostgresDown, RedisDown, SiteUnreachable                                 | `docker compose ps` and the service logs in Grafana (Loki: `{service="api"}`)                                                                  |
| HighErrorRate, SlowResponses                                                                  | Grafana: "Slowest routes" and the error log panel; search Loki by `requestId` from a user's report                                             |
| AuthErrorSpike, RateLimitSpike, LoginFailureSpike                                             | Studio → Audit log, action `auth`; check the risk queue; block an abusive phone prefix if needed                                               |
| RefreshTokenReused                                                                            | A stolen or replayed session was revoked automatically. Audit log, action `auth.refresh_token_reused`; contact the account owner if it repeats |
| StaffRoleGranted                                                                              | Confirm in Studio → Audit log (`user.role.grant`) that you or another admin did it                                                             |
| AuditChainBroken                                                                              | Treat as a security incident: someone changed or deleted audit entries. Do not restart anything; copy the database and the audit backups first |
| SmsSpendHourly, SmsSpendDaily                                                                 | Look for SMS pumping (RateLimitSpike, risk queue). At 100% the API already asks every code request for a CAPTCHA                               |
| BillingReconciliationMismatch                                                                 | Worker log (`{service="worker"}                                                                                                                | = "billing-reconciliation"`) lists the first IDs per check; what each check means and what to do: payments.md |
| BackupMissing, MediaBackupMissing                                                             | `journalctl -u mathpath-backup.service`; run `infra/backup/backup.sh` by hand (backups.md)                                                     |
| RestoreDrillMissing, RestoreDrillSlow                                                         | `journalctl -u mathpath-restore-drill.service`; run `infra/backup/restore-drill-run.sh` (backups.md)                                           |
| WafBlockSpike                                                                                 | Proxy logs in Grafana (`{service="proxy"}`) : an attack, or a CRS false positive blocking users (deploy.md, edge rules)                        |
| CertificateExpiresSoon                                                                        | Caddy renews automatically; if it did not, check its logs and DNS                                                                              |
| AuditCheckNotRunning, LeagueCloseNotRunning, BillingReconciliationNotRunning, TranscodeErrors | Worker logs (`{service="worker"}`); the jobs are safe to run again                                                                             |

## Logs

Loki keeps 30 days (C-34). Useful queries:

- `{service="api", level="error"}`: errors.
- `{service="api"} | json | requestId="<id>"`: one request, from the ID in an error response.
- `{service="api", context="Http"} | json | status >= 500`: failed requests with route and time.

Only failed (4xx/5xx) and slow (over 1 s) requests are logged; the metrics
count every request.
