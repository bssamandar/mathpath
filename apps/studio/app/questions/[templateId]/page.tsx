'use client';

import { api } from '@mathpath/client';
import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { QuestionForm } from '../../../components/question-form';
import { QuestionPreview } from '../../../components/question-preview';
import { type Me, StaffShell } from '../../../components/staff-shell';
import { Badge, Button, ErrorText } from '../../../components/ui';
import { NewDraft, ReviewHistory, ReviewPanel } from '../../../components/workflow';
import {
  canPublish,
  canReview,
  canStartDraft,
  errorMessage,
  fieldErrors,
  isEditable,
  type VersionSummary,
} from '../../../lib/editor';
import { t } from '../../../lib/i18n';
import {
  type Preview,
  type QuestionDraft,
  type QuestionVersion,
  questionDraftOf,
  questionInput,
  sectionOf,
} from '../../../lib/questions';

/** Question template editor (UX S15, ADR-0011) with the review workflow (S16). */
export default function QuestionPage({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = use(params);
  return <StaffShell>{(me) => <QuestionEditor templateId={templateId} me={me} />}</StaffShell>;
}

/** Groups API problems by form section; several may land in one section. */
function bySection(problems: { field: string; message: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of problems) (out[sectionOf(p.field)] ??= []).push(p.message);
  return out;
}

function QuestionEditor({ templateId, me }: { templateId: string; me: Me }) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [version, setVersion] = useState<QuestionVersion | null>(null);
  const [draft, setDraft] = useState<QuestionDraft | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Preview['warnings']>([]);
  const [refused, setRefused] = useState<Preview['warnings']>([]);
  const [comment, setComment] = useState('');

  const open = useCallback(async (id: string) => {
    const v = await api<QuestionVersion>(`/studio/question-template-versions/${id}`);
    const d = questionDraftOf(v);
    setVersion(v);
    setDraft(d);
    setSaved(JSON.stringify(questionInput(d)));
    setRefused([]);
  }, []);

  const load = useCallback(async () => {
    const list = await api<{ items: VersionSummary[] }>(
      `/studio/question-templates/${templateId}/versions`,
    );
    setVersions(list.items);
    if (list.items[0]) await open(list.items[0].id);
  }, [templateId, open]);

  useEffect(() => {
    load().catch((e: unknown) => setError(errorMessage(t, e)));
  }, [load]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(t, e));
      setRefused(Object.entries(fieldErrors(e)).map(([field, message]) => ({ field, message })));
    } finally {
      setBusy(false);
    }
  };

  const input = useMemo(() => (draft ? questionInput(draft) : null), [draft]);
  const editable = version ? isEditable(version.status) : false;
  const dirty = input !== null && JSON.stringify(input) !== saved;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async () => {
    if (!version || !input) return;
    const v = await api<QuestionVersion>(`/studio/question-template-versions/${version.id}`, {
      method: 'PUT',
      headers: { 'If-Match': version.etag },
      body: input,
    });
    setVersion(v);
    setSaved(JSON.stringify(input));
    setRefused([]);
  };

  const transition = async (path: string, body?: unknown) => {
    if (!version) return;
    await api(`/studio/versions/${version.id}/${path}`, { method: 'POST', body: body ?? {} });
    await load();
  };

  const newDraft = () =>
    void act(async () => {
      const v = await api<QuestionVersion>(`/studio/question-templates/${templateId}/versions`, {
        method: 'POST',
      });
      await load();
      await open(v.id);
    });

  if (!draft || !version || !input) return <ErrorText message={error} />;

  const problems = bySection([...refused, ...(editable ? warnings : [])]);
  return (
    <>
      <p>
        <Link href={`/topics/${version.topicId}/questions`}>{t('questions.toList')}</Link>
      </p>
      <div className="editor">
        <nav className="versions" aria-label={t('editor.versions')}>
          <h2>{t('editor.versions')}</h2>
          <ul>
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className="link"
                  aria-current={v.id === version.id}
                  onClick={() => void act(() => open(v.id))}
                >
                  {t('editor.version', { n: v.versionNo })}
                </button>{' '}
                <Badge tone={v.status}>{t(`status.${v.status}`)}</Badge>
              </li>
            ))}
          </ul>
          {canStartDraft(versions) && (
            <NewDraft busy={busy} hint={t('questions.newDraftHint')} onClick={newDraft} />
          )}
        </nav>

        <section className="steps-column">
          <div className="statusbar" role="status">
            <Badge tone={version.status}>{t(`status.${version.status}`)}</Badge>
            <span>{t('editor.version', { n: version.versionNo })}</span>
            {editable && <span>{dirty ? t('editor.unsaved') : t('editor.saved')}</span>}
          </div>
          {!editable && (
            <p className="hint">
              {t('editor.readOnly', { status: t(`status.${version.status}`) })}
            </p>
          )}

          <QuestionForm
            draft={draft}
            disabled={!editable}
            problems={problems}
            onChange={setDraft}
          />

          <ErrorText message={error} />
          <div className="actions">
            {editable && (
              <>
                <Button busy={busy} disabled={!dirty} onClick={() => void act(save)}>
                  {t('editor.save')}
                </Button>
                <Button
                  variant="secondary"
                  busy={busy}
                  onClick={() =>
                    void act(async () => {
                      if (dirty) await save();
                      await transition('submit');
                    })
                  }
                >
                  {t('editor.submit')}
                </Button>
              </>
            )}
          </div>

          {version.status === 'in_review' && (
            <ReviewPanel
              allowed={canReview(version, me)}
              busy={busy}
              comment={comment}
              setComment={setComment}
              onDecide={(decision) => {
                if (decision === 'changes_requested' && !comment.trim()) {
                  setError(t('review.commentRequired'));
                  return;
                }
                void act(async () => {
                  await transition('review', {
                    decision,
                    comments: comment.trim() ? [{ text: comment.trim() }] : [],
                  });
                  setComment('');
                });
              }}
            />
          )}

          {canPublish(version, me.roles) && (
            <section className="panel">
              <h2>{t('review.publish')}</h2>
              <p className="hint">{t('review.publishHint')}</p>
              <Button busy={busy} onClick={() => void act(() => transition('publish'))}>
                {t('review.publish')}
              </Button>
            </section>
          )}

          <ReviewHistory reviews={version.reviews} />
        </section>

        <QuestionPreview type={input.type} body={input.body} onWarnings={setWarnings} />
      </div>
    </>
  );
}
