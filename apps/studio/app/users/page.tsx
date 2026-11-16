'use client';

import { api } from '@mathpath/client';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { type Me, StaffShell } from '../../components/staff-shell';
import { Badge, Button, ErrorText, Field } from '../../components/ui';
import {
  type AdminUser,
  changeBody,
  changeProblems,
  draftOf,
  MANAGED_ROLES,
  type Page,
  tashkentTime,
  tone,
  type UserDraft,
} from '../../lib/admin';
import { errorMessage } from '../../lib/editor';
import { isMessageKey, t } from '../../lib/i18n';

/** Admin: find a user and change their status or staff roles (UX §3.4). */
export default function UsersPage() {
  return <StaffShell>{(me) => <Users me={me} />}</StaffShell>;
}

const label = (key: string) => (isMessageKey(key) ? t(key) : key);

function Users({ me }: { me: Me }) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<Page<AdminUser> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  if (!me.roles.includes('admin')) return <p>{t('admin.only')}</p>;

  const load = async (cursor?: string) => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (cursor) params.set('cursor', cursor);
      const page = await api<Page<AdminUser>>(`/admin/users?${params.toString()}`);
      setResult((current) =>
        cursor && current
          ? { items: [...current.items, ...page.items], nextCursor: page.nextCursor }
          : page,
      );
    } catch (e) {
      setError(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setEditing(null);
    if (q.trim().length >= 3) void load();
  };

  const replace = (updated: AdminUser) =>
    setResult((current) =>
      current
        ? { ...current, items: current.items.map((u) => (u.id === updated.id ? updated : u)) }
        : current,
    );

  return (
    <>
      <h1>{t('users.title')}</h1>
      <p className="hint">{t('users.lead')}</p>
      <form className="search-row" onSubmit={submit} role="search">
        <Field
          label={t('users.searchLabel')}
          hint={t('users.searchHint')}
          value={q}
          maxLength={64}
          onChange={setQ}
        />
        <Button type="submit" busy={busy} disabled={q.trim().length < 3}>
          {t('users.search')}
        </Button>
      </form>
      <ErrorText message={error} />

      {result && result.items.length === 0 && <p>{t('users.none')}</p>}
      {result && result.items.length > 0 && (
        <ul className="q-bank">
          {result.items.map((u) => (
            <li key={u.id}>
              <div>
                <strong>
                  {u.firstName} {u.lastName ?? ''}
                </strong>{' '}
                <span className="mono">{u.phoneMasked ?? '—'}</span>
                <p className="q-bank-meta">
                  {u.roles.map((r) => label(`role.${r}`)).join(', ')}
                  {' · '}
                  {t('users.created', { date: tashkentTime(u.createdAt).slice(0, 10) })}
                  {' · '}
                  {t('users.lastLogin', {
                    date: u.lastLoginAt ? tashkentTime(u.lastLoginAt) : t('users.never'),
                  })}
                  {' · '}
                  <Link href={`/audit?targetId=${u.id}`}>{t('users.history')}</Link>
                </p>
              </div>
              <div className="q-bank-badges">
                <Badge tone={tone(u.status)}>{label(`status.${u.status}`)}</Badge>
                {u.riskLevel !== 'normal' && (
                  <Badge tone={tone(u.riskLevel)}>{label(`riskLevel.${u.riskLevel}`)}</Badge>
                )}
                <Badge tone={u.mfaEnabled ? 'published' : 'draft'}>
                  {t(u.mfaEnabled ? 'users.mfaOn' : 'users.mfaOff')}
                </Badge>
                {editing !== u.id && u.id !== me.userId && (
                  <Button variant="secondary" onClick={() => setEditing(u.id)}>
                    {t('users.edit')}
                  </Button>
                )}
              </div>
              {editing === u.id && (
                <div className="q-bank-wide">
                  <UserEditor
                    user={u}
                    myId={me.userId}
                    onSaved={replace}
                    onClose={() => setEditing(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {result?.nextCursor && (
        <Button variant="secondary" busy={busy} onClick={() => void load(result.nextCursor!)}>
          {t('admin.more')}
        </Button>
      )}
    </>
  );
}

function UserEditor({
  user,
  myId,
  onSaved,
  onClose,
}: {
  user: AdminUser;
  myId: string;
  onSaved(user: AdminUser): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<UserDraft>(() => draftOf(user));
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const problems = changeProblems(user, draft, myId);
  const body = changeBody(user, draft);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setShown(true);
    setSaved(null);
    if (!body) {
      setSaved(t('users.nothing'));
      return;
    }
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<AdminUser>(`/admin/users/${user.id}`, { method: 'PATCH', body });
      onSaved(updated);
      setDraft(draftOf(updated));
      setShown(false);
      setSaved(t('users.saved'));
    } catch (e) {
      setError(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  const name = `${user.firstName} ${user.lastName ?? ''}`.trim();
  return (
    <form className="panel stack" onSubmit={(e) => void save(e)} noValidate>
      <h2>{t('users.editTitle', { name })}</h2>
      {problems.form && <p className="error">{problems.form}</p>}
      <div className="field">
        <label htmlFor={`status-${user.id}`}>{t('users.status')}</label>
        <select
          id={`status-${user.id}`}
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as UserDraft['status'] })}
        >
          {(['active', 'locked', 'suspended'] as const).map((s) => (
            <option key={s} value={s}>
              {label(`status.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="checks">
        <legend>{t('users.roles')}</legend>
        <p className="hint">{t('users.rolesHint')}</p>
        {MANAGED_ROLES.map((role) => (
          <label key={role} className="check">
            <input
              type="checkbox"
              checked={draft.roles.includes(role)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  roles: e.target.checked
                    ? [...draft.roles, role]
                    : draft.roles.filter((r) => r !== role),
                })
              }
            />
            {label(`role.${role}`)}
          </label>
        ))}
      </fieldset>
      {shown && problems.roles && <p className="field-error">{problems.roles}</p>}
      <Field
        label={t('users.reason')}
        hint={t('users.reasonHint')}
        multiline
        value={draft.reason}
        error={shown ? problems.reason : undefined}
        onChange={(reason) => setDraft({ ...draft, reason })}
      />
      <p className="hint">{t('users.signOutNote')}</p>
      <ErrorText message={error} />
      <div className="actions">
        <Button type="submit" busy={busy} disabled={Boolean(problems.form)}>
          {t('users.save')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('users.cancel')}
        </Button>
        {saved && (
          <p className="ok" role="status">
            {saved}
          </p>
        )}
      </div>
    </form>
  );
}
