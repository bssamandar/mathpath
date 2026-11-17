/**
 * Environment variables: deployment settings and secrets only.
 *
 * Business rules live in /config (see @mathpath/config). Every variable used
 * by the API is declared here and documented in .env.example, so a missing or
 * malformed value fails at start-up rather than on the first request that needs it.
 */
import { mediaEnvSchema, missingMediaSettings } from '@mathpath/media';
import { z } from 'zod';

/** Treats `KEY=` (empty, as in .env.example) the same as an unset variable. */
const optionalSecret = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    // Prometheus metrics on a separate port for the private network only;
    // 0 turns them off. Never route this port through the public proxy.
    METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
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

    // Shared state for rate limits, revoked sessions and SMS budgets.
    REDIS_URL: optionalSecret(z.string().regex(/^rediss?:\/\//, 'expected a redis:// URL')),

    // `log` prints SMS to the console for local development only.
    SMS_PROVIDER: z.enum(['log', 'eskiz']).default('log'),
    ESKIZ_EMAIL: optionalSecret(z.string().min(3)),
    ESKIZ_PASSWORD: optionalSecret(z.string().min(1)),
    ESKIZ_SENDER: z.string().min(1).max(11).default('4546'),

    // `turnstile` is Cloudflare Turnstile (chosen 2026-11-15). `dev` accepts the
    // token "dev-pass" so the flow can be tried without a CAPTCHA account.
    CAPTCHA_PROVIDER: z.enum(['turnstile', 'dev']).default('dev'),
    TURNSTILE_SECRET_KEY: optionalSecret(z.string().min(1)),
    // `hibp` checks new passwords against Have I Been Pwned with k-anonymity (C-02).
    BREACHED_PASSWORD_CHECK: z.enum(['hibp', 'off']).default('hibp'),

    // Payment providers offered at checkout, comma-separated (ADR-0008). Empty
    // means checkout is closed; each listed provider needs its credentials.
    PAYMENT_PROVIDERS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.enum(['payme', 'click']))),
    // Payme Merchant API: the cashbox ID and its key (test key on staging).
    PAYME_MERCHANT_ID: optionalSecret(
      z.string().regex(/^[0-9a-f]{24}$/, 'expected a 24-character cashbox ID'),
    ),
    PAYME_KEY: optionalSecret(z.string().min(8)),
    // checkout.test.paycom.uz on staging, checkout.paycom.uz in production.
    PAYME_CHECKOUT_URL: z.url().default('https://checkout.test.paycom.uz'),
    // Click Shop API: the service and merchant IDs and the service's secret key.
    CLICK_SERVICE_ID: optionalSecret(
      z.string().regex(/^\d{1,10}$/, 'expected a numeric service ID'),
    ),
    CLICK_MERCHANT_ID: optionalSecret(
      z.string().regex(/^\d{1,10}$/, 'expected a numeric merchant ID'),
    ),
    CLICK_SECRET_KEY: optionalSecret(z.string().min(8)),
    CLICK_CHECKOUT_URL: z.url().default('https://my.click.uz/services/pay'),
    // Click Merchant API, for refunds (reversals): the merchant user ID from the
    // Click cabinet. Without it, Click refunds are done in the cabinet by hand.
    CLICK_MERCHANT_USER_ID: optionalSecret(
      z.string().regex(/^\d{1,10}$/, 'expected a numeric merchant user ID'),
    ),
    CLICK_MERCHANT_API_URL: z.url().default('https://api.click.uz/v2/merchant'),
  })
  // Storage and the media key secret, shared with the worker.
  .extend(mediaEnvSchema.shape)
  .superRefine((env, ctx) => {
    if (env.SMS_PROVIDER === 'eskiz') {
      for (const key of ['ESKIZ_EMAIL', 'ESKIZ_PASSWORD'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required for Eskiz' });
      }
    }
    if (env.PAYMENT_PROVIDERS.includes('payme')) {
      for (const key of ['PAYME_MERCHANT_ID', 'PAYME_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required for Payme' });
      }
    }
    if (env.PAYMENT_PROVIDERS.includes('click')) {
      for (const key of ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID', 'CLICK_SECRET_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required for Click' });
      }
    }
    if (env.CAPTCHA_PROVIDER === 'turnstile' && !env.TURNSTILE_SECRET_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURNSTILE_SECRET_KEY'],
        message: 'required for Turnstile',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (!env.REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'required in production: in-memory limits do not work across instances',
      });
    }
    if (env.CAPTCHA_PROVIDER === 'dev') {
      ctx.addIssue({
        code: 'custom',
        path: ['CAPTCHA_PROVIDER'],
        message: 'the dev CAPTCHA accepts a fixed token and is not allowed in production',
      });
    }
    // Generated keys would change on every restart and differ between
    // instances, signing everybody out; they are never acceptable in production.
    for (const key of ['JWT_PRIVATE_KEY', 'AUTH_HMAC_SECRET'] as const) {
      if (!env[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
    }
    for (const key of missingMediaSettings(env)) {
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
