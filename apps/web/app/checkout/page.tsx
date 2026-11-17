'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useMemo, useState } from 'react';
import { useI18n } from '../../components/i18n-provider';
import { TextInput } from '../../components/inputs';
import { SignedIn } from '../../components/signed-in';
import { Button, ErrorText, LinkButton } from '../../components/ui';
import { useLoad } from '../../components/use-load';
import { useRequest } from '../../components/use-request';
import { api } from '../../lib/api';
import {
  activeSubscriptions,
  type Child,
  defaultPlan,
  formatDate,
  formatSum,
  type Money,
  type PlansResponse,
  type PromoCheck,
  type ProviderCode,
  rememberOrder,
  type Subscription,
} from '../../lib/billing';
import type { MessageKey } from '../../lib/i18n';

const PROVIDER_NAMES: Record<ProviderCode, string> = { payme: 'Payme', click: 'Click' };

interface Loaded {
  plans: PlansResponse;
  children: Child[];
  subscriptions: Subscription[];
  trialAvailable: boolean;
}

/** UX F7: children, optional promo code, provider, then the provider's page. */
export default function CheckoutPage() {
  const { t } = useI18n();
  return (
    <SignedIn title={t('checkout.title')}>
      <Suspense>
        <Checkout />
      </Suspense>
    </SignedIn>
  );
}

