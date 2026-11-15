/** Small cryptographic helpers shared by the identity module. */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Compares two strings in constant time, so the response time does not reveal
 * how many leading characters of a guess were right.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** @returns A random 256-bit token, base64url-encoded (43 characters). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of a token. Refresh tokens are stored only as this hash (C-06). */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** @returns A uniformly random numeric code with exactly `length` digits. */
export function randomDigits(length: number): string {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, '0');
}
