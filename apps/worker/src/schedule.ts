/**
 * Scheduled tasks in the worker (ADR-0007). A BullMQ job scheduler fires the
 * task on a cron pattern in Tashkent time; the worker also runs it once at
 * start, so a run missed while it was down happens late rather than never.
 * Tasks must be idempotent, because two workers may both run the start-up
 * copy.
 */
import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

export const TASHKENT = 'Asia/Tashkent';

export interface ScheduleOptions {
  redisUrl: string;
  /** Redis key prefix; tests use their own. */
  prefix?: string;
}

export interface ScheduledTask {
  queue: Queue;
  worker: Worker;
  stop(): Promise<void>;
}

/**
 * @param name Queue name, also the log context.
 * @param pattern Cron pattern in Tashkent time.
 * @param task Returns a short summary for the log, or nothing to stay quiet.
 */
export async function startScheduled(
  name: string,
  pattern: string,
  task: () => Promise<string | undefined>,
  options: ScheduleOptions,
): Promise<ScheduledTask> {
  const logger = new Logger(name);
  const prefix = options.prefix ?? 'bull';
  const queue = new Queue(name, { connection: { url: options.redisUrl }, prefix });
  const worker = new Worker(
    name,
    async () => {
      const summary = await task();
      if (summary) logger.log(summary);
      return { summary };
    },
    {
      connection: { url: options.redisUrl, maxRetriesPerRequest: null },
      concurrency: 1,
      prefix,
    },
  );
  worker.on('failed', (_job, error) => logger.error(`${name} failed: ${error.message}`));
  await queue.upsertJobScheduler(
    'scheduled',
    { pattern, tz: TASHKENT },
    { name: 'run', opts: { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } } },
  );
  await queue.add('run', {}, { jobId: `startup-${Date.now()}`, removeOnComplete: true });
  return {
    queue,
    worker,
    async stop() {
      await worker.close();
      await queue.close();
    },
  };
}
