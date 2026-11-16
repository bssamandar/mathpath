'use client';

import { useRouter } from 'next/navigation';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { type Locale, LOCALE_COOKIE, type Translate, translator } from '../lib/i18n';

interface I18n {
  locale: Locale;
  t: Translate;
  setLocale(locale: Locale): void;
}

const I18nContext = createContext<I18n | null>(null);

/** Makes the server-chosen locale available to client components. */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const router = useRouter();
  const value = useMemo<I18n>(
    () => ({
      locale,
      t: translator(locale),
      setLocale(next) {
        // One year; SameSite=Lax is enough for a preference that is not a secret.
        document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
        router.refresh();
      },
    }),
    [locale, router],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
