import { ApiError } from './api';
import { hasErrorMessage, type MessageKey, type Translate } from './i18n';

/** A friendly message for a failed request (UX §6: never "Error 500"). */
export function errorMessage(t: Translate, error: unknown): string {
  if (!(error instanceof ApiError)) return t('error.generic');
  if (error.code === 'OFFLINE') return t('error.offline');
  if (error.code === 'TOO_MANY_REQUESTS') {
    return t('error.tooMany', { minutes: Math.max(1, Math.ceil((error.retryAfterS ?? 60) / 60)) });
  }
  if (hasErrorMessage(error.code)) return t(`error.${error.code}` as MessageKey);
  return t('error.generic');
}

/** True when the API asks for a CAPTCHA before it will continue (security plan §6.2). */
export function needsCaptcha(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'CAPTCHA_REQUIRED' || error.code === 'CAPTCHA_INTERACTIVE_REQUIRED')
  );
}
