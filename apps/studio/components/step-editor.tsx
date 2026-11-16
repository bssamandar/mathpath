'use client';

import { useState } from 'react';
import {
  ACTIVITIES,
  CONTENT_LOCALES,
  type ContentLocale,
  type LessonStep,
  type LocalisedText,
} from '../lib/editor';
import { t } from '../lib/i18n';
import { Button, Field } from './ui';
import { VideoField } from './video-field';

export const LOCALE_NAMES: Record<ContentLocale, string> = {
  'uz-Latn': 'O‘zbekcha',
  ru: 'Русский',
  en: 'English',
};

/** One text in each content language, side by side, so translations stay in step. */
export function LocalisedFields({
  label,
  value,
  error,
  multiline = false,
  disabled,
  onChange,
}: {
  label: string;
  value: LocalisedText;
  error?: string;
  multiline?: boolean;
  disabled: boolean;
  onChange(value: LocalisedText): void;
}) {
  return (
    <fieldset className="localised" disabled={disabled}>
      <legend>{label}</legend>
      {CONTENT_LOCALES.map((locale) => (
        <div key={locale} lang={locale}>
          <Field
            label={LOCALE_NAMES[locale]}
            value={value[locale] ?? ''}
            multiline={multiline}
            maxLength={4000}
            error={error && !value[locale]?.trim() ? t('editor.required') : undefined}
            onChange={(text) => onChange({ ...value, [locale]: text })}
          />
        </div>
      ))}
    </fieldset>
  );
}

/**
 * The card for one lesson step. `errors` holds field errors from the API
 * keyed by path, for example `steps/2/prompt`.
 */
export function StepEditor({
  step,
  index,
  count,
  disabled,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  step: LessonStep;
  index: number;
  count: number;
  disabled: boolean;
  errors: Record<string, string>;
  onChange(step: LessonStep): void;
  onMove(to: number): void;
  onRemove(): void;
}) {
  const path = `steps/${index}`;
  return (
    <li className="step-card">
      <header>
        <h3>
          {index + 1}. {t(`step.${step.type}`)}
        </h3>
        {!disabled && (
          <div className="step-actions">
            <Button
              variant="secondary"
              disabled={index === 0}
              aria-label={`${t('editor.moveUp')}: ${index + 1}`}
              onClick={() => onMove(index - 1)}
            >
              ↑
            </Button>
            <Button
              variant="secondary"
              disabled={index === count - 1}
              aria-label={`${t('editor.moveDown')}: ${index + 1}`}
              onClick={() => onMove(index + 1)}
            >
              ↓
            </Button>
            <Button variant="danger" onClick={onRemove}>
              {t('editor.remove')}
            </Button>
          </div>
        )}
      </header>

      {step.type === 'video' && (
        <VideoField
          mediaId={step.mediaId}
          disabled={disabled}
          error={errors[`${path}/mediaId`]}
          onChange={(mediaId) => onChange({ ...step, mediaId })}
        />
      )}

      {step.type === 'activity' && (
        <>
          <div className="field">
            <label htmlFor={`${path}-activity`}>{t('editor.activity')}</label>
            <select
              id={`${path}-activity`}
              value={step.activity}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...step, activity: e.target.value as (typeof ACTIVITIES)[number] })
              }
            >
              {ACTIVITIES.map((a) => (
                <option key={a} value={a}>
                  {t(`activity.${a}`)}
                </option>
              ))}
            </select>
          </div>
          <ConfigField
            value={step.config}
            disabled={disabled}
            onChange={(config) => onChange({ ...step, config })}
          />
          <LocalisedFields
            label={t('editor.prompt')}
            value={step.prompt}
            error={errors[`${path}/prompt`]}
            disabled={disabled}
            onChange={(prompt) => onChange({ ...step, prompt })}
          />
        </>
      )}

      {step.type === 'practice' && (
        <>
          <Field
            label={t('editor.minCorrect')}
            type="number"
            min={1}
            max={50}
            disabled={disabled}
            value={String(step.minCorrect)}
            onChange={(v) =>
              onChange({ ...step, minCorrect: Math.min(50, Math.max(1, Number(v) || 1)) })
            }
          />
          <LocalisedFields
            label={t('editor.prompt')}
            value={step.prompt}
            error={errors[`${path}/prompt`]}
            disabled={disabled}
            onChange={(prompt) => onChange({ ...step, prompt })}
          />
          <p className="hint">{t('editor.questionsLater')}</p>
        </>
      )}

      {(step.type === 'mastery_test' || step.type === 'review') && (
        <p className="hint">{t('editor.questionsLater')}</p>
      )}
    </li>
  );
}

/** Activity settings as JSON; kept as text until it parses, so typing is not interrupted. */
function ConfigField({
  value,
  disabled,
  onChange,
}: {
  value: Record<string, unknown>;
  disabled: boolean;
  onChange(value: Record<string, unknown>): void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  return (
    <div className="field">
      <label>
        {t('editor.activityConfig')}
        <textarea
          className="code"
          rows={4}
          value={text}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(e) => {
            setText(e.target.value);
            try {
              const parsed: unknown = JSON.parse(e.target.value);
              const ok = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
              setInvalid(!ok);
              if (ok) onChange(parsed as Record<string, unknown>);
            } catch {
              setInvalid(true);
            }
          }}
        />
      </label>
      {invalid && <p className="field-error">JSON</p>}
    </div>
  );
}
