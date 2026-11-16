'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useI18n } from '../../components/i18n-provider';
import { SignedIn } from '../../components/signed-in';
import { ErrorText } from '../../components/ui';
import { useLoad } from '../../components/use-load';
import { api } from '../../lib/api';
import type { Track } from '../../lib/lesson';
import type { DueReview } from '../../lib/practice';

/** Student home (UX S3): reviews that are due first, then the courses to choose from. */
export default function StudentHomePage() {
  const { t, locale } = useI18n();
  const load = useCallback(
    () => api<{ items: Track[] }>(`/tracks?locale=${encodeURIComponent(locale)}`),
    [locale],
  );
  const { data, error } = useLoad(load);
  const loadDue = useCallback(
    () => api<{ items: DueReview[] }>(`/me/reviews/due?locale=${encodeURIComponent(locale)}`),
    [locale],
  );
  // Reviews are a bonus on this screen: if they fail to load, the courses still show.
  const { data: due } = useLoad(loadDue);
  const courses = data?.items.flatMap((track) => track.courses) ?? [];
  return (
    <SignedIn title={t('student.title')}>
      <ErrorText message={error} />
      {due && due.items.length > 0 && (
        <section className="list-section">
          <h2>{t('student.dueTitle')}</h2>
          <p className="hint">{t('student.dueHint')}</p>
          <ul className="cards">
            {due.items.map((review) => (
              <li key={review.topicId}>
                <Link className="card" href={`/review/${review.topicId}`}>
                  <span>{review.title}</span>
                  <span className="tag needs_review">{t('review.title')}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
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
