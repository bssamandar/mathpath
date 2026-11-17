'use client';

import { api } from '@mathpath/client';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useCallback, useEffect, useState } from 'react';
import { type Me, StaffShell } from '../../components/staff-shell';
import { Button, ErrorText, Field } from '../../components/ui';
import {
  type AuditEntry,
  type AuditFilters,
  auditQuery,
  emptyAuditFilters,
  metadataText,
  type Page,
  tashkentTime,
} from '../../lib/admin';
import { errorMessage } from '../../lib/editor';
import { t } from '../../lib/i18n';

/** Admin: the append-only audit log, newest first (security plan C-33). */
export default function AuditPage() {
  return (
    <StaffShell>
      {(me) => (
        <Suspense fallback={null}>
          <AuditLog me={me} />
        </Suspense>
      )}
    </StaffShell>
  );
}

const shortId = (id: string | null) => (id ? `${id.slice(0, 8)}…` : '—');

function AuditLog({ me }: { me: Me }) {
  const isAdmin = me.roles.includes('admin');
  const params = useSearchParams();
  const [form, setForm] = useState<AuditFilters>(() => ({
    ...emptyAuditFilters,
    actorId: params.get('actorId') ?? '',
    targetId: params.get('targetId') ?? '',
    action: params.get('action') ?? '',
  }));
  const [applied, setApplied] = useState<AuditFilters>(form);
  const [page, setPage] = useState<Page<AuditEntry> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setBusy(true);
      setError(null);
      try {
        const query = auditQuery(applied, cursor);
        const next = await api<Page<AuditEntry>>(`/admin/audit-log${query ? `?${query}` : ''}`);
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
    [applied],
  );

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) return <p>{t('admin.only')}</p>;

  const apply = (event: FormEvent) => {
    event.preventDefault();
    setPage(null);
    setApplied(form);
  };
  const filterBy = (patch: Partial<AuditFilters>) => {
    const next = { ...emptyAuditFilters, ...patch };
    setForm(next);
    setPage(null);
    setApplied(next);
  };
  const set = (patch: Partial<AuditFilters>) => setForm((current) => ({ ...current, ...patch }));

  return (
    <>
      <h1>{t('audit.title')}</h1>
      <p className="hint">{t('audit.lead')}</p>
      <form className="panel filters" onSubmit={apply}>
        <Field
          label={t('audit.action')}
          hint={t('audit.actionHint')}
          value={form.action}
          maxLength={64}
          onChange={(action) => set({ action })}
        />
        <Field
          label={t('audit.actor')}
          value={form.actorId}
          maxLength={36}
          onChange={(actorId) => set({ actorId })}
        />
        <Field
          label={t('audit.target')}
          value={form.targetId}
          maxLength={36}
          onChange={(targetId) => set({ targetId })}
        />
        <Field
          label={t('audit.from')}
          type="date"
          value={form.fromDay}
          onChange={(fromDay) => set({ fromDay })}
        />
        <Field
          label={t('audit.to')}
          type="date"
          value={form.toDay}
          onChange={(toDay) => set({ toDay })}
        />
        <div className="actions">
          <Button type="submit" busy={busy}>
            {t('audit.apply')}
          </Button>
          <Button variant="secondary" onClick={() => filterBy({})}>
            {t('audit.reset')}
          </Button>
        </div>
      </form>
      <ErrorText message={error} />
      {!page && busy && <p>{t('admin.loading')}</p>}
      {page && page.items.length === 0 && <p>{t('audit.empty')}</p>}
      {page && page.items.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('audit.when')}</th>
                <th scope="col">{t('audit.who')}</th>
                <th scope="col">{t('audit.what')}</th>
                <th scope="col">{t('audit.on')}</th>
                <th scope="col">{t('audit.details')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((entry) => (
                <tr key={entry.id}>
                  <td className="nowrap">{tashkentTime(entry.createdAt)}</td>
                  <td>
                    {entry.actorId ? (
                      <button
                        type="button"
                        className="link mono"
                        title={`${t('audit.filterActor')}: ${entry.actorId}`}
                        onClick={() => filterBy({ actorId: entry.actorId! })}
                      >
                        {shortId(entry.actorId)}
                      </button>
                    ) : (
                      t('audit.system')
                    )}
                    {entry.actorRoles.length > 0 && (
                      <span className="q-bank-meta"> {entry.actorRoles.join(', ')}</span>
                    )}
                  </td>
                  <td className="mono">
                    <button
                      type="button"
                      className="link mono"
                      onClick={() => filterBy({ action: entry.action })}
                    >
                      {entry.action}
                    </button>
                  </td>
                  <td>
                    {entry.targetType ?? '—'}{' '}
                    {entry.targetId && (
                      <button
                        type="button"
                        className="link mono"
                        title={`${t('audit.filterTarget')}: ${entry.targetId}`}
                        onClick={() => filterBy({ targetId: entry.targetId! })}
                      >
                        {shortId(entry.targetId)}
                      </button>
                    )}
                  </td>
                  <td className="details">{metadataText(entry.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page?.nextCursor && (
        <Button variant="secondary" busy={busy} onClick={() => void load(page.nextCursor!)}>
          {t('admin.more')}
        </Button>
      )}
    </>
  );
}
