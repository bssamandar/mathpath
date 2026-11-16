/**
 * Environment variables for media, shared by the API and the worker so both
 * read the same names. Documented in .env.example.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { MediaKeyVault } from './vault';
import { type ObjectStore, S3ObjectStore } from './storage';

const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

export const mediaEnvSchema = z.object({
  // Internal S3 endpoint (e.g. http://seaweedfs:8333) and the one browsers use.
  S3_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
  S3_PUBLIC_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('mathpath-media'),
  S3_ACCESS_KEY_ID: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Seals the per-video HLS keys at rest. At least 32 bytes.
  MEDIA_KEY_SECRET: z.preprocess(blankToUndefined, z.string().min(32).optional()),
});

export type MediaEnv = z.infer<typeof mediaEnvSchema>;

/** Settings production cannot start without; empty when all are set. */
export function missingMediaSettings(env: MediaEnv): (keyof MediaEnv)[] {
  return (
    ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'MEDIA_KEY_SECRET'] as const
  ).filter((key) => !env[key]);
}

/** @returns null when no storage is configured (local runs without SeaweedFS). */
export function objectStoreFromEnv(env: MediaEnv): ObjectStore | null {
  if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null;
  return new S3ObjectStore({
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}

/**
 * Outside production a missing secret is replaced by a random one; videos
 * transcoded before a restart then cannot be played, which is fine locally.
 */
export function vaultFromEnv(env: MediaEnv, warn: (message: string) => void): MediaKeyVault {
  if (env.MEDIA_KEY_SECRET) return new MediaKeyVault(Buffer.from(env.MEDIA_KEY_SECRET, 'utf8'));
  warn('MEDIA_KEY_SECRET is not set: using a temporary secret (development only).');
  return new MediaKeyVault(randomBytes(32));
}
