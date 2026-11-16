import { describe, expect, it } from 'vitest';
import { parseWorkerEnv } from './env';

const base = {
  DATABASE_URL: 'postgres://localhost/mathpath',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY_ID: 'mathpath',
  S3_SECRET_ACCESS_KEY: 'secret',
};

describe('parseWorkerEnv', () => {
  it('accepts a development setup without a media key secret', () => {
    expect(parseWorkerEnv(base)).toMatchObject({
      TRANSCODE_CONCURRENCY: 1,
      S3_BUCKET: 'mathpath-media',
    });
  });

  it('needs Redis and storage always, and the key secret in production', () => {
    expect(() => parseWorkerEnv({ ...base, REDIS_URL: '' })).toThrow(/REDIS_URL/);
    expect(() => parseWorkerEnv({ ...base, S3_ENDPOINT: '' })).toThrow(/S3_ENDPOINT/);
    expect(() => parseWorkerEnv({ ...base, NODE_ENV: 'production' })).toThrow(/MEDIA_KEY_SECRET/);
  });
});
