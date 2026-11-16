'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import {
  type AnswerResponse,
  type Attempt,
  type AttemptResult,
  canCheck,
  percent,
  type QuestionInstance,
  responseFor,
} from '../lib/practice';
import { useI18n } from './i18n-provider';
import { MathText } from './math-text';
import { AnswerArea } from './question';
import { Button, ErrorText } from './ui';

/**
 * A test without hints (mastery test or review, UX S5–S6): one question at a
 * time, answers can be changed until the learner hands it in, then the
 * result. Starting resumes an open attempt, so a reload loses nothing.
 */
export function TestRunner({
  type,
  topicId,
  onResult,
}: {
  type: 'mastery' | 'review';
  topicId: string;
  onResult(result: AttemptResult): void;
}) {
  const { t, locale } = useI18n();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [question, setQuestion] = useState<QuestionInstance | null>(null);
  const [answered, setAnswered] = useState<Set<number>>(new Set());
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = `locale=${encodeURIComponent(locale)}`;
  const started = useRef(false);

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

  const open = async (current: Attempt, position: number) => {
    const item = await api<QuestionInstance>(`/attempts/${current.id}/items/${position}?${q}`);
    const previous: AnswerResponse | undefined = item.previousResponse;
    setQuestion(item);
    setValue(previous && 'value' in previous ? previous.value : '');
    setPicked(previous && 'choiceIds' in previous ? previous.choiceIds : []);
    setConfirming(false);
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run(async () => {
      const begun = await api<Attempt>('/attempts', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { type, topicId },
      });
      setAttempt(begun);
      // Which questions already have an answer, for a learner coming back.
      const done = new Set<number>();
      let first = 0;
      for (let position = 1; position <= begun.itemCount; position++) {
        const item = await api<QuestionInstance>(`/attempts/${begun.id}/items/${position}?${q}`);
        if (item.previousResponse) done.add(position);
        else if (!first) first = position;
      }
      setAnswered(done);
      await open(begun, first || 1);
    });
    // Starts once per mount; the parent remounts (new key) to start again.
  }, []);

  /** Saves the answer (if any) and moves to `next`, or to the finish screen. */
  const saveAndGo = (next: number | 'finish') =>
    run(async () => {
      if (!attempt || !question) return;
      if (canCheck(question, value, picked)) {
        await api(`/attempts/${attempt.id}/items/${question.position}/answer?${q}`, {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: { response: responseFor(question, value, picked) },
        });
        setAnswered((s) => new Set(s).add(question.position));
      }
      if (next === 'finish') setConfirming(true);
      else await open(attempt, next);
    });

  const submit = () =>
    run(async () => {
      if (!attempt) return;
      onResult(await api<AttemptResult>(`/attempts/${attempt.id}/submit?${q}`, { method: 'POST' }));
    });

  if (attempt && confirming) {
    const missing = attempt.itemCount - answered.size;
    return (
      <section className="practice-intro">
        <p className="lead">{t('mastery.confirm')}</p>
        {missing > 0 && <p className="hint">{t('mastery.unanswered', { n: missing })}</p>}
        <ErrorText message={error} />
        <div className="row">
          <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
            {t('mastery.back')}
          </Button>
          <Button type="button" busy={busy} onClick={submit}>
            {t('mastery.submit')}
          </Button>
        </div>
      </section>
    );
  }
  if (!attempt || !question) return <ErrorText message={error} />;

  const n = question.position;
  const last = n === attempt.itemCount;
  return (
    <section className="question">
      <div className="question-head">
        <span>{t('practice.item', { n, total: attempt.itemCount })}</span>
        <progress max={attempt.itemCount} value={answered.size} aria-hidden="true" />
      </div>
      <MathText block text={question.stem} />
      <AnswerArea
        question={question}
        value={value}
        picked={picked}
        disabled={busy}
        onValue={setValue}
        onPicked={setPicked}
      />
      <ErrorText message={error} />
      <div className="row">
        <Button
          type="button"
          variant="secondary"
          disabled={n === 1 || busy}
          onClick={() => saveAndGo(n - 1)}
        >
          {t('lesson.previous')}
        </Button>
        <Button type="button" busy={busy} onClick={() => saveAndGo(last ? 'finish' : n + 1)}>
          {last ? t('mastery.finish') : t('question.next')}
        </Button>
      </div>
    </section>
  );
}

