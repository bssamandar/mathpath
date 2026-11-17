/**
 * Prometheus metrics (architecture §7.6; security plan C-39). Every metric
 * MathPath exports is declared here, once, so the API, the worker and the
 * alert rules in infra/monitoring agree on names; a test checks that each
 * `mathpath_*` or `http_*` name in the alert rules exists here.
 *
 * Labels are kept to small, fixed sets (route patterns, not URLs; audit
 * actions, not user IDs): every label value is a separate time series.
 */
import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'method' | 'route'>;
  auditEvents: Counter<'action'>;
  smsSent: Counter;
  smsSpend: Counter;
  smsBudget: Gauge<'period'>;
  transcodeJobs: Counter<'outcome'>;
  leagueWeeksClosed: Counter;
  auditChainBroken: Gauge;
  billingMismatches: Gauge<'check'>;
  reportSms: Counter<'outcome'>;
  jobLastSuccess: Gauge<'task'>;
}

/**
 * Metrics written outside the apps, which alert rules may also use: the
 * backup script (through node-exporter's textfile collector) and the
 * standard exporters.
 */
export const EXTERNAL_METRICS = [
  // Written by infra/backup/*.sh into node-exporter's textfile directory.
  'mathpath_backup_last_success_timestamp_seconds',
  'mathpath_media_backup_last_success_timestamp_seconds',
  'mathpath_restore_drill_last_success_timestamp_seconds',
  'mathpath_restore_drill_duration_seconds',
  // Caddy, the edge proxy.
  'caddy_http_request_duration_seconds_count',
  'probe_success',
  'probe_ssl_earliest_cert_expiry',
  'up',
  'pg_up',
  'redis_up',
  'node_filesystem_avail_bytes',
  'node_filesystem_size_bytes',
] as const;

export function createMetrics(service: string): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  const registers = [registry];
  return {
    registry,
    httpRequests: new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests by method, route pattern and status code.',
      labelNames: ['method', 'route', 'status'],
      registers,
    }),
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Time to respond, by method and route pattern.',
      labelNames: ['method', 'route'],
      buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    }),
    auditEvents: new Counter({
      name: 'mathpath_audit_events_total',
      help: 'Audit log entries written, by action (auth.login_failed, user.role.grant, ...).',
      labelNames: ['action'],
      registers,
    }),
    smsSent: new Counter({
      name: 'mathpath_sms_sent_total',
      help: 'SMS messages sent.',
      registers,
    }),
    smsSpend: new Counter({
      name: 'mathpath_sms_spend_tiyin_total',
      help: 'Estimated SMS spend in tiyin.',
      registers,
    }),
    smsBudget: new Gauge({
      name: 'mathpath_sms_budget_tiyin',
      help: 'SMS spend cap per period from config/risk.yaml.',
      labelNames: ['period'],
      registers,
    }),
    transcodeJobs: new Counter({
      name: 'mathpath_transcode_jobs_total',
      help: 'Video transcode jobs by outcome (ready, rejected, skipped, error).',
      labelNames: ['outcome'],
      registers,
    }),
    leagueWeeksClosed: new Counter({
      name: 'mathpath_league_weeks_closed_total',
      help: 'Weekly leagues closed by the worker.',
      registers,
    }),
    // "Broken" rather than "ok", so the default value 0 is the safe one.
    auditChainBroken: new Gauge({
      name: 'mathpath_audit_chain_broken',
      help: '1 when the last audit hash-chain check found a changed or missing entry, else 0.',
      registers,
    }),
    billingMismatches: new Gauge({
      name: 'mathpath_billing_reconciliation_mismatches',
      help: 'Rows the last billing reconciliation found wrong, by check (0 when the books agree).',
      labelNames: ['check'],
      registers,
    }),
    reportSms: new Counter({
      name: 'mathpath_report_sms_total',
      help: 'Weekly report SMS to parents by outcome (sent, failed). Separate from the sign-in SMS budget.',
      labelNames: ['outcome'],
      registers,
    }),
    jobLastSuccess: new Gauge({
      name: 'mathpath_job_last_success_timestamp_seconds',
      help: 'When a scheduled task last finished without error (Unix seconds). The label is task, not job, which Prometheus uses for the scrape target.',
      labelNames: ['task'],
      registers,
    }),
  };
}

/** Every metric name the apps export, for checking the alert rules. */
export function metricNames(metrics: Metrics): string[] {
  return metrics.registry.getMetricsAsArray().map((m) => m.name);
}

/**
 * Serves `GET /metrics` on its own port, apart from the public API, so the
 * reverse proxy never exposes it and no route permission is needed. Bind it
 * to the private network only.
 */
export function startMetricsServer(
  registry: Registry,
  options: { port: number; host?: string },
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'Content-Type': registry.contentType }).end(body);
      })
      .catch(() => res.writeHead(500).end());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => resolve(server));
  });
}
