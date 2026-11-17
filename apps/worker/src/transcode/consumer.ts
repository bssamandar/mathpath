/**
 * Runs transcoding jobs from the queue (ADR-0007). One job at a time per
 * worker by default: an encode uses every core it gets.
 */
import { Logger } from '@nestjs/common';
import { TRANSCODE_QUEUE, type TranscodeJob } from '@mathpath/media';
import { type Job, Worker } from 'bullmq';
import type { Transcoder } from './transcoder';

export interface ConsumerOptions {
  redisUrl: string;
  concurrency: number;
  /** Redis key prefix; tests use their own. */
  prefix?: string;
  /** Called with each job's outcome (`error` when it threw), for metrics. */
  onOutcome?: (outcome: 'ready' | 'rejected' | 'skipped' | 'error') => void;
}

export function startTranscodeConsumer(
  transcoder: Transcoder,
  options: ConsumerOptions,
): Worker<TranscodeJob> {
  const logger = new Logger('Transcode');
  const worker = new Worker<TranscodeJob>(
    TRANSCODE_QUEUE,
    async (job: Job<TranscodeJob>) => {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const result = await transcoder.run(job.data.mediaId, finalAttempt);
      options.onOutcome?.(result.outcome);
      logger.log(
        `video ${job.data.mediaId}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`,
      );
      return result;
    },
    {
      // BullMQ workers block on Redis, so commands must not give up early.
      connection: { url: options.redisUrl, maxRetriesPerRequest: null },
      concurrency: options.concurrency,
      prefix: options.prefix ?? 'bull',
      // A long encode keeps its lock; a stalled job (dead worker) is retried.
      lockDuration: 120_000,
    },
  );
  worker.on('failed', (job, error) => {
    options.onOutcome?.('error');
    logger.error(`video ${job?.data.mediaId ?? '?'} failed: ${error.message}`);
  });
  return worker;
}
