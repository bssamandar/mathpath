import { describe, expect, it } from 'vitest';
import { originOf, studioCsp } from './csp';
import { isMessageKey, t } from './i18n';
import { otpauthSecret } from './mfa';

describe('otpauthSecret', () => {
  it('groups the secret for typing', () => {
    expect(otpauthSecret('otpauth://totp/MathPath:x?secret=ABCDEFGHIJ&issuer=MathPath')).toBe(
      'ABCD EFGH IJ',
    );
  });
  it('returns null for missing secrets or bad URIs', () => {
    expect(otpauthSecret('otpauth://totp/x')).toBeNull();
    expect(otpauthSecret('not a uri')).toBeNull();
  });
});

describe('t', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(t('editor.version', { n: 3 })).toContain('3');
    expect(t('editor.version')).toContain('{n}');
  });
  it('knows its keys', () => {
    expect(isMessageKey('error.generic')).toBe(true);
    expect(isMessageKey('error.nope')).toBe(false);
  });
});

describe('studioCsp', () => {
  it('allows uploads to the storage origin only', () => {
    const csp = studioCsp('abc', { dev: false, mediaOrigin: 'https://media.example.uz/bucket' });
    expect(csp).toContain("connect-src 'self' https://media.example.uz;");
    expect(csp).toContain("'nonce-abc'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain('upgrade-insecure-requests');
  });
  it('relaxes eval in development and works without storage', () => {
    const csp = studioCsp('abc', { dev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self';");
  });
  it('ignores origins that are not http(s)', () => {
    expect(originOf('javascript:alert(1)')).toBeUndefined();
    expect(originOf('::')).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
    expect(originOf('http://localhost:8333/x')).toBe('http://localhost:8333');
  });
});
