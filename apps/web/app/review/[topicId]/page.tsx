'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useState } from 'react';
import { useI18n } from '../../../components/i18n-provider';
import { SignedIn } from '../../../components/signed-in';
import { TestResult, TestRunner } from '../../../components/test-runner';
import { Button } from '../../../components/ui';
import type { AttemptResult } from '../../../lib/practice';

/**
 * A review without hints (UX F5): the short check the gap router asked for,
 * or a spaced review of a mastered topic. The API decides which one it is.
 */
export default function ReviewPage({ params }: { params: Promise<{ topicId: string }> }) {
  const { topicId } = use(params);
  return (
    <Suspense>
      <ReviewView topicId={topicId} />
    </Suspense>
  );
}

function ReviewView({ topicId }: { topicId: string }) {
  const { t } = useI18n();
  const courseId = useSearchParams().get('course');
  const back = courseId ? `/course/${encodeURIComponent(courseId)}` : '/student';
  const [started, setStarted] = useState(false);
  const [result, setResult] = useState<AttemptResult | null>(null);

  return (
    <SignedIn title={t('review.title')}>
      <Link className="text-link" href={back}>
        ← {t('review.toCourse')}
      </Link>
      {result ? (
        <>
          <TestResult result={result} courseId={courseId} />
          <div className="row">
            <Link className="button secondary" href={back}>
              {t('review.toCourse')}
            </Link>
          </div>
        </>
      ) : started ? (
        <TestRunner type="review" topicId={topicId} onResult={setResult} />
      ) : (
        <section className="practice-intro">
          <p className="lead">{t('review.intro')}</p>
          <Button type="button" onClick={() => setStarted(true)}>
            {t('review.start')}
          </Button>
        </section>
      )}
    </SignedIn>
  );
}
