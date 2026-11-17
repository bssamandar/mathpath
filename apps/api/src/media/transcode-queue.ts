/**
 * Hands uploaded videos to the worker (ADR-0007: BullMQ on Redis).
 *
 * The job ID is the media ID, so a repeated "upload finished" call cannot
 * queue the same video twice. If enqueueing fails after the row was marked
 * uploaded, the studio calls "complete" again and the job is added then;
 * an outbox would remove that retry, and is the upgrade if it bites.
 */
import { Logger } from '@nestjs/common';
import { TRANSCODE_QUEUE, type TranscodeJob } from '@mathpath/media';
import { Queue } from 'bullmq';

export abstract class TranscodeQueue {
  abstract enqueue(mediaId: string): Promise<void>;
  abstract close(): Promise<void>;
}

export class BullTranscodeQueue extends TranscodeQueue {
  /** Exposed for tests, which inspect the jobs. */
  readonly queue: Queue<TranscodeJob>;

  /** @param prefix - Redis key prefix; tests use their own. */
  constructor(redisUrl: string, prefix = 'bull') {
    super();
    this.queue = new Queue<TranscodeJob>(TRANSCODE_QUEUE, {
      connection: { url: redisUrl, maxRetriesPerRequest: 2 },
      prefix,
    });
  }

  async enqueue(mediaId: string): Promise<void> {
    await this.queue.add(
      'transcode',
      { mediaId },
      {
        jobId: mediaId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}

/** Without Redis (local development) videos stay "uploaded"; nothing transcodes them. */
export class NoTranscodeQueue extends TranscodeQueue {
  private readonly logger = new Logger('TranscodeQueue');

  enqueue(mediaId: string): Promise<void> {
    this.logger.warn(`REDIS_URL is not set: video ${mediaId} will not be transcoded.`);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
