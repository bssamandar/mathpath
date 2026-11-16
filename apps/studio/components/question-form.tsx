'use client';

import { useId } from 'react';
import type { LocalisedText } from '../lib/editor';
import { t } from '../lib/i18n';
import {
  type AnswerKind,
  answerKindsFor,
  FRACTION_FORMS,
  formProblems,
  moveItem,
  type QuestionDraft,
  QUESTION_TYPES,
  type QuestionType,
  removeItem,
  type VariableKind,
  type VariableRow,
  withAnswerKind,
  withType,
} from '../lib/questions';
import { LocalisedFields } from './step-editor';
import { Button, Field } from './ui';

const VARIABLE_KINDS: readonly VariableKind[] = ['int', 'choice', 'expr'];

/**
 * The question template form (UX S15, ADR-0011). `problems` holds messages
 * by form section (`variables`, `answer`, …) from the preview or a refused
 * submit, so each one shows next to the part it is about.
 */
export function QuestionForm({
  draft,
  disabled,
  problems,
  onChange,
}: {
  draft: QuestionDraft;
  disabled: boolean;
  problems: Record<string, string[]>;
  onChange(draft: QuestionDraft): void;
}) {
  const local = formProblems(draft);
  const set = (part: Partial<QuestionDraft>) => onChange({ ...draft, ...part });
  const typeId = useId();
  const kindId = useId();

  return (
    <fieldset className="question-form" disabled={disabled}>
      <section className="q-section">
        <h2>{t('question.settings')}</h2>
        <div className="q-grid">
          <div className="field">
            <label htmlFor={typeId}>{t('question.type')}</label>
            <select
              id={typeId}
              value={draft.type}
              onChange={(e) => onChange(withType(draft, e.target.value as QuestionType))}
            >
              {QUESTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`qtype.${type}`)}
                </option>
              ))}
            </select>
          </div>
          <Field
            label={t('question.difficulty')}
            type="number"
            min={1}
            max={5}
            value={String(draft.difficulty)}
            onChange={(v) => set({ difficulty: Math.min(5, Math.max(1, Number(v) || 1)) })}
          />
          <Field
            label={t('question.skills')}
            hint={t('question.skillsHint')}
            value={draft.skills}
            maxLength={400}
            onChange={(skills) => set({ skills })}
          />
          <Field
            label={t('question.externalRef')}
            hint={t('question.externalRefHint')}
            value={draft.externalRef}
            maxLength={64}
            onChange={(externalRef) => set({ externalRef })}
          />
        </div>
      </section>

      <section className="q-section">
        <h2>{t('question.variables')}</h2>
        <p className="hint">{t('question.variablesHint')}</p>
        <Problems list={problems.variables} />
        <ol className="q-list">
          {draft.variables.map((row, i) => (
            <VariableEditor
              key={i}
              row={row}
              index={i}
              error={local[`variables/${i}/name`] as 'name' | 'duplicate' | undefined}
              onChange={(next) =>
                set({ variables: draft.variables.map((r, j) => (j === i ? next : r)) })
              }
              onRemove={() => set({ variables: removeItem(draft.variables, i) })}
              onMove={(to) => set({ variables: moveItem(draft.variables, i, to) })}
              count={draft.variables.length}
            />
          ))}
        </ol>
        <Button
          variant="secondary"
          onClick={() =>
            set({
              variables: [
                ...draft.variables,
                { name: nextName(draft.variables), kind: 'int', lo: '1', hi: '9', text: '' },
              ],
            })
          }
        >
          + {t('question.addVariable')}
        </Button>
      </section>

      <section className="q-section">
        <h2>{t('question.constraints')}</h2>
        <p className="hint">{t('question.constraintsHint')}</p>
        <Problems list={problems.constraints} />
        <TextList
          items={draft.constraints}
          label={(n) => t('question.constraint', { n })}
          addLabel={t('question.addConstraint')}
          onChange={(constraints) => set({ constraints })}
        />
      </section>

      <section className="q-section">
        <h2>{t('question.stem')}</h2>
        <p className="hint">{t('question.stemHint')}</p>
        <Problems list={problems.stem} />
        <LocalisedFields
          label={t('question.stem')}
          value={draft.stem}
          multiline
          disabled={disabled}
          onChange={(stem) => set({ stem })}
        />
      </section>

      <section className="q-section">
        <h2>{t('question.answer')}</h2>
        <Problems list={[...(problems.answer ?? []), ...(problems.distractors ?? [])]} />
        <div className="field">
          <label htmlFor={kindId}>{t('question.answerKind')}</label>
          <select
            id={kindId}
            value={draft.answer.kind}
            onChange={(e) => onChange(withAnswerKind(draft, e.target.value as AnswerKind))}
          >
            {answerKindsFor(draft.type).map((kind) => (
              <option key={kind} value={kind}>
                {t(`akind.${kind}`)}
              </option>
            ))}
          </select>
        </div>
        <AnswerEditor
          draft={draft}
          noCorrect={local['answer/options'] === 'noCorrect'}
          disabled={disabled}
          onChange={onChange}
        />
      </section>

      <section className="q-section">
        <h2>{t('question.hints')}</h2>
        <p className="hint">{t('question.hintsHint')}</p>
        <Problems list={problems.hints} />
        {draft.hints.map((hint, i) => (
          <div key={i} className="q-item">
            <LocalisedFields
              label={t('question.hint', { n: i + 1 })}
              value={hint}
              multiline
              disabled={disabled}
              onChange={(text) => set({ hints: draft.hints.map((h, j) => (j === i ? text : h)) })}
            />
            <Button variant="danger" onClick={() => set({ hints: removeItem(draft.hints, i) })}>
              {t('editor.remove')}
            </Button>
          </div>
        ))}
        {draft.hints.length < 5 && (
          <Button variant="secondary" onClick={() => set({ hints: [...draft.hints, {}] })}>
            + {t('question.addHint')}
          </Button>
        )}
      </section>

      <section className="q-section">
        <h2>{t('question.solution')}</h2>
        <p className="hint">{t('question.solutionHint')}</p>
        <Problems list={problems.solution} />
        <LocalisedFields
          label={t('question.solution')}
          value={draft.solution}
          multiline
          disabled={disabled}
          onChange={(solution) => set({ solution })}
        />
      </section>
    </fieldset>
  );
}

