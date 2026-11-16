/**
 * Object storage for media (docs/architecture.md §7.3).
 *
 * Production uses any S3-compatible service; local development and CI use
 * SeaweedFS. The bucket is private: browsers only ever get presigned URLs
 * that expire, for one object and one method.
 *
 * Two endpoints are kept apart on purpose. The API and worker reach the
 * store over the internal network (`S3_ENDPOINT`), while presigned URLs must
 * name the host the browser can reach (`S3_PUBLIC_ENDPOINT`). Presigning is
 * pure computation, so the public client never opens a connection.
 */
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface StoredObject {
  sizeBytes: number;
  contentType: string | undefined;
}

export interface ObjectStore {
  /** A URL the browser may PUT exactly this type and size to, until it expires. */
  presignUpload(
    key: string,
    contentType: string,
    sizeBytes: number,
    ttlSeconds: number,
  ): Promise<string>;
  /** A URL the browser may GET this object from, until it expires. */
  presignDownload(key: string, ttlSeconds: number): Promise<string>;
  /** @returns null when the object does not exist. */
  head(key: string): Promise<StoredObject | null>;
  /** Reads a whole object, or `length` bytes from the start. */
  read(key: string, length?: number): Promise<Buffer>;
  write(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Streams an object to a local file (large videos do not fit in memory). */
  download(key: string, filePath: string): Promise<void>;
}

export interface S3Settings {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (`host/bucket/key`); SeaweedFS and most self-hosted stores need it. */
  forcePathStyle: boolean;
}

export class S3ObjectStore implements ObjectStore {
  private readonly internal: S3Client;
  private readonly public: S3Client;

  constructor(private readonly settings: S3Settings) {
    const common = {
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
    };
    this.internal = new S3Client({ ...common, endpoint: settings.endpoint });
    this.public = new S3Client({ ...common, endpoint: settings.publicEndpoint });
  }

  presignUpload(key: string, contentType: string, sizeBytes: number, ttlSeconds: number) {
    // Content-Type and Content-Length are signed, so the browser cannot send
    // another type or a larger file with the same URL.
    const command = new PutObjectCommand({
      Bucket: this.settings.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
    });
    return getSignedUrl(this.public, command, {
      expiresIn: ttlSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  presignDownload(key: string, ttlSeconds: number) {
    const command = new GetObjectCommand({ Bucket: this.settings.bucket, Key: key });
    return getSignedUrl(this.public, command, { expiresIn: ttlSeconds });
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const out = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.settings.bucket, Key: key }),
      );
      return { sizeBytes: out.ContentLength ?? 0, contentType: out.ContentType };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async read(key: string, length?: number): Promise<Buffer> {
    const out = await this.internal.send(
      new GetObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        ...(length === undefined ? {} : { Range: `bytes=0-${length - 1}` }),
      }),
    );
    return Buffer.from(await out.Body!.transformToByteArray());
  }

  async write(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async download(key: string, filePath: string): Promise<void> {
    const out = await this.internal.send(
      new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }),
    );
    await pipeline(out.Body as Readable, createWriteStream(filePath, { mode: 0o600 }));
  }

  /**
   * Creates the bucket if it is missing and lets the given browser origins reach
   * it (local development and CI; production buckets are provisioned, Phase 7).
   */
  async ensureBucket(browserOrigins: readonly string[] = []): Promise<void> {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.settings.bucket }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.internal.send(new CreateBucketCommand({ Bucket: this.settings.bucket }));
    }
    if (browserOrigins.length === 0) return;
    // The studio PUTs uploads and the player GETs segments straight from storage.
    await this.internal.send(
      new PutBucketCorsCommand({
        Bucket: this.settings.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [...browserOrigins],
              AllowedMethods: ['GET', 'HEAD', 'PUT'],
              AllowedHeaders: ['content-type', 'range'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  }

  /** Closes the HTTP connection pools. */
  destroy(): void {
    this.internal.destroy();
    this.public.destroy();
  }
}

/**
 * An in-memory store for tests. Presigned URLs use the `memory:` scheme and
 * carry the method, type, size and expiry so tests can assert on them.
 */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  presignUpload(key: string, contentType: string, sizeBytes: number, ttlSeconds: number) {
    const query = new URLSearchParams({
      method: 'PUT',
      type: contentType,
      size: String(sizeBytes),
      ttl: String(ttlSeconds),
    });
    return Promise.resolve(`memory://bucket/${key}?${query.toString()}`);
  }

  presignDownload(key: string, ttlSeconds: number) {
    return Promise.resolve(`memory://bucket/${key}?method=GET&ttl=${ttlSeconds}`);
  }

  head(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object ? { sizeBytes: object.body.length, contentType: object.contentType } : null,
    );
  }

  read(key: string, length?: number): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) return Promise.reject(new Error(`no such object: ${key}`));
    return Promise.resolve(length === undefined ? object.body : object.body.subarray(0, length));
  }

  write(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return Promise.resolve();
  }

  async download(key: string, filePath: string): Promise<void> {
    const body = await this.read(key);
    await pipeline(Readable.from([body]), createWriteStream(filePath, { mode: 0o600 }));
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof NotFound || (error as { name?: string }).name === 'NotFound';
}

/** Where things live in the bucket. One place, so API and worker agree. */
export const mediaKeys = {
  source: (mediaId: string) => `sources/${mediaId}`,
  hlsDir: (mediaId: string) => `hls/${mediaId}`,
  hls: (mediaId: string, file: string) => `hls/${mediaId}/${file}`,
};
