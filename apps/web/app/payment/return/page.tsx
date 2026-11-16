'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useI18n } from '../../../components/i18n-provider';
import { SignedIn } from '../../../components/signed-in';
import { LinkButton } from '../../../components/ui';
import { api, ApiError } from '../../../lib/api';
import { formatDate, lastOrder, type Order } from '../../../lib/billing';

const POLL_MS = 3000;
/** UX F7: after a minute the callback may still come; the parent is told so. */
const GIVE_UP_MS = 60_000;

type View = 'confirming' | 'paid' | 'failed' | 'expired' | 'slow' | 'unknown';

/** UX F7 step G: polls the order until the provider's callback has arrived. */
export default function PaymentReturnPage() {
  const { t } = useI18n();
  return (
    <SignedIn title={t('payment.title')}>
      <Suspense>
        <PaymentReturn />
      </Suspense>
    </SignedIn>
  );
}

function PaymentReturn() {
  const { t, locale } = useI18n();
  const fromQuery = useSearchParams().get('order');
  const [view, setView] = useState<View>('confirming');
  const [order, setOrder] = useState<Order | null>(null);

  useEffect(() => {
    const orderId = fromQuery ?? lastOrder();
    if (!orderId) {
      setView('unknown');
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async () => {
      try {
        const current = await api<Order>(`/orders/${encodeURIComponent(orderId)}`);
        if (!alive) return;
        setOrder(current);
        if (current.status === 'paid') return setView('paid');
        if (current.status === 'cancelled') return setView('failed');
        if (current.status === 'expired') return setView('expired');
      } catch (error) {
        if (!alive) return;
        if (error instanceof ApiError && error.status === 404) return setView('unknown');
        // A network blip: keep polling until the time is up.
      }
      if (Date.now() - started >= GIVE_UP_MS) return setView('slow');
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [fromQuery]);

  const until = order?.subscription?.currentPeriodEnd;
  return (
    <div className="stack">
      <p role="status" aria-live="polite" className={`payment-state ${view}`}>
        {view === 'confirming' && t('payment.confirming')}
        {view === 'paid' && t('payment.paid', { date: until ? formatDate(until, locale) : '' })}
        {view === 'failed' && t('payment.failed')}
        {view === 'expired' && t('payment.expired')}
        {view === 'slow' && t('payment.slow')}
        {view === 'unknown' && t('payment.unknown')}
      </p>
      {(view === 'failed' || view === 'expired') && (
        <LinkButton href="/pricing">{t('payment.tryAgain')}</LinkButton>
      )}
      {view !== 'confirming' && (
        <LinkButton href="/parent/plan" variant={view === 'paid' ? 'primary' : 'secondary'}>
          {t('payment.toPlan')}
        </LinkButton>
      )}
    </div>
  );
}
