'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useI18n } from '../../components/i18n-provider';
import { SignedIn } from '../../components/signed-in';
import { ErrorText } from '../../components/ui';
import { useLoad } from '../../components/use-load';
import { api } from '../../lib/api';
import type { Track } from '../../lib/lesson';

/** Student home: the courses to choose from (UX S3). The learning path comes with 6.4. */
export default function StudentHomePage() {
  const { t, locale } = useI18n();
  const load = useCallback(
    () => api<{ items: Track[] }>(`/tracks?locale=${encodeURIComponent(locale)}`),
    [locale],
  );
  const { data, error } = useLoad(load);
  const courses = data?.items.flatMap((track) => track.courses) ?? [];
  return (
    <SignedIn title={t('student.title')}>
      <ErrorText message={error} />
      {data && courses.length === 0 && <p>{t('student.empty')}</p>}
      {data?.items.map((track) => (
        <section key={track.id} className="list-section">
          <h2>{track.title}</h2>
          <ul className="cards">
            {track.courses.map((course) => (
              <li key={course.id}>
                <Link className="card" href={`/course/${course.id}`}>
                  {course.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </SignedIn>
  );
}
