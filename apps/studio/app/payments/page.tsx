'use client';

import { api } from '@mathpath/client';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { type Me, StaffShell } from '../../components/staff-shell';
import { Badge, Button, ErrorText, Field } from '../../components/ui';
import { tashkentTime } from '../../lib/admin';
import { errorMessage } from '../../lib/editor';
import { isMessageKey, t } from '../../lib/i18n';
import {
  type AdminPayment,
  canRefund,
  formatSum,
  liveRefund,
  reasonProblem,
  type Refund,
  refundBody,
} from '../../lib/payments';

/** Admin: find a family's payments and refund one (UX §3.4; security plan §9). */
export default function PaymentsPage() {
  return <StaffShell>{(me) => <Payments me={me} />}</StaffShell>;
}

const label = (key: string) => (isMessageKey(key) ? t(key) : key);

const tone = (status: string) =>
  status === 'paid' || status === 'succeeded'
    ? 'published'
    : status === 'failed' || status === 'refunded'
      ? 'rejected'
      : 'draft';

function Payments({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<AdminPayment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);

  if (!me.roles.includes('admin')) return <p>{t('admin.only')}</p>;

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const page = await api<{ items: AdminPayment[] }>(
        `/admin/payments?${new URLSearchParams({ q: q.trim() }).toString()}`,
      );
      setItems(page.items);
    } catch (e) {
      setError(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setRefunding(null);
    if (q.trim().length >= 3) void load();
  };

  const added = (paymentId: string, refund: Refund) =>
    setItems((current) =>
      current
        ? current.map((p) =>
            p.id === paymentId
              ? {
                  ...p,
                  status: refund.status === 'succeeded' ? 'refunded' : p.status,
                  refunds: [refund, ...p.refunds],
                }
              : p,
          )
        : current,
    );

  return (
    <>
      <h1>{t('payments.title')}</h1>
      <p className="hint">{t('payments.lead')}</p>
      <form className="search-row" onSubmit={submit} role="search">
        <Field
          label={t('payments.searchLabel')}
          hint={t('payments.searchHint')}
          value={q}
          maxLength={64}
          onChange={setQ}
        />
        <Button type="submit" busy={busy} disabled={q.trim().length < 3}>
          {t('users.search')}
        </Button>
      </form>
      <ErrorText message={error} />

      {items && items.length === 0 && <p>{t('payments.none')}</p>}
      {items && items.length > 0 && (
        <ul className="q-bank">
          {items.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{formatSum(p.amount)}</strong>{' '}
                <span>
                  {label(`provider.${p.provider}`)} · {p.planCode}
                </span>
                <p className="q-bank-meta">
                  {p.owner.firstName} <span className="mono">{p.owner.phoneMasked ?? '—'}</span>
                  {' · '}
                  {t('payments.paidAt', {
                    date: tashkentTime(p.paidAt ?? p.createdAt),
                  })}
                  {' · '}
                  <span className="mono">{p.providerTxnId}</span>
                  {' · '}
                  <Link href={`/audit?targetId=${p.id}`}>{t('users.history')}</Link>
                </p>
                {p.refunds.map((r) => (
                  <p key={r.refundId} className="q-bank-meta">
                    {t('payments.refundLine', {
                      status: label(`refund.${r.status}`),
                      date: tashkentTime(r.completedAt ?? r.createdAt),
                      reason: r.reason,
                    })}
                    {r.failure && <> · {r.failure}</>}
                  </p>
                ))}
                {liveRefund(p)?.status === 'requested' && p.provider === 'payme' && (
                  <p className="hint">{t('payments.paymeCabinet', { txn: p.providerTxnId })}</p>
                )}
              </div>
              <div className="q-bank-badges">
                <Badge tone={tone(p.status)}>{label(`paymentStatus.${p.status}`)}</Badge>
                {canRefund(p) && refunding !== p.id && (
                  <Button variant="secondary" onClick={() => setRefunding(p.id)}>
                    {t('payments.refund')}
                  </Button>
                )}
              </div>
              {refunding === p.id && (
                <div className="q-bank-wide">
                  <RefundForm
                    payment={p}
                    onDone={(refund) => added(p.id, refund)}
                    onClose={() => setRefunding(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function RefundForm({
  payment,
  onDone,
  onClose,
}: {
  payment: AdminPayment;
  onDone(refund: Refund): void;
  onClose(): void;
}) {
  const [reason, setReason] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Refund | null>(null);
  // One key per form: a second tap or a retry after a lost answer cannot refund twice.
  const [key] = useState(() => crypto.randomUUID());
  const problem = reasonProblem(reason);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setShown(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const refund = await api<Refund>(`/admin/payments/${payment.id}/refunds`, {
        method: 'POST',
        body: refundBody(payment, reason),
        headers: { 'Idempotency-Key': key },
      });
      setResult(refund);
      onDone(refund);
    } catch (e) {
      setError(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="panel stack" role="status">
        <p className={result.status === 'failed' ? 'error' : 'ok'}>
          {t(`payments.result.${result.status}`, { failure: result.failure ?? '' })}
        </p>
        {result.status === 'requested' && (
          <p className="hint">{t('payments.paymeCabinet', { txn: payment.providerTxnId })}</p>
        )}
        <Button variant="secondary" onClick={onClose}>
          {t('payments.close')}
        </Button>
      </div>
    );
  }

  return (
    <form className="panel stack" onSubmit={(e) => void send(e)} noValidate>
      <h2>{t('payments.refundTitle', { amount: formatSum(payment.amount) })}</h2>
      <p className="hint">
        {t(payment.provider === 'click' ? 'payments.clickNote' : 'payments.paymeNote')}
      </p>
      <Field
        label={t('users.reason')}
        hint={t('payments.reasonHint')}
        multiline
        value={reason}
        error={shown && problem ? t(`payments.reason.${problem}`) : undefined}
        onChange={setReason}
      />
      <ErrorText message={error} />
      <div className="actions">
        <Button type="submit" busy={busy}>
          {t('payments.confirm')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('users.cancel')}
        </Button>
      </div>
    </form>
  );
}
