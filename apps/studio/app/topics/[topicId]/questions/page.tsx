'use client';

import { api } from '@mathpath/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useId, useState } from 'react';
import { MathText } from '../../../../components/math-text';
import { StaffShell } from '../../../../components/staff-shell';
import { Badge, Button, ErrorText } from '../../../../components/ui';
import { anyText, errorMessage } from '../../../../lib/editor';
import { t } from '../../../../lib/i18n';
import {
  type QuestionSummary,
  QUESTION_TYPES,
  type QuestionType,
  type QuestionVersion,
  starterInput,
} from '../../../../lib/questions';

/** A topic's question bank (UX S15): every template with its newest version. */
export default function QuestionsPage({ params }: { params: Promise<{ topicId: string }> }) {
  const { topicId } = use(params);
  return <StaffShell>{() => <QuestionList topicId={topicId} />}</StaffShell>;
}

function QuestionList({ topicId }: { topicId: string }) {
  const router = useRouter();
  const [items, setItems] = useState<QuestionSummary[] | null>(null);
  const [type, setType] = useState<QuestionType>('numeric');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typeId = useId();

  useEffect(() => {
    api<{ items: QuestionSummary[] }>(`/studio/topics/${topicId}/question-templates`)
      .then((list) => setItems(list.items))
      .catch((e: unknown) => setError(errorMessage(t, e)));
  }, [topicId]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await api<QuestionVersion>(`/studio/topics/${topicId}/question-templates`, {
        method: 'POST',
        body: starterInput(type),
      });
      router.push(`/questions/${v.templateId}`);
    } catch (e) {
      setError(errorMessage(t, e));
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        <Link href={`/topics/${topicId}`}>{t('questions.toTopic')}</Link>
      </p>
      <h1>{t('questions.title')}</h1>
      <ErrorText message={error} />
      {items?.length === 0 && <p>{t('questions.empty')}</p>}
      {items && items.length > 0 && (
        <ol className="q-bank">
          {items.map((q) => {
            const stem = anyText(q.latest.stem);
            return (
              <li key={q.id}>
                <Link href={`/questions/${q.id}`} className="q-bank-stem">
                  {stem ? <MathText text={stem} /> : <em>{t('questions.noStem')}</em>}
                </Link>
                <span className="q-bank-meta">
                  {t(`qtype.${q.latest.type}`)} · {q.latest.difficulty}/5
                  {q.externalRef && <> · {q.externalRef}</>}
                </span>
                <span className="q-bank-badges">
                  {q.publishedVersionId && q.latest.status !== 'published' && (
                    <Badge tone="published">{t('questions.published')}</Badge>
                  )}
                  <Badge tone={q.latest.status}>{t(`status.${q.latest.status}`)}</Badge>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {items && (
        <div className="add-step">
          <label htmlFor={typeId}>{t('question.type')}</label>
          <select
            id={typeId}
            value={type}
            onChange={(e) => setType(e.target.value as QuestionType)}
          >
            {QUESTION_TYPES.map((q) => (
              <option key={q} value={q}>
                {t(`qtype.${q}`)}
              </option>
            ))}
          </select>
          <Button busy={busy} onClick={() => void create()}>
            + {t('questions.new')}
          </Button>
        </div>
      )}
    </>
  );
}