/**
 * UX S6: a big score, "Mastered" or "Almost" (never "Failed"), a review of
 * every question, and the next step the gap router chose (UX F5).
 */
export function TestResult({
  result,
  courseId,
  onPractise,
  onRetry,
}: {
  result: AttemptResult;
  courseId?: string | null;
  onPractise?(): void;
  onRetry?(): void;
}) {
  const { t } = useI18n();
  const score = percent(result.score, result.maxScore);
  const rec = result.recommendation;
  const course = courseId ? `?course=${encodeURIComponent(courseId)}` : '';
  return (
    <section className="mastery-result" role="status">
      <div className={`score-circle ${result.passed ? 'passed' : 'almost'}`}>
        <span className="score-value">{score}%</span>
        <span className="visually-hidden">
          {t('practice.summary', { score: result.score, total: result.maxScore })}
        </span>
      </div>
      <p className="lead">
        {rec?.reason === 'review_passed'
          ? t('review.passed')
          : result.passed
            ? t('mastery.passed')
            : t('mastery.almost')}
      </p>

      {rec?.action === 'prerequisite_review' && rec.topicId && (
        <div className="next-card">
          <p>{t('gap.refresh', { title: rec.topicTitle ?? '' })}</p>
          <Link className="button primary" href={`/review/${rec.topicId}${course}`}>
            {t('gap.start')}
          </Link>
        </div>
      )}
      {rec?.action === 'take_break' && (
        <div className="next-card">
          <p>{t('gap.break')}</p>
        </div>
      )}
      {rec?.action === 'continue' && rec.topicId && rec.reason === 'gap_refreshed' && (
        <div className="next-card">
          <p>{t('gap.backTo', { title: rec.topicTitle ?? '' })}</p>
          <Link className="button primary" href={`/learn/${rec.topicId}${course}`}>
            {t('gap.back')}
          </Link>
        </div>
      )}
      {rec?.action === 'continue' && rec.topicId && rec.reason === 'gap_added_to_path' && (
        <div className="next-card">
          <p>{t('gap.addedToPath', { title: rec.topicTitle ?? '' })}</p>
          <Link className="button primary" href={`/learn/${rec.topicId}${course}`}>
            {t('gap.learnIt')}
          </Link>
        </div>
      )}
      {rec?.action === 'continue' && rec.topicId && !rec.reason && result.passed && (
        <div className="next-card">
          <p>{t('gap.next', { title: rec.topicTitle ?? '' })}</p>
          <Link className="button primary" href={`/learn/${rec.topicId}${course}`}>
            {t('gap.nextTopic')}
          </Link>
        </div>
      )}
      {rec?.action === 'retry_practice' && rec.topicId && !onPractise && (
        <div className="next-card">
          <p>{t('mastery.almost')}</p>
          <Link className="button primary" href={`/learn/${rec.topicId}${course}`}>
            {t('mastery.practiseMore')}
          </Link>
        </div>
      )}

      <ol className="review">
        {result.review.map((item) => (
          <li key={item.position} className={item.correct ? 'right' : 'wrong'}>
            <details>
              <summary>
                <span aria-hidden="true">{item.correct ? '✓' : '✗'}</span>{' '}
                {t(item.correct ? 'mastery.itemRight' : 'mastery.itemWrong', { n: item.position })}
              </summary>
              <MathText block text={item.stem} />
              {!item.correct && (
                <p>
                  {t('question.rightAnswer')} <MathText text={item.correctAnswer} />
                </p>
              )}
              {item.solution && <MathText block text={item.solution} />}
            </details>
          </li>
        ))}
      </ol>
      {!result.passed && (onPractise || onRetry) && (
        <div className="row">
          {onPractise && (
            <Button type="button" onClick={onPractise}>
              {t('mastery.practiseMore')}
            </Button>
          )}
          {onRetry && rec?.action !== 'take_break' && (
            <Button type="button" variant="secondary" onClick={onRetry}>
              {t('mastery.retry')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
