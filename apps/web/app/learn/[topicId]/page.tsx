'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../components/i18n-provider';
import { SignedIn } from '../../../components/signed-in';
import { MasteryStep } from '../../../components/mastery-step';
import { PracticeStep } from '../../../components/practice-step';
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
  /**
   * Videos and activities have no questions, so leaving them (or a video
   * ending) records them as done; practice and tests finish through their
   * attempts. A failure here is not worth interrupting the learner for.
   */
  const completeStep = (s: LessonStep | undefined) => {
    if (!s || s.completed || (s.type !== 'video' && s.type !== 'activity')) return;
    api(`/topics/${topicId}/steps/${s.index}/complete`, { method: 'POST' }).catch(() => {});
  };
  const goTo = (index: number) => {
    if (current !== null) {
      markSeen(current);
      completeStep(lesson?.steps[current]);
    }
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
            step && (
              <StepView
                key={step.index}
                step={step}
                topicId={topicId}
                courseId={courseId}
                onDone={() => {
                  markSeen(current);
                  completeStep(step);
                }}
                onPractise={() => {
                  const practice = lesson.steps.findIndex((s) => s.type === 'practice');
                  if (practice !== -1) goTo(practice);
                }}
              />
            )
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
                    completeStep(step);
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

/** One step. Interactive activities and reviews get their screens in later steps. */
function StepView({
  step,
  topicId,
  courseId,
  onDone,
  onPractise,
}: {
  step: LessonStep;
  topicId: string;
  courseId: string | null;
  onDone(): void;
  onPractise(): void;
}) {
  const { t } = useI18n();
  if (step.type === 'video' && step.mediaId) {
    return <VideoPlayer mediaId={step.mediaId} onEnded={onDone} />;
  }
  if (step.type === 'practice') {
    return (
      <>
        {step.prompt && <p className="lead">{step.prompt}</p>}
        <PracticeStep topicId={topicId} onProgress={onDone} />
      </>
    );
  }
  if (step.type === 'mastery_test') {
    return <MasteryStep topicId={topicId} courseId={courseId} onPractise={onPractise} />;
  }
  return (
    <section className="step-placeholder">
      {step.prompt && <p className="lead">{step.prompt}</p>}
      <p className="hint">{t('lesson.comingSoon')}</p>
    </section>
  );
}
