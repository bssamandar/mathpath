/**
 * Environment of the worker process. Storage and the media key secret use
 * the same names as the API (@mathpath/media); documented in .env.example.
 */
import { mediaEnvSchema, missingMediaSettings } from '@mathpath/media';
import { z } from 'zod';

const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'expected a postgres:// URL'),
    // The worker only consumes queues, so it cannot run without Redis.
    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'expected a redis:// URL'),
    TRANSCODE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    APP_VERSION: z.string().default('0.0.0-dev'),
    // Prometheus metrics on the private network; 0 turns them off.
    WORKER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9465),
  })
  .extend(mediaEnvSchema.shape)
  .superRefine((env, ctx) => {
    // Without storage there is nothing to transcode from, in any environment.
    for (const key of missingMediaSettings(env)) {
      if (key === 'MEDIA_KEY_SECRET' && env.NODE_ENV !== 'production') continue;
      ctx.addIssue({ code: 'custom', path: [key], message: 'required' });
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** @throws Error listing every invalid variable. */
export function parseWorkerEnv(source: NodeJS.ProcessEnv): WorkerEnv {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