/** The first unused single letter, so a new variable has a sensible name. */
function nextName(rows: readonly VariableRow[]): string {
  const used = new Set(rows.map((r) => r.name.trim()));
  return [...'abcdefghkmnpqrstuvwxyz'].find((c) => !used.has(c)) ?? '';
}

function Problems({ list }: { list: string[] | undefined }) {
  if (!list?.length) return null;
  return (
    <ul className="q-problems" role="alert">
      {list.map((message, i) => (
        <li key={i}>{message}</li>
      ))}
    </ul>
  );
}

function VariableEditor({
  row,
  index,
  count,
  error,
  onChange,
  onMove,
  onRemove,
}: {
  row: VariableRow;
  index: number;
  count: number;
  error: 'name' | 'duplicate' | undefined;
  onChange(row: VariableRow): void;
  onMove(to: number): void;
  onRemove(): void;
}) {
  const kindId = useId();
  return (
    <li className="q-variable">
      <Field
        label={t('question.varName')}
        value={row.name}
        maxLength={16}
        className="code"
        error={error ? t(`question.problem.${error}`) : undefined}
        onChange={(name) => onChange({ ...row, name })}
      />
      <div className="field">
        <label htmlFor={kindId}>{t('question.varKind')}</label>
        <select
          id={kindId}
          value={row.kind}
          onChange={(e) => onChange({ ...row, kind: e.target.value as VariableKind })}
        >
          {VARIABLE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`var.${kind}`)}
            </option>
          ))}
        </select>
      </div>
      {row.kind === 'int' ? (
        <>
          <Field
            label={t('question.varFrom')}
            value={row.lo}
            maxLength={300}
            className="code"
            onChange={(lo) => onChange({ ...row, lo })}
          />
          <Field
            label={t('question.varTo')}
            value={row.hi}
            maxLength={300}
            className="code"
            onChange={(hi) => onChange({ ...row, hi })}
          />
        </>
      ) : (
        <Field
          label={row.kind === 'choice' ? t('question.varValues') : t('question.varExpr')}
          value={row.text}
          maxLength={2000}
          className="code wide"
          onChange={(text) => onChange({ ...row, text })}
        />
      )}
      <div className="step-actions">
        <Button
          variant="secondary"
          disabled={index === 0}
          aria-label={`${t('editor.moveUp')}: ${row.name}`}
          onClick={() => onMove(index - 1)}
        >
          ↑
        </Button>
        <Button
          variant="secondary"
          disabled={index === count - 1}
          aria-label={`${t('editor.moveDown')}: ${row.name}`}
          onClick={() => onMove(index + 1)}
        >
          ↓
        </Button>
        <Button
          variant="danger"
          aria-label={`${t('editor.remove')}: ${row.name}`}
          onClick={onRemove}
        >
          ×
        </Button>
      </div>
    </li>
  );
}

