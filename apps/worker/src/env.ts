/**
 * Environment of the worker process. Storage and the media key secret use
 * the same names as the API (@mathpath/media); documented in .env.example.
 */
import { mediaEnvSchema, missingMediaSettings } from '@mathpath/media';
import { z } from 'zod';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

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
    // The Sunday report SMS (config/reports.yaml); same settings as the API.
    SMS_PROVIDER: z.enum(['log', 'eskiz']).default('log'),
    ESKIZ_EMAIL: optional(z.string().min(3)),
    ESKIZ_PASSWORD: optional(z.string().min(1)),
    ESKIZ_SENDER: z.string().min(1).max(11).default('4546'),
    // The parent web app; the report SMS links to its /parent page.
    WEB_ORIGIN: z.url().default('http://localhost:3000'),
  })
  .extend(mediaEnvSchema.shape)
  .superRefine((env, ctx) => {
    // Without storage there is nothing to transcode from, in any environment.
    for (const key of missingMediaSettings(env)) {
      if (key === 'MEDIA_KEY_SECRET' && env.NODE_ENV !== 'production') continue;
      ctx.addIssue({ code: 'custom', path: [key], message: 'required' });
    }
    if (env.SMS_PROVIDER === 'eskiz') {
      for (const key of ['ESKIZ_EMAIL', 'ESKIZ_PASSWORD'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required for Eskiz' });
      }
    }
    if (env.NODE_ENV === 'production') {
      if (env.SMS_PROVIDER === 'log') {
        ctx.addIssue({
          code: 'custom',
          path: ['SMS_PROVIDER'],
          message: 'the log provider does not send SMS and is not allowed in production',
        });
      }
      if (!env.WEB_ORIGIN.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEB_ORIGIN'],
          message: 'must be https:// in production',
        });
      }
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
