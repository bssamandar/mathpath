/**
 * Key material for authentication (ADR-0005, C-03, C-06, C-07).
 *
 * One Ed25519 key signs JWTs; during a rotation the previous public key still
 * verifies tokens it signed. HMAC keys are derived per purpose from one root
 * secret with HKDF, so an HMAC computed for one purpose (an OTP hash) can never
 * be replayed as another (a CSRF token).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Env } from '../config/env';

/** Everything an HMAC is used for. Adding a purpose derives a new, independent key. */
export type HmacPurpose = 'otp' | 'csrf' | 'recovery';

/** Everything encrypted at rest with a derived key. */
export type SealPurpose = 'mfa-secret';

export class AuthKeys {
  private readonly derived = new Map<string, Buffer>();

  /**
   * @param signingKey - Ed25519 private key for new tokens.
   * @param keyId - Written to the JWT `kid` header.
   * @param verifyKeys - Public keys accepted for verification, by key ID.
   * @param hmacRoot - Root secret for {@link hmac}.
   */
  constructor(
    readonly signingKey: KeyObject,
    readonly keyId: string,
    private readonly verifyKeys: ReadonlyMap<string, KeyObject>,
    private readonly hmacRoot: Buffer,
  ) {}

  /**
   * Builds the keys from the environment.
   *
   * Outside production, missing keys are generated in memory and a warning is
   * logged; tokens then stop working after a restart, which is fine locally.
   */
  static fromEnv(env: Env): AuthKeys {
    const logger = new Logger('AuthKeys');
    let signingKey: KeyObject;
    if (env.JWT_PRIVATE_KEY) {
      signingKey = createPrivateKey(env.JWT_PRIVATE_KEY.replaceAll('\\n', '\n'));
      if (signingKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('JWT_PRIVATE_KEY must be an Ed25519 key (ADR-0005)');
      }
    } else {
      logger.warn('JWT_PRIVATE_KEY is not set: using a temporary key (development only).');
      signingKey = generateKeyPairSync('ed25519').privateKey;
    }

    const verifyKeys = new Map<string, KeyObject>([[env.JWT_KEY_ID, createPublicKey(signingKey)]]);
    if (env.JWT_PREVIOUS_PUBLIC_KEY && env.JWT_PREVIOUS_KEY_ID) {
      verifyKeys.set(
        env.JWT_PREVIOUS_KEY_ID,
        createPublicKey(env.JWT_PREVIOUS_PUBLIC_KEY.replaceAll('\\n', '\n')),
      );
    }

    let hmacRoot: Buffer;
    if (env.AUTH_HMAC_SECRET) {
      hmacRoot = Buffer.from(env.AUTH_HMAC_SECRET, 'utf8');
    } else {
      logger.warn('AUTH_HMAC_SECRET is not set: using a temporary secret (development only).');
      hmacRoot = randomBytes(32);
    }
    return new AuthKeys(signingKey, env.JWT_KEY_ID, verifyKeys, hmacRoot);
  }

  /** @returns The public key for a JWT `kid`, or undefined for an unknown key. */
  verificationKey(keyId: string | undefined): KeyObject | undefined {
    return keyId === undefined ? undefined : this.verifyKeys.get(keyId);
  }

  /**
   * Computes an HMAC-SHA-256 with the key derived for `purpose`.
   * @returns The MAC, base64url-encoded.
   */
  hmac(purpose: HmacPurpose, data: string): string {
    return createHmac('sha256', this.derive(purpose)).update(data).digest('base64url');
  }

  /**
   * Encrypts a secret for storage with AES-256-GCM (C-08: TOTP secrets are not
   * stored in clear, so a database dump alone cannot produce staff codes).
   * @returns IV (12 bytes) + tag (16 bytes) + ciphertext.
   */
  seal(purpose: SealPurpose, plaintext: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.derive(`seal:${purpose}`), iv, {
      authTagLength: 16,
    });
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  /** Reverses {@link seal}. @throws Error when the data was changed or sealed with another key. */
  open(purpose: SealPurpose, sealed: Buffer): Buffer {
    // A fixed tag length, so a cut-short value cannot pass with a shorter tag.
    if (sealed.length < 28) throw new Error('sealed value is too short');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.derive(`seal:${purpose}`),
      sealed.subarray(0, 12),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
  }

  private derive(info: string): Buffer {
    let key = this.derived.get(info);
    if (!key) {
      // Existing HMAC keys keep their info string, so stored OTP hashes stay valid.
      key = Buffer.from(hkdfSync('sha256', this.hmacRoot, '', `mathpath:${info}`, 32));
      this.derived.set(info, key);
    }
    return key;
  }
}
