'use client';

import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { LOCALE_NAMES, LOCALES } from '../lib/i18n';
import { useI18n } from './i18n-provider';

/** Page frame: language switcher on top, one column, readable width (UX §2). */
export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="screen">
      <LanguageSwitcher />
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <nav className="languages" aria-label={t('language.label')}>
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          className="pill"
          aria-pressed={code === locale}
          onClick={() => setLocale(code)}
        >
          {LOCALE_NAMES[code]}
        </button>
      ))}
    </nav>
  );
}

export function Button({
  variant = 'primary',
  busy = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      className={`button ${variant}`}
      disabled={busy || props.disabled}
      aria-busy={busy}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = 'primary',
  children,
}: {
  href: string;
  variant?: 'primary' | 'secondary';
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`button ${variant}`}>
      {children}
    </Link>
  );
}

/** An error announced to screen readers as soon as it appears (WCAG, UX §7). */
export function ErrorText({ message }: { message: string | null }) {
  return (
    <p className="error" role="alert" aria-live="assertive">
      {message ?? ''}
    </p>
  );
}
