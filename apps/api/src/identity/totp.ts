/**
 * Time-based one-time passwords (RFC 6238) for staff 2FA (C-08).
 *
 * Written here rather than taken from a library such as otplib: the algorithm
 * is about thirty lines on top of node:crypto, the RFC test vectors check it,
 * and a dependency in the login path is one more thing to audit and update.
 * Authenticator apps (Google Authenticator, Microsoft Authenticator, Aegis)
 * all use the defaults below: HMAC-SHA-1, 6 digits, 30-second steps.
 */
import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto';

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The time step a moment falls in. */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_S);
}

/** HOTP (RFC 4226) for one counter value; TOTP uses the time step as the counter. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Finds the step a code belongs to, allowing one step of clock drift either way.
 *
 * @param lastUsedStep - The highest step already accepted. Codes from that step
 *   or earlier are refused, so a code seen over someone's shoulder or in a
 *   phishing proxy cannot be used a second time.
 * @returns The matching step, or null.
 */
export function matchTotp(
  secret: Buffer,
  code: string,
  now: Date,
  lastUsedStep: number | null,
): number | null {
  const current = totpStep(now);
  let match: number | null = null;
  // Every candidate is checked, so the time taken does not reveal which one matched.
  for (const step of [current - 1, current, current + 1]) {
    if (safeEqual(hotp(secret, step), code) && (lastUsedStep === null || step > lastUsedStep)) {
      match = step;
    }
  }
  return match;
}

/** Base32 without padding, the form authenticator apps expect in an otpauth URI. */
export function base32(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The `otpauth://` URI shown as a QR code during enrolment. */
export function otpauthUri(secret: Buffer, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_S),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
