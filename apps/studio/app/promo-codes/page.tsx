'use client';

import { api } from '@mathpath/client';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { type Me, StaffShell } from '../../components/staff-shell';
import { Badge, Button, ErrorText, Field } from '../../components/ui';
import { errorMessage } from '../../lib/editor';
import { t } from '../../lib/i18n';
import {
  type NewPromo,
  promoInput,
  type PromoCode,
  promoProblems,
  starterPromo,
  tashkentDay,
} from '../../lib/promo';

interface Plan {
  code: string;
}

/** Promo codes for admins (UX §3.5 admin console): list, create and stop. */
export default function PromoCodesPage() {
  return <StaffShell>{(me) => <PromoCodes me={me} />}</StaffShell>;
}

function PromoCodes({ me }: { me: Me }) {
  const isAdmin = me.roles.includes('admin');
  const [items, setItems] = useState<PromoCode[] | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<NewPromo>(() => starterPromo(new Date()));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  const load = useCallback(() => {
    api<{ items: PromoCode[] }>('/admin/promo-codes')
      .then((res) => setItems(res.items))
      .catch((e: unknown) => setError(errorMessage(t, e)));
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    load();
    api<{ items: Plan[] }>('/plans')
      .then((res) => setPlans(res.items))
      .catch(() => setPlans([]));
  }, [isAdmin, load]);

  if (!isAdmin) return <p>{t('promo.adminOnly')}</p>;

  const problems = promoProblems(form);
  const set = (patch: Partial<NewPromo>) => {
    setForm((current) => ({ ...current, ...patch }));
    setSaved(null);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setShowProblems(true);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<PromoCode>('/admin/promo-codes', {
        method: 'POST',
        body: promoInput(form),
      });
      setSaved(t('promo.created', { code: created.code }));
      setForm(starterPromo(new Date()));
      setShowProblems(false);
      load();
    } catch (e) {
      setError(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (id: string) => {
    setError(null);
    try {
      await api(`/admin/promo-codes/${id}/deactivate`, { method: 'POST' });
      load();
    } catch (e) {
      setError(errorMessage(t, e));
    }
  };

  const shown = (key: keyof NewPromo) => (showProblems ? problems[key] : undefined);

  return (
    <>
      <h1>{t('promo.title')}</h1>
      <p className="hint">{t('promo.lead')}</p>
      <ErrorText message={error} />

      <form className="panel stack" onSubmit={(e) => void create(e)} noValidate>
        <h2>{t('promo.new')}</h2>
        <div className="q-grid">
          <Field
            label={t('promo.code')}
            hint={t('promo.codeHint')}
            value={form.code}
            maxLength={32}
            error={shown('code')}
            onChange={(code) => set({ code })}
          />
          <div className="field">
            <label htmlFor="promo-type">{t('promo.type')}</label>
            <select
              id="promo-type"
              value={form.discountType}
              onChange={(e) => set({ discountType: e.target.value as NewPromo['discountType'] })}
            >
              <option value="percent">{t('promo.percent')}</option>
              <option value="fixed">{t('promo.fixed')}</option>
            </select>
          </div>
          <Field
            label={t('promo.value')}
            hint={t(
              form.discountType === 'percent' ? 'promo.valueHintPercent' : 'promo.valueHintFixed',
            )}
            inputMode="numeric"
            value={form.value}
            error={shown('value')}
            onChange={(value) => set({ value })}
          />
          <Field
            label={t('promo.max')}
            inputMode="numeric"
            value={form.maxRedemptions}
            error={shown('maxRedemptions')}
            onChange={(maxRedemptions) => set({ maxRedemptions })}
          />
          <Field
            label={t('promo.perUser')}
            inputMode="numeric"
            value={form.perUserLimit}
            error={shown('perUserLimit')}
            onChange={(perUserLimit) => set({ perUserLimit })}
          />
          <Field
            label={t('promo.from')}
            type="date"
            hint={t('promo.datesHint')}
            value={form.validFrom}
            error={shown('validFrom')}
            onChange={(validFrom) => set({ validFrom })}
          />
          <Field
            label={t('promo.to')}
            type="date"
            value={form.validTo}
            error={shown('validTo')}
            onChange={(validTo) => set({ validTo })}
          />
        </div>
        <fieldset className="checks">
          <legend>{t('promo.plans')}</legend>
          <p className="hint">{t('promo.plansHint')}</p>
          {plans.map((plan) => (
            <label key={plan.code} className="check">
              <input
                type="checkbox"
                checked={form.planCodes.includes(plan.code)}
                onChange={(e) =>
                  set({
                    planCodes: e.target.checked
                      ? [...form.planCodes, plan.code]
                      : form.planCodes.filter((c) => c !== plan.code),
                  })
                }
              />
              {plan.code}
            </label>
          ))}
        </fieldset>
        <div className="actions">
          <Button type="submit" busy={busy}>
            {t('promo.create')}
          </Button>
          {saved && (
            <p className="ok" role="status">
              {saved}
            </p>
          )}
        </div>
      </form>

      <h2>{t('promo.title')}</h2>
      {items && items.length === 0 && <p>{t('promo.empty')}</p>}
      {items && items.length > 0 && (
        <ul className="q-bank">
          {items.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{p.code}</strong>{' '}
                {p.discountType === 'percent'
                  ? `−${p.value}%`
                  : `−${(p.value / 100).toLocaleString('uz-UZ')} so‘m`}
                <p className="q-bank-meta">
                  {t('promo.window', {
                    from: tashkentDay(p.validFrom),
                    to: tashkentDay(p.validTo),
                  })}
                  {' · '}
                  {p.planCodes?.join(', ') ?? t('promo.allPlans')}
                  {' · '}
                  {p.maxRedemptions === null
                    ? t('promo.used', { used: p.redemptions })
                    : t('promo.usedOf', { used: p.redemptions, max: p.maxRedemptions })}
                </p>
              </div>
              <div className="q-bank-badges">
                <Badge tone={p.isActive ? 'published' : 'archived'}>
                  {t(p.isActive ? 'promo.active' : 'promo.inactive')}
                </Badge>
                {p.isActive && (
                  <Button variant="secondary" onClick={() => void deactivate(p.id)}>
                    {t('promo.deactivate')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
