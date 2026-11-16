'use client';

import { useCallback, useState } from 'react';
import { api } from '../lib/api';
import { type AttemptResult, percent, type TopicStatus } from '../lib/practice';
import { useI18n } from './i18n-provider';
import { TestResult, TestRunner } from './test-runner';
import { Button, ErrorText } from './ui';
import { useLoad } from './use-load';

/**
 * The mastery test step (UX F4 step 4, S6). It unlocks after enough right
 * answers in practice; a failed test leads to the gap router's next step.
 */
export function MasteryStep({
  topicId,
  courseId,
  onPractise,
}: {
  topicId: string;
  courseId?: string | null;
  onPractise?(): void;
}) {
  const { t } = useI18n();
  const loadStatus = useCallback(
    () => api<TopicStatus>(`/topics/${topicId}/assessment-status`),
    [topicId],
  );
  const { data: status, error: statusError, reload } = useLoad(loadStatus);
  const [running, setRunning] = useState(0);
  const [result, setResult] = useState<AttemptResult | null>(null);

  if (result) {
    return (
      <TestResult
        result={result}
        courseId={courseId}
        onPractise={onPractise}
        onRetry={() => {
          setResult(null);
          setRunning((n) => n + 1);
        }}
      />
    );
  }
  if (running > 0) {
    return (
      <TestRunner
        key={running}
        type="mastery"
        topicId={topicId}
        onResult={(r) => {
          setResult(r);
          reload();
        }}
      />
    );
  }
  if (!status) return <ErrorText message={statusError} />;

  const { correct, required } = status.practice;
  if (!status.mastery.unlocked) {
    return (
      <section className="practice-intro">
        <p>{t('mastery.locked', { correct, required })}</p>
        <progress max={required} value={Math.min(correct, required)} aria-hidden="true" />
        {onPractise && (
          <Button type="button" variant="secondary" onClick={onPractise}>
            {t('mastery.toPractice')}
          </Button>
        )}
      </section>
    );
  }
  const best = status.mastery.best;
  return (
    <section className="practice-intro">
      <p>{t('mastery.intro')}</p>
      {best && (
        <p className="hint">
          {t('mastery.best', { percent: percent(best.score, best.maxScore) })}
          {best.passed ? ' ⭐' : ''}
        </p>
      )}
      <Button type="button" onClick={() => setRunning(1)}>
        {status.mastery.openAttemptId ? t('practice.continue') : t('mastery.start')}
      </Button>
    </section>
  );
}
