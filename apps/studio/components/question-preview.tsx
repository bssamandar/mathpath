'use client';

import { api } from '@mathpath/client';
import { useEffect, useRef, useState } from 'react';
import { CONTENT_LOCALES, type ContentLocale, errorMessage } from '../lib/editor';
import { t } from '../lib/i18n';
import { type Preview, sampleAnswer } from '../lib/questions';
import { MathText } from './math-text';
import { LOCALE_NAMES } from './step-editor';
import { Button, ErrorText } from './ui';

const SAMPLES = 3;
const DELAY_MS = 700;
const LABELS = 'ABCDEFGH';

/**
 * Sample questions from the engine as the author types (UX S15): the stem
 * with real numbers, rendered like the learner app, plus the answer the
 * server would accept. Problems go to `onWarnings`, so the form can show
 * them next to the part they are about.
 */
export function QuestionPreview({
  type,
  body,
  onWarnings,
}: {
  type: string;
  body: unknown;
  onWarnings(warnings: Preview['warnings']): void;
}) {
  const [locale, setLocale] = useState<ContentLocale>('uz-Latn');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // The preview takes only the type and body (difficulty and skills do not change items).
  const key = JSON.stringify({ type, body });
  // Only the newest request may update the screen.
  const latest = useRef(0);
  const report = useRef(onWarnings);
  report.current = onWarnings;

  useEffect(() => {
    const id = ++latest.current;
    const timer = setTimeout(() => {
      setBusy(true);
      api<Preview>('/studio/question-templates/preview', {
        method: 'POST',
        body: { ...(JSON.parse(key) as object), samples: SAMPLES },
      })
        .then((result) => {
          if (id !== latest.current) return;
          setPreview(result);
          setError(null);
          report.current(result.warnings);
        })
        .catch((e: unknown) => {
          if (id === latest.current) setError(errorMessage(t, e));
        })
        .finally(() => {
          if (id === latest.current) setBusy(false);
        });
    }, DELAY_MS);
    return () => clearTimeout(timer);
  }, [key, round]);

  return (
    <aside className="preview" aria-label={t('preview.title')}>
      <h2>{t('preview.title')}</h2>
      <p className="hint">{t('preview.hint')}</p>
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
      <Button variant="secondary" busy={busy} onClick={() => setRound((n) => n + 1)}>
        {busy ? t('preview.loading') : t('preview.refresh')}
      </Button>
      <ErrorText message={error} />
      <div aria-live="polite">
        {preview && preview.warnings.length === 0 && <p className="ok">✓ {t('preview.ok')}</p>}
        {preview && preview.warnings.length > 0 && (
          <div className="q-warnings">
            <strong>{t('preview.warnings')}</strong>
            <ul>
              {preview.warnings.map((w, i) => (
                <li key={i}>
                  <code>{w.field}</code>: {w.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {preview?.samples.map((sample, i) => (
        <article key={i} className="phone q-sample" lang={locale}>
          {sample.instance.stem[locale] ? (
            <MathText block text={sample.instance.stem[locale]} />
          ) : (
            <p className="missing">—</p>
          )}
          {sample.instance.choices ? (
            <ol className="q-choices">
              {sample.instance.choices.map((choice, j) => (
                <li key={choice.id}>
                  <span className="q-choice-label">{LABELS[j]}</span>{' '}
                  <MathText text={choice.text[locale] ?? '—'} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="hint">{t('preview.typed')}</p>
          )}
          <dl className="q-meta">
            <dt>{t('preview.answer')}</dt>
            <dd>
              <code>{sampleAnswer(sample)}</code>
            </dd>
            {Object.keys(sample.params).length > 0 && (
              <>
                <dt>{t('preview.values')}</dt>
                <dd>
                  <code>
                    {Object.entries(sample.params)
                      .map(([k, v]) => `${k} = ${v}`)
                      .join(', ')}
                  </code>
                </dd>
              </>
            )}
          </dl>
        </article>
      ))}
    </aside>
  );
}
