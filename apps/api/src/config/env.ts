/**
 * Environment variables: deployment settings and secrets only.
 *
 * Business rules live in /config (see @mathpath/config). Every variable used
 * by the API is declared here and documented in .env.example, so a missing or
 * malformed value fails at start-up rather than on the first request that needs it.
 */
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Comma-separated list of browser origins allowed to call the API (web, studio).
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:3001')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url())),
  APP_VERSION: z.string().default('0.0.0-dev'),
});

/** Validated environment of the API process. */
export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates environment variables.
 *
 * @param source - The variables to read, normally `process.env`.
 * @returns The typed environment, with defaults applied.
 * @throws Error listing every invalid variable.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
