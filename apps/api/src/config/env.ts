/**
 * Environment variables: deployment settings and secrets only.
 *
 * Business rules live in /config (see @mathpath/config). Every variable used
 * by the API is declared here and documented in .env.example, so a missing or
 * malformed value fails at start-up rather than on the first request that needs it.
 */
import { z } from 'zod';

/** Treats `KEY=` (empty, as in .env.example) the same as an unset variable. */
const optionalSecret = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const envSchema = z
  .object({
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
    // Number of reverse proxies in front of the API. Needed to read the real
    // client IP from X-Forwarded-For; trusting more hops than exist lets
    // clients spoof their IP and dodge per-IP rate limits.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'expected a postgres:// URL'),

    // Ed25519 private key (PKCS#8 PEM) that signs access tokens, and its key ID.
    // Optional in development: an in-memory key is generated at start-up.
    JWT_PRIVATE_KEY: optionalSecret(z.string()),
    JWT_KEY_ID: z.string().min(1).max(64).default('dev'),
    // During key rotation, the previous public key (SPKI PEM) and its ID keep
    // tokens signed before the rotation valid until they expire (C-06).
    JWT_PREVIOUS_PUBLIC_KEY: optionalSecret(z.string()),
    JWT_PREVIOUS_KEY_ID: optionalSecret(z.string().min(1).max(64)),
    // Root secret for HMACs (OTP code hashes, CSRF tokens). At least 32 bytes.
    // Optional in development: a random one is generated at start-up.
    AUTH_HMAC_SECRET: optionalSecret(z.string().min(32)),

    // `log` prints SMS to the console for local development only.
    SMS_PROVIDER: z.enum(['log']).default('log'),
    // `hibp` checks new passwords against Have I Been Pwned with k-anonymity (C-02).
    BREACHED_PASSWORD_CHECK: z.enum(['hibp', 'off']).default('hibp'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Generated keys would change on every restart and differ between
    // instances, signing everybody out; they are never acceptable in production.
    for (const key of ['JWT_PRIVATE_KEY', 'AUTH_HMAC_SECRET'] as const) {
      if (!env[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
    }
    if (env.SMS_PROVIDER === 'log') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'the log provider prints codes to the console and is not allowed in production',
      });
    }
  })
  .refine((env) => !env.JWT_PREVIOUS_PUBLIC_KEY === !env.JWT_PREVIOUS_KEY_ID, {
    path: ['JWT_PREVIOUS_KEY_ID'],
    message: 'set JWT_PREVIOUS_PUBLIC_KEY and JWT_PREVIOUS_KEY_ID together',
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
