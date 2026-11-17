import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactText } from './redact';

describe('redact', () => {
  it('masks phone numbers, bearer tokens and JWTs in text', () => {
    expect(redactText('OTP to +998901234567 and 998977770202 sent')).toBe(
      'OTP to +99890*****67 and +99897*****02 sent',
    );
    expect(redactText('Authorization: Bearer abc.def-ghi')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactText('token eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln here')).toBe(
      'token [jwt] here',
    );
    // Ordinary numbers stay: counts, amounts, IDs.
    expect(redactText('order 12345 paid 990000 tiyin')).toBe('order 12345 paid 990000 tiyin');
  });

  it('replaces secret and personal keys at any depth', () => {
    const out = redact({
      userId: 'u1',
      body: {
        phone: '+998901234567',
        Password: 'x',
        first_name: 'Aziza',
        nested: [{ otp: '123456' }],
      },
      headers: { authorization: 'Bearer x', 'set-cookie': 'a=b' },
      code: 'PHONE_MISMATCH',
    });
    expect(out).toEqual({
      userId: 'u1',
      body: {
        phone: REDACTED,
        Password: REDACTED,
        first_name: REDACTED,
        nested: [{ otp: REDACTED }],
      },
      headers: { authorization: REDACTED, 'set-cookie': REDACTED },
      code: 'PHONE_MISMATCH',
    });
  });

  it('handles errors, dates, cycles and deep values without throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ a: 1, self: '[…]' });
    expect(redact(new Error('no user +998901234567'))).toEqual({
      name: 'Error',
      message: 'no user +99890*****67',
    });
    expect(redact(new Date('2026-11-17T00:00:00Z'))).toBe('2026-11-17T00:00:00.000Z');
    let deep: unknown = 'x';
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain('[…]');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
  });
});
