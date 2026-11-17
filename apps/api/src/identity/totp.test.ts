import { describe, expect, it } from 'vitest';
import { base32, hotp, matchTotp, otpauthUri, totpStep } from './totp';

// RFC 6238 appendix B, SHA-1 key.
const RFC_SECRET = Buffer.from('12345678901234567890');

describe('TOTP (RFC 6238)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('matches the RFC test vector at %i s', (seconds, expected) => {
    expect(hotp(RFC_SECRET, totpStep(new Date(seconds * 1000)), 8)).toBe(expected);
  });

  it('accepts one step of drift and refuses a step already used', () => {
    const now = new Date('2026-11-16T10:00:10Z');
    const step = totpStep(now);
    const previous = hotp(RFC_SECRET, step - 1);
    expect(matchTotp(RFC_SECRET, previous, now, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, previous, now, step - 1)).toBeNull();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
  });

  it('encodes base32 as authenticator apps expect (RFC 4648)', () => {
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('builds an otpauth URI with issuer and settings', () => {
    const uri = new URL(otpauthUri(RFC_SECRET, 'MathPath', '+998 ** *** 45 67'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri.searchParams.get('issuer')).toBe('MathPath');
    expect(uri.searchParams.get('digits')).toBe('6');
  });
});
