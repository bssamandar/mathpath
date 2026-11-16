/**
 * The weekly league close (ADR-0007: scheduled jobs run in the worker). A
 * BullMQ job scheduler fires every Monday at 00:05 Tashkent time; the worker
 * also runs the close once at start, so a week missed while it was down is
 * closed late rather than never. The close itself is idempotent
 * (`closeFinishedLeagues` in @mathpath/db), so two workers never move a
 * learner twice.
 */
import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

export const LEAGUE_QUEUE = 'league-close';
/** Monday 00:05, after the Sunday-night end of the week. */
export const LEAGUE_CLOSE_PATTERN = '5 0 * * 1';
export const LEAGUE_TIMEZONE = 'Asia/Tashkent';

export interface LeagueCloseOptions {
  redisUrl: string;
  /** Redis key prefix; tests use their own. */
  prefix?: string;
}

/**
 * @param close Closes every finished week and returns how many leagues it closed.
 */
export async function startLeagueClose(
  close: () => Promise<number>,
  options: LeagueCloseOptions,
): Promise<{ queue: Queue; worker: Worker; stop(): Promise<void> }> {
  const logger = new Logger('Leagues');
  const prefix = options.prefix ?? 'bull';
  const queue = new Queue(LEAGUE_QUEUE, { connection: { url: options.redisUrl }, prefix });
  const worker = new Worker(
    LEAGUE_QUEUE,
    async () => {
      const closed = await close();
      if (closed > 0) logger.log(`closed ${closed} league(s)`);
      return { closed };
    },
    {
      connection: { url: options.redisUrl, maxRetriesPerRequest: null },
      concurrency: 1,
      prefix,
    },
  );
  worker.on('failed', (_job, error) => logger.error(`league close failed: ${error.message}`));
  await queue.upsertJobScheduler(
    'weekly',
    { pattern: LEAGUE_CLOSE_PATTERN, tz: LEAGUE_TIMEZONE },
    { name: 'close', opts: { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } } },
  );
  await queue.add('close', {}, { jobId: `startup-${Date.now()}`, removeOnComplete: true });
  return {
    queue,
    worker,
    async stop() {
      await worker.close();
      await queue.close();
    },
  };
}
