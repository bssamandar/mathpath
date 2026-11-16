'use client';

import Link from 'next/link';
import { use, useCallback } from 'react';
import { useI18n } from '../../../components/i18n-provider';
import { SignedIn } from '../../../components/signed-in';
import { ErrorText } from '../../../components/ui';
import { useLoad } from '../../../components/use-load';
import { api } from '../../../lib/api';
import type { CourseTree } from '../../../lib/lesson';

/** One course: chapters and their topics; paid topics show as locked (UX S3). */
export default function CoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = use(params);
  const { t, locale } = useI18n();
  const load = useCallback(
    () => api<CourseTree>(`/courses/${courseId}?locale=${encodeURIComponent(locale)}`),
    [courseId, locale],
  );
  const { data, error } = useLoad(load);
  return (
    <SignedIn title={data?.title ?? ''}>
      <Link className="text-link" href="/student">
        ← {t('course.allCourses')}
      </Link>
      <ErrorText message={error} />
      {data?.chapters.map((chapter) => (
        <section key={chapter.id} className="list-section">
          <h2>{chapter.title}</h2>
          <ol className="cards">
            {chapter.topics.map((topic) => (
              <li key={topic.id}>
                {topic.locked ? (
                  <span className="card locked" aria-disabled>
                    <span>{topic.title}</span>
                    <span className="tag">🔒 {t('course.locked')}</span>
                  </span>
                ) : (
                  <Link className="card" href={`/learn/${topic.id}?course=${courseId}`}>
                    <span>{topic.title}</span>
                    {topic.isFree && <span className="tag">{t('course.free')}</span>}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </SignedIn>
  );
}
