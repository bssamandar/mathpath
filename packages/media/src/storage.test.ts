/**
 * The memory store always runs. The S3 store runs against a real
 * S3-compatible server when TEST_S3_ENDPOINT is set (SeaweedFS in CI).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaKeys, MemoryObjectStore, type ObjectStore, S3ObjectStore } from './storage';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mp-media-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function contract(name: string, make: () => ObjectStore) {
  describe(name, () => {
    it('writes, reads, heads and downloads an object', async () => {
      const store = make();
      const key = `test/${Date.now()}-${Math.random()}`;
      expect(await store.head(key)).toBeNull();
      await store.write(key, Buffer.from('hello world'), 'text/plain');
      expect(await store.head(key)).toEqual({ sizeBytes: 11, contentType: 'text/plain' });
      expect((await store.read(key)).toString()).toBe('hello world');
      expect((await store.read(key, 5)).toString()).toBe('hello');
      const file = join(dir, 'download');
      await store.download(key, file);
      expect(await readFile(file, 'utf8')).toBe('hello world');
    });

    it('presigns upload and download URLs', async () => {
      const store = make();
      const put = await store.presignUpload('sources/abc', 'video/mp4', 1234, 900);
      const get = await store.presignDownload('hls/abc/720p/seg_0000.ts', 600);
      expect(put).toContain('sources/abc');
      expect(get).toContain('hls/abc/720p/seg_0000.ts');
    });
  });
}

contract('MemoryObjectStore', () => new MemoryObjectStore());

describe('MemoryObjectStore errors', () => {
  it('fails to read a missing object', async () => {
    await expect(new MemoryObjectStore().read('nope')).rejects.toThrow('no such object');
  });
});

const endpoint = process.env.TEST_S3_ENDPOINT;
if (endpoint) {
  const settings = {
    endpoint,
    publicEndpoint: 'https://media.example.uz',
    region: 'us-east-1',
    bucket: 'mathpath-test',
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? 'mathpath',
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'mathpath_local_only',
    forcePathStyle: true,
  };
  const s3 = new S3ObjectStore(settings);
  beforeAll(async () => {
    await s3.ensureBucket();
    await s3.ensureBucket(); // a second call is harmless
  });
  afterAll(() => s3.destroy());
  contract('S3ObjectStore', () => s3);

  describe('S3ObjectStore presigning', () => {
    it('signs type and size into upload URLs, for the public host', async () => {
      const url = new URL(await s3.presignUpload('sources/x', 'video/mp4', 42, 900));
      expect(url.origin).toBe('https://media.example.uz');
      expect(url.pathname).toBe('/mathpath-test/sources/x');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    });

    it('accepts an upload through a presigned URL and refuses a different type', async () => {
      const internal = new S3ObjectStore({ ...settings, publicEndpoint: endpoint });
      const body = Buffer.from('fake mp4 bytes');
      const key = `sources/${Date.now()}`;
      const url = await internal.presignUpload(key, 'video/mp4', body.length, 60);
      const wrong = await fetch(url, {
        method: 'PUT',
        body,
        headers: { 'content-type': 'image/png' },
      });
      expect(wrong.ok).toBe(false);
      const ok = await fetch(url, {
        method: 'PUT',
        body,
        headers: { 'content-type': 'video/mp4' },
      });
      expect(ok.status).toBe(200);
      expect(await internal.head(key)).toEqual({
        sizeBytes: body.length,
        contentType: 'video/mp4',
      });
      internal.destroy();
    });
  });
}

describe('mediaKeys', () => {
  it('names where sources and HLS files live', () => {
    expect(mediaKeys.source('m1')).toBe('sources/m1');
    expect(mediaKeys.hlsDir('m1')).toBe('hls/m1');
    expect(mediaKeys.hls('m1', 'master.m3u8')).toBe('hls/m1/master.m3u8');
  });
});
