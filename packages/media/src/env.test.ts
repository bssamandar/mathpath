import { describe, expect, it, vi } from 'vitest';
import { missingMediaSettings, mediaEnvSchema, objectStoreFromEnv, vaultFromEnv } from './env';
import { S3ObjectStore } from './storage';

describe('media environment', () => {
  it('treats blank values as unset and applies defaults', () => {
    const env = mediaEnvSchema.parse({ S3_ENDPOINT: '', MEDIA_KEY_SECRET: '' });
    expect(env).toMatchObject({
      S3_ENDPOINT: undefined,
      S3_BUCKET: 'mathpath-media',
      S3_FORCE_PATH_STYLE: true,
      MEDIA_KEY_SECRET: undefined,
      MEDIA_BROWSER_ORIGINS: ['http://localhost:3000', 'http://localhost:3001'],
    });
    expect(objectStoreFromEnv(env)).toBeNull();
  });

  it('reads browser origins as a comma-separated list of URLs', () => {
    const parse = (value: string) => mediaEnvSchema.safeParse({ MEDIA_BROWSER_ORIGINS: value });
    expect(
      parse(' https://mathpath.uz, https://studio.mathpath.uz ,').data?.MEDIA_BROWSER_ORIGINS,
    ).toEqual(['https://mathpath.uz', 'https://studio.mathpath.uz']);
    expect(parse('').data?.MEDIA_BROWSER_ORIGINS).toEqual([]);
    expect(parse('not-a-url').success).toBe(false);
  });

  it('lists the settings production needs', () => {
    expect(missingMediaSettings(mediaEnvSchema.parse({}))).toEqual([
      'S3_ENDPOINT',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'MEDIA_KEY_SECRET',
    ]);
  });

  it('builds an S3 store when configured', () => {
    const env = mediaEnvSchema.parse({
      S3_ENDPOINT: 'http://seaweedfs:8333',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: 'false',
    });
    const store = objectStoreFromEnv(env);
    expect(store).toBeInstanceOf(S3ObjectStore);
    (store as S3ObjectStore).destroy();
  });

  it('rejects a short key secret and an invalid bucket name', () => {
    expect(mediaEnvSchema.safeParse({ MEDIA_KEY_SECRET: 'short' }).success).toBe(false);
    expect(mediaEnvSchema.safeParse({ S3_BUCKET: 'Bad_Bucket' }).success).toBe(false);
  });

  it('uses the configured secret, or a temporary one with a warning', () => {
    const secret = 'x'.repeat(32);
    const warn = vi.fn();
    const fixed = vaultFromEnv(mediaEnvSchema.parse({ MEDIA_KEY_SECRET: secret }), warn);
    const again = vaultFromEnv(mediaEnvSchema.parse({ MEDIA_KEY_SECRET: secret }), warn);
    expect(again.open('m', fixed.seal('m', Buffer.alloc(16, 1)))).toEqual(Buffer.alloc(16, 1));
    expect(warn).not.toHaveBeenCalled();
    vaultFromEnv(mediaEnvSchema.parse({}), warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MEDIA_KEY_SECRET'));
  });
});
