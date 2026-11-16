'use client';

import { useI18n } from '../../components/i18n-provider';
import { SignedIn } from '../../components/signed-in';

/** Student home. The learning path (S3) replaces this in step 6.3. */
export default function StudentHomePage() {
  const { t } = useI18n();
  return <SignedIn title={t('student.title')}>{null}</SignedIn>;
}
