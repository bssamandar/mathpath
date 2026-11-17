/** Against a real Redis, like the audit check test. */
import { randomUUID } from 'node:crypto';
import { RECONCILIATION_CHECKS, type ReconciliationResult } from '@mathpath/db';
import { QueueEvents } from 'bullmq';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { TASHKENT } from '../schedule';
import {
  describeResult,
  RECONCILE_PATTERN,
  RECONCILE_QUEUE,
  startReconciliation,
} from './reconcile-job';

const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

function result(found: Partial<Record<(typeof RECONCILIATION_CHECKS)[number], string[]>>) {
  const counts = Object.fromEntries(
    RECONCILIATION_CHECKS.map((check) => [check, found[check]?.length ?? 0]),
  ) as ReconciliationResult['counts'];
  return { counts, samples: found, ok: Object.keys(found).length === 0 };
}

describe('describeResult', () => {
  it('says the books agree, or lists each check with its IDs', () => {
    expect(describeResult(result({}))).toBe('billing books agree');
    expect(describeResult(result({ stuck_payment: ['p1', 'p2'], amount_mismatch: ['p3'] }))).toBe(
      'billing mismatches: amount_mismatch=1 [p3]; stuck_payment=2 [p1, p2]',
    );
  });
});

describe('startReconciliation', () => {
  const prefix = `test:${randomUUID()}`;
  const events = new QueueEvents(RECONCILE_QUEUE, { connection: { url }, prefix });
  afterAll(async () => {
    await events.close();
  });

  it('runs once at start, reports mismatches without failing, and schedules 06:00 in Tashkent', async () => {
    await events.waitUntilReady();
    const finished = new Promise<{ returnvalue: unknown }>((resolve) =>
      events.once('completed', resolve),
    );
    const found = result({ paid_without_subscription: ['p9'] });
    const onResult = vi.fn();
    const job = await startReconciliation(
      () => Promise.resolve(found),
      { onResult },
      {
        redisUrl: url,
        prefix,
      },
    );
    expect(JSON.stringify((await finished).returnvalue)).toContain('paid_without_subscription=1');
    expect(onResult).toHaveBeenCalledWith(found);
    expect(await job.queue.getJobSchedulers()).toEqual([
      expect.objectContaining({ pattern: RECONCILE_PATTERN, tz: TASHKENT }),
    ]);
    await job.queue.obliterate({ force: true });
    await job.stop();
  });
});
