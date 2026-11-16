'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { api, currentSession, forgetSession } from '../lib/api';
import { useI18n } from './i18n-provider';
import { Button, Screen } from './ui';

/**
 * Frame for pages behind sign-in. The real check is the API's: this only
 * avoids showing an empty page to someone who is not signed in.
 */
export function SignedIn({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (currentSession()) setReady(true);
    else router.replace('/login');
  }, [router]);

  const signOut = async () => {
    setBusy(true);
    // Signing out locally even if the request fails: the device must not stay signed in.
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    forgetSession();
    router.replace('/');
  };

  if (!ready) return null;
  return (
    <Screen title={title}>
      {children}
      <Button type="button" variant="secondary" busy={busy} onClick={() => void signOut()}>
        {t('common.signOut')}
      </Button>
    </Screen>
  );
}
