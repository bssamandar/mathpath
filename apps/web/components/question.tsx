'use client';

import type { Feedback, PadKey, QuestionInstance } from '../lib/practice';
import { pressKey } from '../lib/practice';
import { useI18n } from './i18n-provider';
import { MathText } from './math-text';

const LETTERS = 'ABCDEFGH';
const PAD: PadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'back'];

/**
 * The answer area of the question screen (UX S5): option cards for choices,
 * or a big input with our own number pad, because phone keyboards differ
 * and a fraction bar or minus is hard to find on some of them.
 */
export function AnswerArea({
  question,
  value,
  picked,
  disabled,
  onValue,
  onPicked,
}: {
  question: QuestionInstance;
  value: string;
  picked: string[];
  disabled: boolean;
  onValue(value: string): void;
  onPicked(picked: string[]): void;
}) {
  const { t } = useI18n();
  if (question.choices && (question.inputHint === 'single' || question.inputHint === 'multiple')) {
    const multiple = question.inputHint === 'multiple';
    return (
      <fieldset className="choices" disabled={disabled}>
        <legend className="visually-hidden">
          {multiple ? t('question.pickAll') : t('question.pickOne')}
        </legend>
        {multiple && <p className="hint">{t('question.pickAll')}</p>}
        {question.choices.map((choice, i) => {
          const on = picked.includes(choice.id);
          return (
            <label key={choice.id} className={`choice${on ? ' picked' : ''}`}>
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={`q${question.position}`}
                checked={on}
                onChange={() =>
                  onPicked(
                    multiple
                      ? on
                        ? picked.filter((id) => id !== choice.id)
                        : [...picked, choice.id]
                      : [choice.id],
                  )
                }
              />
              <span className="letter" aria-hidden="true">
                {LETTERS[i]}
              </span>
              <MathText text={choice.label} />
            </label>
          );
        })}
      </fieldset>
    );
  }

  const press = (key: PadKey) => onValue(pressKey(value, key));
  return (
    <div className="number-answer">
      <label className="visually-hidden" htmlFor={`answer-${question.position}`}>
        {t('question.yourAnswer')}
      </label>
      <input
        id={`answer-${question.position}`}
        className="answer-input"
        inputMode="none"
        autoComplete="off"
        value={value}
        disabled={disabled}
        placeholder={question.inputHint === 'fraction' ? '3/4' : '0'}
        // A hardware keyboard still works: keep only characters the pad offers.
        onChange={(e) => onValue(e.target.value.replace(/[^\d,./\-−]/g, '').slice(0, 24))}
      />
      <div className="pad" role="group" aria-label={t('question.pad')}>
        {PAD.map((key) => (
          <button
            key={key}
            type="button"
            className="pad-key"
            disabled={disabled}
            onClick={() => press(key)}
            aria-label={key === 'back' ? t('question.erase') : undefined}
          >
            {key === 'back' ? '⌫' : key}
          </button>
        ))}
        <button type="button" className="pad-key" disabled={disabled} onClick={() => press('-')}>
          −
        </button>
        <button
          type="button"
          className="pad-key"
          disabled={disabled}
          onClick={() => press('/')}
          aria-label={t('question.fractionBar')}
        >
          a/b
        </button>
      </div>
    </div>
  );
}

/** The panel under the question after "Check" in practice (UX S5). */
export function FeedbackPanel({ feedback }: { feedback: Feedback }) {
  const { t } = useI18n();
  if (!feedback.accepted) {
    return (
      <div className="feedback attention" role="status">
        <p>{t('question.unreadable')}</p>
      </div>
    );
  }
  if (feedback.correct) {
    return (
      <div className="feedback success" role="status">
        <p className="feedback-title">✓ {t('question.correct')}</p>
      </div>
    );
  }
  const reason =
    feedback.reason === 'not_simplified'
      ? t('question.simplify')
      : feedback.reason === 'form'
        ? t('question.otherForm')
        : null;
  return (
    <div className={`feedback ${feedback.solution ? 'neutral' : 'attention'}`} role="status">
      <p className="feedback-title">
        {feedback.solution ? t('question.solution') : t('question.notQuite')}
      </p>
      {reason && <p>{reason}</p>}
      {feedback.hint && <MathText block text={feedback.hint} />}
      {feedback.correctAnswer && (
        <p>
          {t('question.rightAnswer')} <MathText text={feedback.correctAnswer} />
        </p>
      )}
      {feedback.solution && <MathText block text={feedback.solution} />}
      {!feedback.solution && (feedback.triesLeft ?? 0) > 0 && (
        <p className="hint">{t('question.tryAgain')}</p>
      )}
    </div>
  );
}
