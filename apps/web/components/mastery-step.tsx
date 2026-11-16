'use client';

import { useCallback, useState } from 'react';
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
  type TopicStatus,
} from '../lib/practice';
import { useI18n } from './i18n-provider';
import { MathText } from './math-text';
import { AnswerArea } from './question';
import { Button, ErrorText } from './ui';
import { useLoad } from './use-load';

/**
 * The mastery test (UX F4 step 4, S6): no hints, answers can be changed
 * until the end, and the result comes with a review of every question.
 * The test unlocks after enough right answers in practice.
 */
export function MasteryStep({ topicId, onPractise }: { topicId: string; onPractise?(): void }) {
  const { t, locale } = useI18n();
  const loadStatus = useCallback(
    () => api<TopicStatus>(`/topics/${topicId}/assessment-status`),
    [topicId],
  );
  const { data: status, error: statusError, reload } = useLoad(loadStatus);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [question, setQuestion] = useState<QuestionInstance | null>(null);
  const [answered, setAnswered] = useState<Set<number>>(new Set());
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [confirming, setConfirming] = useState(false);
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

  const open = async (current: Attempt, position: number) => {
    const item = await api<QuestionInstance>(`/attempts/${current.id}/items/${position}?${q}`);
    const previous: AnswerResponse | undefined = item.previousResponse;
    setQuestion(item);
    setValue(previous && 'value' in previous ? previous.value : '');
    setPicked(previous && 'choiceIds' in previous ? previous.choiceIds : []);
    setConfirming(false);
  };

  const start = () =>
    run(async () => {
      const started = await api<Attempt>('/attempts', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { type: 'mastery', topicId },
      });
      setAttempt(started);
      setResult(null);
      setAnswered(new Set());
      // Which questions already have an answer, for a learner coming back.
      const done = new Set<number>();
      let first = 0;
      for (let position = 1; position <= started.itemCount; position++) {
        const item = await api<QuestionInstance>(`/attempts/${started.id}/items/${position}?${q}`);
        if (item.previousResponse) done.add(position);
        else if (!first) first = position;
      }
      setAnswered(done);
      await open(started, first || 1);
    });

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
      setResult(
        await api<AttemptResult>(`/attempts/${attempt.id}/submit?${q}`, { method: 'POST' }),
      );
      setAttempt(null);
      setQuestion(null);
      reload();
    });

  if (result)
    return <MasteryResult result={result} onPractise={onPractise} onRetry={start} busy={busy} />;
  if (!status) return <ErrorText message={statusError} />;

  if (attempt && question && !confirming) {
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
      <ErrorText message={error} />
      <Button type="button" busy={busy} onClick={start}>
        {status.mastery.openAttemptId ? t('practice.continue') : t('mastery.start')}
      </Button>
    </section>
  );
}

/** UX S6: a big score, "Mastered" or "Almost" (never "Failed"), and a review. */
function MasteryResult({
  result,
  onPractise,
  onRetry,
  busy,
}: {
  result: AttemptResult;
  onPractise?(): void;
  onRetry(): void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const score = percent(result.score, result.maxScore);
  return (
    <section className="mastery-result" role="status">
      <div className={`score-circle ${result.passed ? 'passed' : 'almost'}`}>
        <span className="score-value">{score}%</span>
        <span className="visually-hidden">
          {t('practice.summary', { score: result.score, total: result.maxScore })}
        </span>
      </div>
      <p className="lead">{result.passed ? t('mastery.passed') : t('mastery.almost')}</p>
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
      {!result.passed && (
        <div className="row">
          {onPractise && (
            <Button type="button" onClick={onPractise}>
              {t('mastery.practiseMore')}
            </Button>
          )}
          <Button type="button" variant="secondary" busy={busy} onClick={onRetry}>
            {t('mastery.retry')}
          </Button>
        </div>
      )}
    </section>
  );
}
