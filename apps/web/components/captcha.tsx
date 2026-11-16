'use client';

import { useEffect, useRef } from 'react';
import { Button } from './ui';
import { useI18n } from './i18n-provider';

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface Turnstile {
  render(
    element: HTMLElement,
    options: { sitekey: string; callback(token: string): void; language?: string },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;

/** Loads the Turnstile script once. CSP allows it via 'strict-dynamic' (middleware.ts). */
function loadTurnstile(): Promise<Turnstile> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile'));
    script.onerror = () => {
      loading = null;
      reject(new Error('turnstile failed to load'));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * Shown when the API answers 428 (risk engine, security plan §6.2). Calls
 * `onToken` with a token to send as `captchaToken` on the retried request.
 *
 * Without a site key (local development) it offers the API's dev token, which
 * the API refuses in production.
 */
export function Captcha({ onToken }: { onToken(token: string): void }) {
  const { t, locale } = useI18n();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!SITE_KEY || !box.current) return;
    let widget: string | null = null;
    let cancelled = false;
    const element = box.current;
    void loadTurnstile()
      .then((turnstile) => {
        if (cancelled) return;
        widget = turnstile.render(element, {
          sitekey: SITE_KEY,
          callback: onToken,
          language: locale === 'uz-Latn' ? 'uz' : locale,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (widget) window.turnstile?.remove(widget);
    };
  }, [locale, onToken]);

  return (
    <div className="captcha">
      <p>{t('captcha.title')}</p>
      {SITE_KEY ? (
        <div ref={box} />
      ) : (
        <Button type="button" variant="secondary" onClick={() => onToken('dev-pass')}>
          dev: I am not a robot
        </Button>
      )}
    </div>
  );
}
