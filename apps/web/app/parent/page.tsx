'use client';

import { useI18n } from '../../components/i18n-provider';
import { SignedIn } from '../../components/signed-in';
import { LinkButton } from '../../components/ui';

/** Parent home. The children overview (S10) replaces most of this with the dashboards step. */
export default function ParentHomePage() {
  const { t } = useI18n();
  return (
    <SignedIn title={t('parent.title')}>
      <p>{t('parent.next')}</p>
      <div className="stack">
        <LinkButton href="/parent/plan">{t('parent.plan')}</LinkButton>
        <LinkButton href="/pricing" variant="secondary">
          {t('parent.pricing')}
        </LinkButton>
      </div>
    </SignedIn>
  );
}
