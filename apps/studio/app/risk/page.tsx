'use client';

import { api } from '@mathpath/client';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { type Me, StaffShell } from '../../components/staff-shell';
import { Badge, Button, ErrorText, Field } from '../../components/ui';
import {
  daysBetween,
  type Page,
  type RiskDecision,
  type RiskReview,
  type RiskStatus,
  tashkentTime,
  tone,
} from '../../lib/admin';
import { errorMessage } from '../../lib/editor';
import { isMessageKey, t } from '../../lib/i18n';

/** Admin: accounts the risk engine stopped, with their signals (UX S17). */
export default function RiskPage() {
  return <StaffShell>{(me) => <RiskQueue me={me} />}</StaffShell>;
}

const STATUSES: RiskStatus[] = ['open', 'restricted', 'banned', 'cleared'];
const label = (key: string) => (isMessageKey(key) ? t(key) : key);

function RiskQueue({ me }: { me: Me }) {
  const isAdmin = me.roles.includes('admin');
  const [status, setStatus] = useState<RiskStatus>('open');
  const [page, setPage] = useState<Page<RiskReview> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      setBusy(true);
      setError(null);
      try {
        const params = new URLSearchParams({ status });
        if (cursor) params.set('cursor', cursor);
        const next = await api<Page<RiskReview>>(`/admin/risk-reviews?${params.toString()}`);
        setPage((current) =>
          cursor && current
            ? { items: [...current.items, ...next.items], nextCursor: next.nextCursor }
            : next,
        );
      } catch (e) {
        setError(errorMessage(t, e));
      } finally {
        setBusy(false);
      }
    },
    [status],
  );

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) return <p>{t('admin.only')}</p>;

  return (
    <>
      <h1>{t('risk.title')}</h1>
      <p className="hint">{t('risk.lead')}</p>
      <div className="tabs" role="group" aria-label={t('risk.tabs')}>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className="pill"
            aria-pressed={s === status}
            onClick={() => {
              setPage(null);
              setStatus(s);
            }}
          >
            {t(`risk.${s}`)}
          </button>
        ))}
      </div>
      <ErrorText message={error} />
      {!page && busy && <p>{t('admin.loading')}</p>}
      {page && page.items.length === 0 && <p>{t('risk.empty')}</p>}
      {page?.items.map((review) => (
        <ReviewCard
          key={review.id}
          review={review}
          onDecided={(updated) =>
            setPage((current) =>
              current
                ? {
                    ...current,
                    items: current.items.map((r) => (r.id === updated.id ? updated : r)),
                  }
                : current,
            )
          }
        />
      ))}
      {page?.nextCursor && (
        <Button variant="secondary" busy={busy} onClick={() => void load(page.nextCursor!)}>
          {t('admin.more')}
        </Button>
      )}
    </>
  );
}

function ReviewCard({
  review,
  onDecided,
}: {
  review: RiskReview;
  onDecided(review: RiskReview): void;
}) {
  const [decision, setDecision] = useState<RiskDecision | null>(null);
  const [notes, setNotes] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const notesProblem = notes.trim().length < 5 ? t('risk.notesProblem') : undefined;
  const headingId = `review-${review.id}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setShown(true);
    if (!decision || notesProblem) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<RiskReview>(`/admin/risk-reviews/${review.id}/decision`, {
        method: 'POST',
        body: { decision, notes: notes.trim() },
      });
      setDone(true);
      onDecided(updated);
    } catch (e) {
      setError(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  const s = review.subject;
  return (
    <section className="review-card" aria-labelledby={headingId}>
      <header className="review-head">
        <div>
          <h2 id={headingId}>
            {s.firstName} <span className="mono">{s.phoneMasked ?? '—'}</span>
          </h2>
          <p className="q-bank-meta">
            {t('risk.age', { days: daysBetween(s.createdAt, new Date()) })}
            {' · '}
            {t('risk.flagged', { date: tashkentTime(review.createdAt) })}
            {' · '}
            <Link href={`/audit?targetId=${review.subjectUserId}`}>{t('users.history')}</Link>
          </p>
          <p>{review.reason}</p>
        </div>
        <div className="q-bank-badges">
          <Badge tone={tone(review.status)}>{t(`risk.${review.status}`)}</Badge>
          <Badge tone={tone(s.status)}>{label(`status.${s.status}`)}</Badge>
        </div>
      </header>

      <h3>{t('risk.signals')}</h3>
      {review.signals.length === 0 ? (
        <p className="hint">{t('risk.noSignals')}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('risk.signalAt')}</th>
                <th scope="col">{t('risk.signalType')}</th>
                <th scope="col">{t('risk.signalScore')}</th>
                <th scope="col">{t('risk.signalRules')}</th>
              </tr>
            </thead>
            <tbody>
              {review.signals.map((signal) => (
                <tr key={`${signal.at}-${signal.type}`}>
                  <td className="nowrap">{tashkentTime(signal.at)}</td>
                  <td className="mono">{signal.type}</td>
                  <td>{signal.scoreDelta}</td>
                  <td className="mono">{signal.names.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {review.status === 'open' && !done ? (
        <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
          <fieldset className="radios">
            <legend>{t('risk.decision')}</legend>
            {(
              [
                ['cleared', 'risk.clear'],
                ['restricted', 'risk.restrict'],
                ['banned', 'risk.ban'],
              ] as const
            ).map(([value, key]) => (
              <label key={value} className="check">
                <input
                  type="radio"
                  name={`decision-${review.id}`}
                  value={value}
                  checked={decision === value}
                  onChange={() => setDecision(value)}
                />
                {t(key)}
              </label>
            ))}
          </fieldset>
          {shown && !decision && <p className="field-error">{t('risk.choose')}</p>}
          <Field
            label={t('risk.notes')}
            multiline
            value={notes}
            error={shown ? notesProblem : undefined}
            onChange={setNotes}
          />
          <ErrorText message={error} />
          <div className="actions">
            <Button
              type="submit"
              busy={busy}
              variant={decision === 'banned' ? 'danger' : 'primary'}
            >
              {t('risk.submit')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="hint">
          {done && <span role="status">{t('risk.done')} </span>}
          {review.decidedAt && t('risk.decided', { date: tashkentTime(review.decidedAt) })}
          {review.notes && <>: “{review.notes}”</>}
        </p>
      )}
    </section>
  );
}
