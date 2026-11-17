/** Against a real Redis, like the league close test. */
import { randomUUID } from 'node:crypto';
import { QueueEvents } from 'bullmq';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { TASHKENT } from '../schedule';
import { AUDIT_CHECK_PATTERN, AUDIT_CHECK_QUEUE, startAuditCheck } from './check-job';

const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

describe('startAuditCheck', () => {
  const prefix = `test:${randomUUID()}`;
  const events = new QueueEvents(AUDIT_CHECK_QUEUE, { connection: { url }, prefix });
  afterAll(async () => {
    await events.close();
  });

  it('checks once at start, reports the result and schedules 03:30 in Tashkent', async () => {
    await events.waitUntilReady();
    const finished = new Promise((resolve) => events.once('completed', resolve));
    const onResult = vi.fn();
    const job = await startAuditCheck(
      () => Promise.resolve({ ok: true, entries: 12 }),
      { onResult },
      { redisUrl: url, prefix },
    );
    await finished;
    expect(onResult).toHaveBeenCalledWith({ ok: true, entries: 12 });
    expect(await job.queue.getJobSchedulers()).toEqual([
      expect.objectContaining({ pattern: AUDIT_CHECK_PATTERN, tz: TASHKENT }),
    ]);
    await job.queue.obliterate({ force: true });
    await job.stop();
  });

  it('fails the job when the chain is broken, after reporting it', async () => {
    const other = `test:${randomUUID()}`;
    const failedEvents = new QueueEvents(AUDIT_CHECK_QUEUE, { connection: { url }, prefix: other });
    await failedEvents.waitUntilReady();
    const failed = new Promise<{ failedReason: string }>((resolve) =>
      failedEvents.once('failed', resolve),
    );
    const onResult = vi.fn();
    const job = await startAuditCheck(
      () => Promise.resolve({ ok: false, entries: 5, brokenAt: 'e3' }),
      { onResult },
      { redisUrl: url, prefix: other },
    );
    expect((await failed).failedReason).toContain('audit chain broken at entry e3');
    expect(onResult).toHaveBeenCalledWith({ ok: false, entries: 5, brokenAt: 'e3' });
    await job.queue.obliterate({ force: true });
    await job.stop();
    await failedEvents.close();
  });
});
