/** Against a real Redis, like the transcode consumer test. */
import { randomUUID } from 'node:crypto';
import { QueueEvents } from 'bullmq';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LEAGUE_CLOSE_PATTERN, LEAGUE_QUEUE, LEAGUE_TIMEZONE, startLeagueClose } from './close-job';

const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
const prefix = `test:${randomUUID()}`;
const events = new QueueEvents(LEAGUE_QUEUE, { connection: { url }, prefix });

afterAll(async () => {
  await events.close();
});

describe('startLeagueClose', () => {
  it('closes once at start and schedules Monday 00:05 in Tashkent', async () => {
    await events.waitUntilReady();
    const finished = new Promise((resolve) => events.once('completed', resolve));
    const close = vi.fn().mockResolvedValue(2);
    const job = await startLeagueClose(close, { redisUrl: url, prefix });
    await finished;
    expect(close).toHaveBeenCalledTimes(1);

    const schedulers = await job.queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ pattern: LEAGUE_CLOSE_PATTERN, tz: LEAGUE_TIMEZONE });
    // Starting again (a restart or a second worker) keeps one schedule.
    const again = await startLeagueClose(close, { redisUrl: url, prefix });
    expect(await again.queue.getJobSchedulers()).toHaveLength(1);
    await again.stop();
    await job.queue.obliterate({ force: true });
    await job.stop();
  });
});
