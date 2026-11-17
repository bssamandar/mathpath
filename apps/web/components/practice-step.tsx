'use client';

import { useCallback, useState } from 'react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import {
  type Attempt,
  type AttemptResult,
  canCheck,
  type Feedback,
  type QuestionInstance,
  responseFor,
  type TopicStatus,
} from '../lib/practice';
import { RewardLine } from './gamification';
import { useI18n } from './i18n-provider';
import { MathText } from './math-text';
import { AnswerArea, FeedbackPanel } from './question';
import { Button, ErrorText } from './ui';
import { useLoad } from './use-load';

/**
 * The practice step (UX F4 step 3, S5): questions easy to hard, each marked
 * at once, a hint after the first mistake and the worked solution after the
 * second. Enough right answers unlock the mastery test.
 */
export function PracticeStep({ topicId, onProgress }: { topicId: string; onProgress?(): void }) {
  const { t, locale } = useI18n();
  const loadStatus = useCallback(
    () => api<TopicStatus>(`/topics/${topicId}/assessment-status`),
    [topicId],
  );
  const { data: status, error: statusError, reload } = useLoad(loadStatus);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [question, setQuestion] = useState<QuestionInstance | null>(null);
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [summary, setSummary] = useState<AttemptResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = `locale=${encodeURIComponent(locale)}`;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(t, caught));
    } finally {
      setBusy(false);
    }
  };

  /** Shows the first unfinished question from `from` on, or finishes the set. */
  const showFrom = async (current: Attempt, from: number) => {
    for (let position = from; position <= current.itemCount; position++) {
      const item = await api<QuestionInstance>(`/attempts/${current.id}/items/${position}?${q}`);
      if (!item.closed) {
        setQuestion(item);
        setValue('');
        setPicked([]);
        setFeedback(null);
        return;
      }
    }
    setSummary(await api<AttemptResult>(`/attempts/${current.id}/submit?${q}`, { method: 'POST' }));
    setQuestion(null);
    reload();
    onProgress?.();
  };

  const start = () =>
    run(async () => {
      const started = await api<Attempt>('/attempts', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { type: 'practice', topicId },
      });
      setSummary(null);
      setAttempt(started);
      await showFrom(started, 1);
    });

  const checkAnswer = () =>
    run(async () => {
      if (!attempt || !question) return;
      const result = await api<Feedback>(
        `/attempts/${attempt.id}/items/${question.position}/answer?${q}`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: { response: responseFor(question, value, picked) },
        },
      );
      setFeedback(result);
    });

  const closed =
    feedback !== null &&
    feedback.accepted &&
    (feedback.correct === true || feedback.triesLeft === 0);

  if (!status) return <ErrorText message={statusError} />;
  if (status.questionCount === 0) {
    return <p className="hint">{t('practice.noQuestions')}</p>;
  }

  if (attempt && question) {
    const n = question.position;
    return (
      <section className="question" aria-live="polite">
        <div className="question-head">
          <span>{t('practice.item', { n, total: attempt.itemCount })}</span>
          <progress max={attempt.itemCount} value={n - 1} aria-hidden="true" />
        </div>
        <MathText block text={question.stem} />
        <AnswerArea
          question={question}
          value={value}
          picked={picked}
          disabled={busy || closed}
          onValue={(v) => {
            setValue(v);
            if (feedback && !feedback.accepted) setFeedback(null);
          }}
          onPicked={setPicked}
        />
        {feedback && <FeedbackPanel feedback={feedback} />}
        <ErrorText message={error} />
        <div className="row">
          {closed ? (
            <Button type="button" busy={busy} onClick={() => run(() => showFrom(attempt, n + 1))}>
              {feedback?.correct ? t('question.next') : t('question.gotIt')}
            </Button>
          ) : (
            <Button
              type="button"
              busy={busy}
              disabled={!canCheck(question, value, picked)}
              onClick={checkAnswer}
            >
              {t('question.check')}
            </Button>
          )}
        </div>
      </section>
    );
  }

  const { correct, required, openAttemptId } = status.practice;
  return (
    <section className="practice-intro">
      {summary && (
        <p className="lead" role="status">
          {t('practice.summary', { score: summary.score, total: summary.maxScore })}
        </p>
      )}
      {summary && <RewardLine reward={summary.reward} />}
      <p>
        {status.mastery.unlocked
          ? t('practice.unlocked')
          : t('practice.progress', { correct, required })}
      </p>
      <progress max={required} value={Math.min(correct, required)} aria-hidden="true" />
      {status.dailyExercisesLeft !== null && (
        <p className="hint">{t('practice.dailyLeft', { n: status.dailyExercisesLeft })}</p>
      )}
      <ErrorText message={error} />
      <Button
        type="button"
        busy={busy}
        disabled={status.dailyExercisesLeft === 0 && !openAttemptId}
        onClick={start}
      >
        {openAttemptId
          ? t('practice.continue')
          : summary
            ? t('practice.again')
            : t('practice.start')}
      </Button>
    </section>
  );
}
