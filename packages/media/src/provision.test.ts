/** Runs against a real S3-compatible server when TEST_S3_ENDPOINT is set. */
import { describe, expect, it } from 'vitest';
import { provisionStorage } from './provision';

describe('provisionStorage', () => {
  it('refuses to run without storage settings or browser origins', async () => {
    await expect(provisionStorage({})).rejects.toThrow('S3_ENDPOINT');
    await expect(
      provisionStorage({
        S3_ENDPOINT: 'http://127.0.0.1:1',
        S3_ACCESS_KEY_ID: 'a',
        S3_SECRET_ACCESS_KEY: 'b',
        MEDIA_BROWSER_ORIGINS: '',
      }),
    ).rejects.toThrow('MEDIA_BROWSER_ORIGINS');
  });

  const endpoint = process.env.TEST_S3_ENDPOINT;
  it.runIf(endpoint)('creates the bucket and its CORS rule, and can run again', async () => {
    const env = {
      S3_ENDPOINT: endpoint,
      S3_BUCKET: 'mathpath-provision-test',
      S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'mathpath',
      S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'mathpath_local_only',
      MEDIA_BROWSER_ORIGINS: 'https://mathpath.example,https://studio.mathpath.example',
    };
    const message =
      'Bucket mathpath-provision-test is ready for https://mathpath.example, https://studio.mathpath.example.';
    expect(await provisionStorage(env)).toBe(message);
    expect(await provisionStorage(env)).toBe(message);
  });
});
