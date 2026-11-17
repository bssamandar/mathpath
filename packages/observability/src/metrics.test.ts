import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createMetrics, EXTERNAL_METRICS, metricNames, startMetricsServer } from './metrics';

describe('metrics', () => {
  it('serves /metrics on its own port and nothing else', async () => {
    const metrics = createMetrics('api');
    metrics.httpRequests.inc({ method: 'GET', route: '/health', status: '200' });
    const server = await startMetricsServer(metrics.registry, { port: 0, host: '127.0.0.1' });
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(
        'http_requests_total{method="GET",route="/health",status="200",service="api"} 1',
      );
      expect(body).toContain('process_cpu_user_seconds_total');
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(
        404,
      );
    } finally {
      server.close();
    }
  });

  it('declares every metric the alert rules use', () => {
    const rules = parse(
      readFileSync(resolve(__dirname, '../../../infra/monitoring/prometheus/alerts.yml'), 'utf8'),
    ) as { groups: { name: string; rules: { alert: string; expr: string }[] }[] };
    const known = new Set<string>([...metricNames(createMetrics('test')), ...EXTERNAL_METRICS]);
    const used = new Set<string>();
    for (const group of rules.groups) {
      for (const rule of group.rules) {
        for (const [name] of rule.expr.matchAll(
          /\b(?:mathpath|http|probe|pg|redis|node)_[a-z_]+\b|\bup\b/g,
        )) {
          // Histograms expose _bucket, _sum and _count series.
          used.add(name.replace(/_(bucket|sum|count)$/, ''));
        }
      }
    }
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((n) => !known.has(n))).toEqual([]);
  });
});
