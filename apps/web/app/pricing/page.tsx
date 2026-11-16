'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../components/i18n-provider';
import { ErrorText, LinkButton, Screen } from '../../components/ui';
import { useLoad } from '../../components/use-load';
import { api, currentSession } from '../../lib/api';
import {
  defaultPlan,
  formatSum,
  type Plan,
  type PlansResponse,
  yearlySaving,
} from '../../lib/billing';
import type { MessageKey } from '../../lib/i18n';

/** Plans (UX F7 step B): public, so parents can compare before signing up. */
export default function PricingPage() {
  const { t, locale } = useI18n();
  const load = useCallback(() => api<PlansResponse>('/plans'), []);
  const { data, error } = useLoad(load);
  // Read after mounting: the server render does not know who is signed in.
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(currentSession() !== null), []);
  const preselected = data ? defaultPlan(data.items)?.code : undefined;

  const price = (plan: Plan) =>
    t(plan.interval === 'year' ? 'pricing.perYear' : 'pricing.perMonth', {
      amount: formatSum(plan.price.amountTiyin, locale),
    });

  return (
    <Screen title={t('pricing.title')}>
      <p className="lead">{t('pricing.lead')}</p>
      <ErrorText message={error} />
      {data && (
        <ul className="plans">
          {data.items.map((plan) => {
            const saving = yearlySaving(plan, data.items);
            const target = `/checkout?plan=${encodeURIComponent(plan.code)}`;
            return (
              <li
                key={plan.code}
                className={`plan-card${plan.code === preselected ? ' selected' : ''}`}
              >
                <div className="row">
                  <h2>{t(`plan.${plan.code}` as MessageKey)}</h2>
                  {saving !== null && (
                    <span className="tag saving">{t('pricing.saving', { percent: saving })}</span>
                  )}
                </div>
                <p className="price">{price(plan)}</p>
                <p className="hint">
                  {plan.maxStudents === 1
                    ? t('pricing.oneChild')
                    : t('pricing.upTo', { count: plan.maxStudents })}
                </p>
                <ul className="features">
                  {plan.features.map((f) => (
                    <li key={f}>{t(`feature.${f}` as MessageKey)}</li>
                  ))}
                </ul>
                <LinkButton
                  href={signedIn ? target : '/signup'}
                  variant={plan.code === preselected ? 'primary' : 'secondary'}
                >
                  {t('pricing.choose')}
                </LinkButton>
              </li>
            );
          })}
        </ul>
      )}
      {data && data.trialDays > 0 && <p>{t('pricing.trial', { days: data.trialDays })}</p>}
      {data && !signedIn && (
        <Link href="/signup" className="text-link">
          {t('pricing.signUpFirst')}
        </Link>
      )}
    </Screen>
  );
}
