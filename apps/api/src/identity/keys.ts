/**
 * Key material for authentication (ADR-0005, C-03, C-06, C-07).
 *
 * One Ed25519 key signs JWTs; during a rotation the previous public key still
 * verifies tokens it signed. HMAC keys are derived per purpose from one root
 * secret with HKDF, so an HMAC computed for one purpose (an OTP hash) can never
 * be replayed as another (a CSRF token).
 */
import {
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
export type HmacPurpose = 'otp' | 'csrf';

export class AuthKeys {
  private readonly hmacKeys = new Map<HmacPurpose, Buffer>();

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
    let key = this.hmacKeys.get(purpose);
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', this.hmacRoot, '', `mathpath:${purpose}`, 32));
      this.hmacKeys.set(purpose, key);
    }
    return createHmac('sha256', key).update(data).digest('base64url');
  }
}
