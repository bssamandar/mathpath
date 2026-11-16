'use client';

import { useI18n } from '../../components/i18n-provider';
import { SignedIn } from '../../components/signed-in';

/** Parent home. The children overview (S10) replaces this text in the next step. */
export default function ParentHomePage() {
  const { t } = useI18n();
  return (
    <SignedIn title={t('parent.title')}>
      <p>{t('parent.next')}</p>
    </SignedIn>
  );
}
