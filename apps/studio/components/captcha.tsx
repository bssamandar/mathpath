'use client';

import { useEffect, useRef } from 'react';
import { Button } from './ui';

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface Turnstile {
  render(element: HTMLElement, options: { sitekey: string; callback(token: string): void }): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;

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
 * Shown when the API answers 428 (risk engine). Same behaviour as the web
 * app: Turnstile with a site key, the API's dev token without one.
 */
export function Captcha({ onToken }: { onToken(token: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!SITE_KEY || !box.current) return;
    let widget: string | null = null;
    let cancelled = false;
    const element = box.current;
    void loadTurnstile()
      .then((turnstile) => {
        if (!cancelled)
          widget = turnstile.render(element, { sitekey: SITE_KEY, callback: onToken });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (widget) window.turnstile?.remove(widget);
    };
  }, [onToken]);
  return SITE_KEY ? (
    <div ref={box} />
  ) : (
    <Button variant="secondary" onClick={() => onToken('dev-pass')}>
      dev: I am not a robot
    </Button>
  );
}
