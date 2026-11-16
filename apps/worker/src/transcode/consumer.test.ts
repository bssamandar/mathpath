/** Against a real Redis, like the API's Redis tests. */
import { randomUUID } from 'node:crypto';
import { TRANSCODE_QUEUE } from '@mathpath/media';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { startTranscodeConsumer } from './consumer';
import type { Transcoder } from './transcoder';

const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
const prefix = `test:${randomUUID()}`;
const connection = { url };
const queue = new Queue(TRANSCODE_QUEUE, { connection, prefix });
const events = new QueueEvents(TRANSCODE_QUEUE, { connection, prefix });

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await events.close();
});

describe('startTranscodeConsumer', () => {
  it('runs each job, and tells the transcoder when it is the last attempt', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('storage hiccup'))
      .mockResolvedValueOnce({ outcome: 'ready' });
    const worker = startTranscodeConsumer({ run } as unknown as Transcoder, {
      redisUrl: url,
      concurrency: 1,
      prefix,
    });
    await events.waitUntilReady();
    const job = await queue.add('transcode', { mediaId: 'm1' }, { attempts: 2, backoff: 0 });
    await expect(job.waitUntilFinished(events, 15_000)).resolves.toEqual({ outcome: 'ready' });
    expect(run.mock.calls).toEqual([
      ['m1', false],
      ['m1', true],
    ]);
    await worker.close();
  });
});
