import { describe, expect, it } from 'vitest';
import { formatPhone, isCompletePhone, phoneDigits, toE164 } from './phone';

describe('phone helpers', () => {
  it('keeps nine digits and drops a pasted country code', () => {
    expect(phoneDigits('90 123-45-67')).toBe('901234567');
    expect(phoneDigits('+998 90 123 45 67')).toBe('901234567');
    expect(phoneDigits('9012345678999')).toBe('901234567');
  });

  it('groups digits as they are typed', () => {
    expect(formatPhone('9')).toBe('9');
    expect(formatPhone('90123')).toBe('90 123');
    expect(formatPhone('901234567')).toBe('90 123 45 67');
  });

  it('builds the E.164 number only from complete input', () => {
    expect(isCompletePhone('90123456')).toBe(false);
    expect(isCompletePhone('901234567')).toBe(true);
    expect(toE164('901234567')).toBe('+998901234567');
  });
});
