'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '../components/i18n-provider';
import { LinkButton, Screen } from '../components/ui';

/** S1: language and welcome. Parents come first: a child needs a parent account. */
export default function WelcomePage() {
  const { t } = useI18n();
  const [teacherNote, setTeacherNote] = useState(false);
  return (
    <Screen title={t('app.name')}>
      <p className="lead">{t('app.tagline')}</p>
      <div className="stack">
        <LinkButton href="/signup">{t('welcome.parent')}</LinkButton>
        <LinkButton href="/child-login" variant="secondary">
          {t('welcome.student')}
        </LinkButton>
        <button type="button" className="text-link" onClick={() => setTeacherNote(true)}>
          {t('welcome.teacher')}
        </button>
        {teacherNote && <p role="status">{t('welcome.teacherSoon')}</p>}
        <Link href="/login" className="text-link">
          {t('welcome.haveAccount')}
        </Link>
        <Link href="/pricing" className="text-link">
          {t('parent.pricing')}
        </Link>
      </div>
    </Screen>
  );
}
