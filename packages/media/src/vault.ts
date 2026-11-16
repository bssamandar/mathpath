/**
 * Sealing of HLS content keys at rest (docs/database-schema.md §3.5, C-17).
 *
 * Each video is encrypted with its own random AES-128 key. The key is stored
 * in `media_keys` sealed with AES-256-GCM under a key derived from
 * `MEDIA_KEY_SECRET`, so a database dump alone cannot decrypt any video. The
 * media ID is bound as associated data: a sealed key copied onto another
 * video's row fails to open.
 *
 * `MEDIA_KEY_SECRET` is separate from the auth secrets because the worker
 * needs it too, and the worker must not be able to mint sessions.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class MediaKeyVault {
  private readonly key: Buffer;

  /** @param secret - At least 32 bytes of secret material. */
  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error('MEDIA_KEY_SECRET must be at least 32 bytes');
    this.key = Buffer.from(hkdfSync('sha256', secret, '', 'mathpath:seal:media-key', 32));
  }

  /** @returns IV (12 bytes) + tag (16 bytes) + ciphertext. */
  seal(mediaId: string, contentKey: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(mediaId, 'utf8'));
    const body = Buffer.concat([cipher.update(contentKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  /** Reverses {@link seal}. @throws Error when the value was changed or belongs to another video. */
  open(mediaId: string, sealed: Buffer): Buffer {
    // A fixed tag length, so a cut-short value cannot pass with a shorter tag.
    if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('sealed key is too short');
    const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0, IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(mediaId, 'utf8'));
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  }
}
