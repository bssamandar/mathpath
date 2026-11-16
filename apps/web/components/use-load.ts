'use client';

import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../lib/errors';
import { useI18n } from './i18n-provider';

/**
 * Loads data for a screen and keeps the friendly error. `reload` runs the
 * loader again, for a "try again" button.
 */
export function useLoad<T>(load: () => Promise<T>) {
  const { t } = useI18n();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const reload = useCallback(() => {
    let alive = true;
    setError(null);
    load()
      .then((value) => alive && setData(value))
      .catch((caught: unknown) => {
        if (!alive) return;
        setError(errorMessage(t, caught));
        setErrorCode((caught as { code?: string }).code ?? null);
      });
    return () => {
      alive = false;
    };
  }, [load, t]);

  useEffect(() => reload(), [reload]);
  return { data, error, errorCode, reload };
}
