'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../components/i18n-provider';
import { SignedIn } from '../../../components/signed-in';
import { Button, ErrorText } from '../../../components/ui';
import { useLoad } from '../../../components/use-load';
import { VideoPlayer } from '../../../components/video-player';
import { api } from '../../../lib/api';
import { type Lesson, type LessonStep, resumeIndex } from '../../../lib/lesson';

/** The lesson player (UX S4–S5): one step at a time, with a stepper on top. */
export default function LearnPage({ params }: { params: Promise<{ topicId: string }> }) {
  const { topicId } = use(params);
  return (
    <Suspense>
      <LessonView topicId={topicId} />
    </Suspense>
  );
}

function LessonView({ topicId }: { topicId: string }) {
  const { t, locale } = useI18n();
  const courseId = useSearchParams().get('course');
  const back = courseId ? `/course/${encodeURIComponent(courseId)}` : '/student';
  const load = useCallback(
    () => api<Lesson>(`/topics/${topicId}/lesson?locale=${encodeURIComponent(locale)}`),
    [topicId, locale],
  );
  const { data: lesson, error } = useLoad(load);
  const [current, setCurrent] = useState<number | null>(null);
  const [seen, setSeen] = useState<Set<number>>(new Set());
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (lesson && current === null) setCurrent(resumeIndex(lesson.steps));
  }, [lesson, current]);

  const step = lesson && current !== null ? lesson.steps[current] : undefined;
  const markSeen = (index: number) => setSeen((s) => new Set(s).add(index));
  const goTo = (index: number) => {
    if (current !== null) markSeen(current);
    setCurrent(index);
    window.scrollTo({ top: 0 });
  };

  return (
    <SignedIn title={lesson?.title ?? ''}>
      <Link className="text-link" href={back}>
        ← {t('lesson.toCourse')}
      </Link>
      <ErrorText message={error} />
      {lesson && current !== null && (
        <>
          <ol
            className="stepper"
            aria-label={t('lesson.step', { n: current + 1, total: lesson.steps.length })}
          >
            {lesson.steps.map((s, i) => (
              <li
                key={s.index}
                className={i === current ? 'current' : s.completed || seen.has(i) ? 'done' : ''}
                aria-current={i === current ? 'step' : undefined}
              >
                <span className="visually-hidden">{t(`step.${s.type}`)}</span>
              </li>
            ))}
          </ol>
          <p className="hint">
            {t('lesson.step', { n: current + 1, total: lesson.steps.length })} ·{' '}
            {step && t(`step.${step.type}`)}
          </p>

          {finished ? (
            <section className="done" role="status">
              <p className="lead">{t('lesson.done')}</p>
            </section>
          ) : (
            step && <StepView key={step.index} step={step} onDone={() => markSeen(current)} />
          )}

          <div className="row lesson-nav">
            <Button
              type="button"
              variant="secondary"
              disabled={current === 0 && !finished}
              onClick={() => (finished ? setFinished(false) : goTo(current - 1))}
            >
              {t('lesson.previous')}
            </Button>
            {finished ? (
              <Link className="button primary" href={back}>
                {t('lesson.toCourse')}
              </Link>
            ) : (
              <Button
                type="button"
                onClick={() => {
                  if (current < lesson.steps.length - 1) goTo(current + 1);
                  else {
                    markSeen(current);
                    setFinished(true);
                  }
                }}
              >
                {t('lesson.next')}
              </Button>
            )}
          </div>
        </>
      )}
    </SignedIn>
  );
}

/** One step. Activities, practice and tests get their screens with the question engine (6.4). */
function StepView({ step, onDone }: { step: LessonStep; onDone(): void }) {
  const { t } = useI18n();
  if (step.type === 'video' && step.mediaId) {
    return <VideoPlayer mediaId={step.mediaId} onEnded={onDone} />;
  }
  return (
    <section className="step-placeholder">
      {step.prompt && <p className="lead">{step.prompt}</p>}
      <p className="hint">{t('lesson.comingSoon')}</p>
    </section>
  );
}
