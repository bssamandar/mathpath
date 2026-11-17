/** Against a real Redis, like src/common/redis.test.ts. */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { BullTranscodeQueue, NoTranscodeQueue } from './transcode-queue';

const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
const queue = new BullTranscodeQueue(url, `test:${randomUUID()}`);

afterAll(async () => {
  await queue.queue.obliterate({ force: true });
  await queue.close();
});

describe('BullTranscodeQueue', () => {
  it('queues a video once, however often it is asked', async () => {
    const mediaId = randomUUID();
    await queue.enqueue(mediaId);
    await queue.enqueue(mediaId);
    const jobs = await queue.queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.map((j) => j.id)).toEqual([mediaId]);
    expect(jobs[0]!.data).toEqual({ mediaId });
    expect(jobs[0]!.opts.attempts).toBe(3);
  });
});

describe('NoTranscodeQueue', () => {
  it('accepts jobs without Redis and drops them', async () => {
    const none = new NoTranscodeQueue();
    await expect(none.enqueue('m')).resolves.toBeUndefined();
    await expect(none.close()).resolves.toBeUndefined();
  });
});
