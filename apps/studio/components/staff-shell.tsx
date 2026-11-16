'use client';

import { api, currentSession, forgetSession } from '@mathpath/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { t } from '../lib/i18n';

const STAFF = ['author', 'reviewer', 'admin'];

export interface Me {
  userId: string;
  roles: string[];
}

/**
 * Frame of every signed-in studio page. Sends anyone who is not signed in as
 * staff to /login. The API checks every call anyway; this only saves a
 * screen full of 401s.
 */
export function StaffShell({ children }: { children: (me: Me) => ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    const session = currentSession();
    if (!session || !session.roles.some((r) => STAFF.includes(r))) router.replace('/login');
    else setMe(session);
  }, [router]);

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    forgetSession();
    router.replace('/login');
  };

  if (!me) return null;
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          {t('app.title')}
        </Link>
        <nav>
          <Link href="/">{t('nav.tree')}</Link>
          {me.roles.includes('admin') && (
            <>
              <Link href="/users">{t('nav.users')}</Link>
              <Link href="/risk">{t('nav.risk')}</Link>
              <Link href="/audit">{t('nav.audit')}</Link>
              <Link href="/promo-codes">{t('nav.promo')}</Link>
            </>
          )}
          <button type="button" className="link" onClick={() => void signOut()}>
            {t('nav.signOut')}
          </button>
        </nav>
      </header>
      <main className="page">{children(me)}</main>
    </>
  );
}
