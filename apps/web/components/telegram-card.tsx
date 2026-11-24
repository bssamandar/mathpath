'use client';

import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { useI18n } from './i18n-provider';

/**
 * Sign-in codes by Telegram (temporary, while SMS is off): the bot username is
 * inlined at build time. Without it nothing is shown and the pages keep the
 * SMS wording.
 */
export const TELEGRAM_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT ?? '';

export const telegramEnabled = /^[A-Za-z]\w{3,31}bot$/i.test(TELEGRAM_BOT);

export function telegramLink(bot = TELEGRAM_BOT): string {
  return `https://t.me/${bot}?start=web`;
}

/** One SVG path of the dark modules: crisp at any size, and fine with the CSP. */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let d = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
    }
  }
  return { size: count + 8, d };
}

/** QR code and button that open the bot, with the steps to link the phone. */
export function TelegramCard({ purpose }: { purpose: 'signup' | 'login' }) {
  const { t } = useI18n();
  const link = telegramLink();
  const qr = useMemo(() => qrPath(link), [link]);
  if (!telegramEnabled) return null;

  return (
    <section className="telegram-card" aria-labelledby="telegram-title">
      <svg
        className="telegram-qr"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        role="img"
        aria-label={t('telegram.qrAlt')}
        shapeRendering="crispEdges"
      >
        <rect width={qr.size} height={qr.size} fill="#ffffff" />
        <path d={qr.d} fill="#000000" />
      </svg>
      <div className="stack telegram-text">
        <h2 id="telegram-title">{t('telegram.title')}</h2>
        <p className="hint">
          {t(purpose === 'signup' ? 'telegram.stepsSignup' : 'telegram.stepsLogin')}
        </p>
        <a className="button" href={link} target="_blank" rel="noopener noreferrer">
          {t('telegram.open', { bot: `@${TELEGRAM_BOT}` })}
        </a>
      </div>
    </section>
  );
}