/** A list of one-line formulas (constraints, distractors). */
function TextList({
  items,
  label,
  addLabel,
  max = 20,
  onChange,
}: {
  items: string[];
  label(n: number): string;
  addLabel: string;
  max?: number;
  onChange(items: string[]): void;
}) {
  return (
    <>
      <ol className="q-list">
        {items.map((item, i) => (
          <li key={i} className="q-line">
            <Field
              label={label(i + 1)}
              value={item}
              maxLength={300}
              className="code"
              onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))}
            />
            <Button
              variant="danger"
              aria-label={`${t('editor.remove')}: ${label(i + 1)}`}
              onClick={() => onChange(removeItem(items, i))}
            >
              ×
            </Button>
          </li>
        ))}
      </ol>
      {items.length < max && (
        <Button variant="secondary" onClick={() => onChange([...items, ''])}>
          + {addLabel}
        </Button>
      )}
    </>
  );
}

function AnswerEditor({
  draft,
  noCorrect,
  disabled,
  onChange,
}: {
  draft: QuestionDraft;
  noCorrect: boolean;
  disabled: boolean;
  onChange(draft: QuestionDraft): void;
}) {
  const answer = draft.answer;
  const setAnswer = (next: QuestionDraft['answer']) => onChange({ ...draft, answer: next });
  const displayId = useId();

  if (answer.kind === 'choices') {
    const setOption = (i: number, text: LocalisedText, correct: boolean) =>
      setAnswer({
        ...answer,
        options: answer.options.map((o, j) =>
          j === i
            ? { text, correct }
            : // A single choice has one right option: ticking one clears the others.
              { ...o, correct: draft.type === 'single_choice' && correct ? false : o.correct },
        ),
      });
    return (
      <>
        {noCorrect && <p className="field-error">{t('question.problem.noCorrect')}</p>}
        {answer.options.map((option, i) => (
          <div key={i} className="q-item">
            <LocalisedFields
              label={t('question.option', { n: i + 1 })}
              value={option.text}
              disabled={disabled}
              onChange={(text) => setOption(i, text, option.correct)}
            />
            <div className="q-option-actions">
              <label className="check">
                <input
                  type={draft.type === 'single_choice' ? 'radio' : 'checkbox'}
                  name="correct-option"
                  checked={option.correct}
                  onChange={(e) => setOption(i, option.text, e.target.checked)}
                />{' '}
                {t('question.correct')}
              </label>
              {answer.options.length > 2 && (
                <Button
                  variant="danger"
                  onClick={() => setAnswer({ ...answer, options: removeItem(answer.options, i) })}
                >
                  {t('editor.remove')}
                </Button>
              )}
            </div>
          </div>
        ))}
        {answer.options.length < 8 && (
          <Button
            variant="secondary"
            onClick={() =>
              setAnswer({ ...answer, options: [...answer.options, { text: {}, correct: false }] })
            }
          >
            + {t('question.addOption')}
          </Button>
        )}
      </>
    );
  }

  return (
    <>
      <Field
        label={t('question.answerExpr')}
        hint={t('question.answerExprHint')}
        value={answer.expr}
        maxLength={300}
        className="code"
        onChange={(expr) => setAnswer({ ...answer, expr })}
      />
      {answer.kind === 'number' && (
        <Field
          label={t('question.decimals')}
          hint={t('question.decimalsHint')}
          type="number"
          min={0}
          max={6}
          value={answer.decimals}
          onChange={(decimals) => setAnswer({ ...answer, decimals })}
        />
      )}
      {answer.kind === 'fraction' && (
        <>
          <fieldset className="checks">
            <legend>{t('question.accept')}</legend>
            {FRACTION_FORMS.map((form) => (
              <label key={form} className="check">
                <input
                  type="checkbox"
                  checked={answer.accept.includes(form)}
                  onChange={(e) =>
                    setAnswer({
                      ...answer,
                      accept: e.target.checked
                        ? [...answer.accept, form]
                        : answer.accept.filter((f) => f !== form),
                    })
                  }
                />{' '}
                {t(`form.${form}`)}
              </label>
            ))}
          </fieldset>
          <label className="check">
            <input
              type="checkbox"
              checked={answer.requireSimplified}
              onChange={(e) => setAnswer({ ...answer, requireSimplified: e.target.checked })}
            />{' '}
            {t('question.requireSimplified')}
          </label>
        </>
      )}
      {answer.kind === 'choice' && (
        <>
          <div className="field">
            <label htmlFor={displayId}>{t('question.display')}</label>
            <select
              id={displayId}
              value={answer.display}
              onChange={(e) =>
                setAnswer({ ...answer, display: e.target.value as 'number' | 'fraction' })
              }
            >
              <option value="fraction">{t('display.fraction')}</option>
              <option value="number">{t('display.number')}</option>
            </select>
          </div>
          <h3>{t('question.distractors')}</h3>
          <p className="hint">{t('question.distractorsHint')}</p>
          <TextList
            items={draft.distractors}
            label={(n) => t('question.distractor', { n })}
            addLabel={t('question.addDistractor')}
            max={7}
            onChange={(distractors) => onChange({ ...draft, distractors })}
          />
        </>
      )}
    </>
  );
}
