import { describe, expect, it } from 'vitest';
import { ApiError, homeFor } from './api';
import { errorMessage, needsCaptcha } from './errors';
import { translator } from './i18n';

describe('homeFor', () => {
  it('sends students to their home and everyone else to the parent home', () => {
    expect(homeFor(['student'])).toBe('/student');
    expect(homeFor(['parent'])).toBe('/parent');
  });
});

describe('errorMessage', () => {
  const t = translator('en');
  it('explains known problems and hides unknown ones (UX §6)', () => {
    expect(errorMessage(t, new ApiError(401, 'OTP_INVALID'))).toBe('The code is not correct.');
    expect(errorMessage(t, new ApiError(500, 'INTERNAL'))).toBe('Something went wrong. Try again.');
    expect(errorMessage(t, new Error('boom'))).toBe('Something went wrong. Try again.');
    expect(errorMessage(t, new ApiError(0, 'OFFLINE'))).toMatch(/internet/);
    expect(errorMessage(t, new ApiError(429, 'TOO_MANY_REQUESTS', 150))).toBe(
      'Too many attempts. Try again in 3 min.',
    );
  });

  it('recognises CAPTCHA requests', () => {
    expect(needsCaptcha(new ApiError(428, 'CAPTCHA_REQUIRED'))).toBe(true);
    expect(needsCaptcha(new ApiError(428, 'CAPTCHA_INTERACTIVE_REQUIRED'))).toBe(true);
    expect(needsCaptcha(new ApiError(401, 'OTP_INVALID'))).toBe(false);
  });
});