function Checkout() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const requested = useSearchParams().get('plan');
  const load = useCallback(async (): Promise<Loaded> => {
    const [plans, children, subs] = await Promise.all([
      api<PlansResponse>('/plans'),
      api<{ items: Child[] }>('/children'),
      api<{ items: Subscription[]; trialAvailable: boolean }>('/subscriptions'),
    ]);
    return {
      plans,
      children: children.items,
      subscriptions: subs.items,
      trialAvailable: subs.trialAvailable,
    };
  }, []);
  const { data, error } = useLoad(load);

  const [chosen, setChosen] = useState<string[]>([]);
  const [provider, setProvider] = useState<ProviderCode | null>(null);
  const [promoCode, setPromoCode] = useState('');
  const [promo, setPromo] = useState<{ code: string; amount: Money; discount: Money } | null>(null);
  const [promoNote, setPromoNote] = useState<string | null>(null);
  // One key per visit to this page: a double tap on "Pay" makes one order (API C-idempotency).
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const pay = useRequest();
  const promoRequest = useRequest();
  const trial = useRequest();

  if (error) return <ErrorText message={error} />;
  if (!data) return null;

  const plan = data.plans.items.find((p) => p.code === requested) ?? defaultPlan(data.plans.items);
  if (!plan) return <p>{t('checkout.closed')}</p>;
  const providers = data.plans.providers;
  const selectedProvider = provider ?? providers[0] ?? null;
  const coveredUntil = new Map<string, string>();
  for (const sub of activeSubscriptions(data.subscriptions)) {
    for (const id of sub.studentIds) {
      const known = coveredUntil.get(id);
      if (!known || known < sub.currentPeriodEnd) coveredUntil.set(id, sub.currentPeriodEnd);
    }
  }
  const total = promo?.amount.amountTiyin ?? plan.price.amountTiyin;

  const toggle = (id: string) => {
    setChosen((current) =>
      current.includes(id)
        ? current.filter((c) => c !== id)
        : current.length < plan.maxStudents
          ? [...current, id]
          : current,
    );
  };

  const applyPromo = () =>
    promoRequest.run(async () => {
      setPromoNote(null);
      const check = await api<PromoCheck>('/promo-codes/validate', {
        method: 'POST',
        body: { code: promoCode, planCode: plan.code },
      });
      if (check.valid) {
        setPromo({ code: promoCode, amount: check.amount, discount: check.discount });
      } else {
        setPromo(null);
        setPromoNote(t(`promo.${check.reason}` as MessageKey));
      }
    });

  const submit = () =>
    pay.run(async () => {
      if (chosen.length === 0) {
        pay.setError(t('checkout.pickChild'));
        return;
      }
      const order = await api<{ orderId: string; redirectUrl: string }>('/checkout', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: {
          planCode: plan.code,
          provider: selectedProvider,
          studentIds: chosen,
          ...(promo ? { promoCode: promo.code } : {}),
          returnUrl: `${window.location.origin}/payment/return`,
        },
      });
      rememberOrder(order.orderId);
      window.location.assign(order.redirectUrl);
    });

  const startTrial = () =>
    trial.run(async () => {
      if (chosen.length === 0) {
        trial.setError(t('checkout.pickChild'));
        return;
      }
      await api('/trials', { method: 'POST', body: { studentIds: chosen } });
      router.push('/parent/plan');
    });

  return (
    <div className="stack">
      <div className="plan-card selected">
        <h2>{t(`plan.${plan.code}` as MessageKey)}</h2>
        <p className="price">
          {t(plan.interval === 'year' ? 'pricing.perYear' : 'pricing.perMonth', {
            amount: formatSum(plan.price.amountTiyin, locale),
          })}
        </p>
        <LinkButton href="/pricing" variant="secondary">
          {t('checkout.otherPlans')}
        </LinkButton>
      </div>

      <fieldset className="choices-group">
        <legend>{t('checkout.children')}</legend>
        {data.children.length === 0 ? (
          <p>{t('checkout.noChildren')}</p>
        ) : (
          <>
            <p className="hint">
              {plan.maxStudents === 1
                ? t('pricing.oneChild')
                : t('checkout.childrenHint', { count: plan.maxStudents })}
            </p>
            {data.children.map((child) => {
              const until = coveredUntil.get(child.id);
              return (
                <label key={child.id} className="check">
                  <input
                    type="checkbox"
                    checked={chosen.includes(child.id)}
                    disabled={!chosen.includes(child.id) && chosen.length >= plan.maxStudents}
                    onChange={() => toggle(child.id)}
                  />
                  <span>
                    {child.firstName}
                    {until && (
                      <span className="hint">
                        {' · '}
                        {t('checkout.covered', { date: formatDate(until, locale) })}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </>
        )}
      </fieldset>

      <details className="promo">
        <summary>{t('checkout.promoToggle')}</summary>
        <div className="promo-row">
          <TextInput
            label={t('checkout.promo')}
            value={promoCode}
            onChange={(value) => {
              setPromoCode(value);
              setPromo(null);
              setPromoNote(null);
            }}
            maxLength={32}
            required={false}
          />
          <Button
            type="button"
            variant="secondary"
            busy={promoRequest.busy}
            disabled={promoCode.trim() === ''}
            onClick={() => void applyPromo()}
          >
            {t('checkout.apply')}
          </Button>
        </div>
        <p role="status" className="hint">
          {promo
            ? t('checkout.promoApplied', { amount: formatSum(promo.discount.amountTiyin, locale) })
            : (promoNote ?? '')}
        </p>
        <ErrorText message={promoRequest.error} />
      </details>

      {providers.length === 0 ? (
        <p>{t('checkout.closed')}</p>
      ) : (
        <fieldset className="choices-group">
          <legend>{t('checkout.provider')}</legend>
          <div className="languages">
            {providers.map((code) => (
              <button
                key={code}
                type="button"
                className="pill"
                aria-pressed={code === selectedProvider}
                onClick={() => setProvider(code)}
              >
                {PROVIDER_NAMES[code]}
              </button>
            ))}
          </div>
          <p className="hint">{t('checkout.cardNote')}</p>
        </fieldset>
      )}

      <p className="price">{t('checkout.total', { amount: formatSum(total, locale) })}</p>
      <ErrorText message={pay.error} />
      <Button
        type="button"
        busy={pay.busy}
        disabled={providers.length === 0 || data.children.length === 0}
        onClick={() => void submit()}
      >
        {t('checkout.pay')}
      </Button>

      {data.trialAvailable && data.plans.trialDays > 0 && data.children.length > 0 && (
        <section className="next-card">
          <h2>{t('checkout.trialTitle')}</h2>
          <p>{t('pricing.trial', { days: data.plans.trialDays })}</p>
          <ErrorText message={trial.error} />
          <Button
            type="button"
            variant="secondary"
            busy={trial.busy}
            onClick={() => void startTrial()}
          >
            {t('checkout.trialButton', { days: data.plans.trialDays })}
          </Button>
        </section>
      )}
    </div>
  );
}
