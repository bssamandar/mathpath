'use client';

import { useCallback, useState } from 'react';
import { useI18n } from '../../../components/i18n-provider';
import { SignedIn } from '../../../components/signed-in';
import { Button, ErrorText, LinkButton } from '../../../components/ui';
import { useLoad } from '../../../components/use-load';
import { useRequest } from '../../../components/use-request';
import { api } from '../../../lib/api';
import { type Child, formatDate, type Subscription } from '../../../lib/billing';
import type { MessageKey } from '../../../lib/i18n';

/** UX S12 and F8: current plans, who they cover, and turning off renewal. */
export default function PlanPage() {
  const { t, locale } = useI18n();
  const load = useCallback(async () => {
    const [subs, children] = await Promise.all([
      api<{ items: Subscription[]; trialAvailable: boolean }>('/subscriptions'),
      api<{ items: Child[] }>('/children'),
    ]);
    return { subs, children: children.items };
  }, []);
  const { data, error, reload } = useLoad(load);
  const [confirming, setConfirming] = useState<string | null>(null);
  const cancel = useRequest();

  const names = (ids: string[]) =>
    ids
      .map((id) => data?.children.find((c) => c.id === id)?.firstName)
      .filter(Boolean)
      .join(', ');

  const turnOff = (id: string) =>
    cancel.run(async () => {
      await api(`/subscriptions/${id}/cancel`, { method: 'POST' });
      setConfirming(null);
      reload();
    });

  const current = data?.subs.items.filter((s) => s.status === 'active' || s.status === 'trialing');
  const earlier = data?.subs.items.filter((s) => s.status !== 'active' && s.status !== 'trialing');

  const card = (sub: Subscription, live: boolean) => {
    const date = formatDate(sub.currentPeriodEnd, locale);
    return (
      <li key={sub.id} className="plan-card">
        <div className="row">
          <h2>{t(`plan.${sub.planCode}` as MessageKey)}</h2>
          <span className={`tag status-${sub.status}`}>
            {t(`subs.status.${sub.status}` as MessageKey)}
          </span>
        </div>
        {names(sub.studentIds) && <p>{t('subs.children', { names: names(sub.studentIds) })}</p>}
        <p>
          {live && sub.cancelAtPeriodEnd ? t('subs.endsOn', { date }) : t('subs.until', { date })}
        </p>
        {live && !sub.cancelAtPeriodEnd && confirming !== sub.id && (
          <button type="button" className="text-link" onClick={() => setConfirming(sub.id)}>
            {t('subs.cancel')}
          </button>
        )}
        {confirming === sub.id && (
          <div className="next-card">
            <p>{t('subs.cancelConfirm', { date })}</p>
            <ErrorText message={cancel.error} />
            <div className="row">
              <Button type="button" busy={cancel.busy} onClick={() => void turnOff(sub.id)}>
                {t('subs.cancelYes')}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setConfirming(null)}>
                {t('subs.cancelNo')}
              </Button>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <SignedIn title={t('subs.title')}>
      <ErrorText message={error} />
      {current && current.length === 0 && <p>{t('subs.none')}</p>}
      {current && current.length > 0 && (
        <ul className="plans">{current.map((s) => card(s, true))}</ul>
      )}
      <LinkButton href="/pricing" variant={current?.length ? 'secondary' : 'primary'}>
        {t('subs.choosePlan')}
      </LinkButton>
      {earlier && earlier.length > 0 && (
        <section className="list-section">
          <h2>{t('subs.history')}</h2>
          <ul className="plans">{earlier.map((s) => card(s, false))}</ul>
        </section>
      )}
    </SignedIn>
  );
}
