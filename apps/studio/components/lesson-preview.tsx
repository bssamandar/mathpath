'use client';

import { useState } from 'react';
import { CONTENT_LOCALES, type ContentLocale, type Draft } from '../lib/editor';
import { t } from '../lib/i18n';
import { LOCALE_NAMES } from './step-editor';

/**
 * A phone-sized preview of how the lesson reads in one language (UX S15),
 * so a missing or overlong translation is visible before review.
 */
export function LessonPreview({ draft }: { draft: Draft }) {
  const [locale, setLocale] = useState<ContentLocale>('uz-Latn');
  return (
    <aside className="preview" aria-label={t('editor.preview')}>
      <div className="preview-locales" role="group" aria-label={t('editor.preview')}>
        {CONTENT_LOCALES.map((code) => (
          <button
            key={code}
            type="button"
            className="pill"
            aria-pressed={code === locale}
            onClick={() => setLocale(code)}
          >
            {LOCALE_NAMES[code]}
          </button>
        ))}
      </div>
      <div className="phone" lang={locale}>
        <ol className="stepper" aria-hidden>
          {draft.steps.map((step, i) => (
            <li key={i} title={t(`step.${step.type}`)} />
          ))}
        </ol>
        <h2>{draft.title[locale] || <span className="missing">—</span>}</h2>
        {draft.summary[locale] && <p>{draft.summary[locale]}</p>}
        <ol className="preview-steps">
          {draft.steps.map((step, i) => (
            <li key={i}>
              <strong>{t(`step.${step.type}`)}</strong>
              {'prompt' in step && (
                <p>{step.prompt[locale] || <span className="missing">—</span>}</p>
              )}
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}
