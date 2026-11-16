'use client';

import { useCallback, useState } from 'react';
import { errorMessage, needsCaptcha } from '../lib/errors';
import { useI18n } from './i18n-provider';

/**
 * Busy, error and CAPTCHA state for one form. `run` calls the API; when the
 * API asks for a CAPTCHA, the form shows it and `retryWithCaptcha` sends the
 * same request again with the token.
 */
export function useRequest() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captchaFor, setCaptchaFor] = useState<((token: string) => Promise<void>) | null>(null);

  const run = useCallback(
    async (action: (captchaToken?: string) => Promise<void>, captchaToken?: string) => {
      setBusy(true);
      setError(null);
      try {
        await action(captchaToken);
        setCaptchaFor(null);
      } catch (caught) {
        if (needsCaptcha(caught)) {
          // A function in state must be wrapped, or React would call it as an updater.
          setCaptchaFor(() => (token: string) => run(action, token));
        } else {
          setError(errorMessage(t, caught));
        }
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  return { busy, error, setError, run, captchaFor };
}
