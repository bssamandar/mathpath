/**
 * Production storage set-up (docs/guides/deploy.md): creates the media bucket
 * if it is missing and writes its CORS rule for the web and studio origins.
 * Outside production the API does this itself at start-up; in production the
 * API never changes the bucket, so the deploy script runs this once per
 * deploy with the same environment as the API.
 */
import { mediaEnvSchema, objectStoreFromEnv } from './env';
import type { S3ObjectStore } from './storage';

export async function provisionStorage(raw: Record<string, string | undefined>): Promise<string> {
  const env = mediaEnvSchema.parse(raw);
  const store = objectStoreFromEnv(env) as S3ObjectStore | null;
  if (!store) {
    throw new Error('S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set');
  }
  if (env.MEDIA_BROWSER_ORIGINS.length === 0) {
    throw new Error('MEDIA_BROWSER_ORIGINS must list the web and studio origins');
  }
  try {
    await store.ensureBucket(env.MEDIA_BROWSER_ORIGINS);
  } finally {
    store.destroy();
  }
  return `Bucket ${env.S3_BUCKET} is ready for ${env.MEDIA_BROWSER_ORIGINS.join(', ')}.`;
}
