import { describe, expect, it } from 'vitest';
import { en } from './en';
import { hasErrorMessage, isLocale, LOCALES, translator } from './index';
import { ru } from './ru';
import { uz } from './uz';

describe('i18n', () => {
  it('has every key, with the same placeholders, in every language', () => {
    for (const dictionary of [uz, ru]) {
      expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(en)) {
        const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
        expect(placeholders(dictionary[key as keyof typeof en]), key).toEqual(placeholders(text));
      }
    }
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    const t = translator('en');
    expect(t('otp.resendIn', { seconds: 42 })).toBe('New code in 42 s');
    expect(t('otp.resendIn')).toBe('New code in {seconds} s');
    expect(translator('uz-Latn')('login.submit')).toBe('Kirish');
  });

  it('recognises supported locales and known error codes', () => {
    expect(LOCALES.every(isLocale)).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(hasErrorMessage('OTP_INVALID')).toBe(true);
    expect(hasErrorMessage('SOMETHING_NEW')).toBe(false);
  });
});
