/**
 * Monitoring hooks (step 7.1): readiness, request metrics by route pattern,
 * and audit events counted for the alert rules.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { METRICS, type Metrics } from '../src/observability/observability.module';
import { browser, createTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());
const metricsText = () => t.app.get<Metrics>(METRICS).registry.metrics();

describe('monitoring', () => {
  it('reports readiness of the database', async () => {
    const res = await http().get('/api/v1/health/ready').expect(200);
    expect(res.body).toEqual({
      status: 'ok',
      checks: { database: 'ok', redis: expect.stringMatching(/^(ok|not_configured)$/) },
    });
  });

  it('counts requests by route pattern, never by URL', async () => {
    await http()
      .get('/api/v1/students/01a1e315-0000-7000-8000-00000000c001/reports/weekly')
      .expect(401);
    await http().get('/api/v1/no-such-route').expect(404);
    await http().get('/api/v1/health').expect(200);
    const text = await metricsText();
    expect(text).toContain(
      'http_requests_total{method="GET",route="/api/v1/students/:studentId/reports/weekly",status="401",service="api"} 1',
    );
    expect(text).toContain(
      'http_requests_total{method="GET",route="unmatched",status="404",service="api"} 1',
    );
    expect(text).toContain(
      'http_request_duration_seconds_count{service="api",method="GET",route="/api/v1/health"} 1',
    );
    expect(text).not.toContain('00000000c001');
  });

  it('counts audit events by action and exports the SMS caps', async () => {
    await t.app.get(AuditService).record({ action: 'user.role.grant', metadata: {} });
    const text = await metricsText();
    expect(text).toContain('mathpath_audit_events_total{action="user.role.grant",service="api"} 1');
    expect(text).toMatch(/mathpath_sms_budget_tiyin\{period="hourly",service="api"\} \d+/);
  });
});
