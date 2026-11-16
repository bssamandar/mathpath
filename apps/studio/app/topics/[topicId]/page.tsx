'use client';

import { api } from '@mathpath/client';
import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { LessonPreview } from '../../../components/lesson-preview';
import { type Me, StaffShell } from '../../../components/staff-shell';
import { LocalisedFields, StepEditor } from '../../../components/step-editor';
import { Badge, Button, ErrorText } from '../../../components/ui';
import { NewDraft, ReviewHistory, ReviewPanel } from '../../../components/workflow';
import {
  canPublish,
  canReview,
  canStartDraft,
  type Draft,
  draftOf,
  errorMessage,
  fieldErrors,
  isEditable,
  moveStep,
  newStep,
  removeStep,
  replaceStep,
  saveBody,
  STEP_TYPES,
  type StepType,
  type Version,
  type VersionSummary,
} from '../../../lib/editor';
import { t } from '../../../lib/i18n';

/** Topic editor (UX S15) with the review and publish actions (S16). */
export default function TopicPage({ params }: { params: Promise<{ topicId: string }> }) {
  const { topicId } = use(params);
  return <StaffShell>{(me) => <TopicEditor topicId={topicId} me={me} />}</StaffShell>;
}

function TopicEditor({ topicId, me }: { topicId: string; me: Me }) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [version, setVersion] = useState<Version | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [newType, setNewType] = useState<StepType>('video');
  const [comment, setComment] = useState('');
  // Stable keys, so a step card (and its upload state) survives being moved.
  const [keys, setKeys] = useState<string[]>([]);

  const open = useCallback(async (id: string) => {
    const v = await api<Version>(`/studio/topic-versions/${id}`);
    setVersion(v);
    setDraft(draftOf(v));
    setKeys(v.steps.map(() => crypto.randomUUID()));
    setSaved(JSON.stringify(saveBody(draftOf(v))));
    setErrors({});
  }, []);

  const load = useCallback(async () => {
    const list = await api<{ items: VersionSummary[] }>(`/studio/topics/${topicId}/versions`);
    setVersions(list.items);
    if (list.items[0]) await open(list.items[0].id);
  }, [topicId, open]);

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
      setErrors(fieldErrors(e));
    } finally {
      setBusy(false);
    }
  };

  const editable = version ? isEditable(version.status) : false;
  const dirty = useMemo(
    () => draft !== null && JSON.stringify(saveBody(draft)) !== saved,
    [draft, saved],
  );

  // Leaving with unsaved work asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async () => {
    if (!version || !draft) return;
    const v = await api<Version>(`/studio/topic-versions/${version.id}`, {
      method: 'PUT',
      headers: { 'If-Match': version.etag },
      body: saveBody(draft),
    });
    setVersion(v);
    setSaved(JSON.stringify(saveBody(draft)));
  };

  const transition = async (path: string, body?: unknown) => {
    if (!version) return;
    await api(`/studio/versions/${version.id}/${path}`, { method: 'POST', body: body ?? {} });
    await load();
  };

  if (!draft || !version) {
    return (
      <>
        <ErrorText message={error} />
        {versions.length === 0 && !error && (
          <NewDraft
            busy={busy}
            onClick={() =>
              void act(async () => {
                const v = await api<Version>(`/studio/topics/${topicId}/versions`, {
                  method: 'POST',
                });
                await load();
                await open(v.id);
              })
            }
          />
        )}
      </>
    );
  }

  return (
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
          <NewDraft
            busy={busy}
            onClick={() =>
              void act(async () => {
                const v = await api<Version>(`/studio/topics/${topicId}/versions`, {
                  method: 'POST',
                });
                await load();
                await open(v.id);
              })
            }
          />
        )}
      </nav>

      <section className="steps-column">
        <div className="statusbar" role="status">
          <Badge tone={version.status}>{t(`status.${version.status}`)}</Badge>
          <span>{t('editor.version', { n: version.versionNo })}</span>
          {editable && <span>{dirty ? t('editor.unsaved') : t('editor.saved')}</span>}
        </div>
        <p>
          <Link href={`/topics/${topicId}/questions`}>{t('questions.open')}</Link>
        </p>
        {!editable && (
          <p className="hint">{t('editor.readOnly', { status: t(`status.${version.status}`) })}</p>
        )}

        <LocalisedFields
          label={t('editor.title')}
          value={draft.title}
          error={errors.title}
          disabled={!editable}
          onChange={(title) => setDraft({ ...draft, title })}
        />
        <LocalisedFields
          label={t('editor.summary')}
          value={draft.summary}
          error={errors.summary}
          multiline
          disabled={!editable}
          onChange={(summary) => setDraft({ ...draft, summary })}
        />

        <h2>{t('editor.steps')}</h2>
        <ErrorText message={errors.steps} />
        <ol className="step-list">
          {draft.steps.map((step, i) => (
            <StepEditor
              key={keys[i] ?? i}
              step={step}
              index={i}
              count={draft.steps.length}
              disabled={!editable}
              errors={errors}
              onChange={(s) => setDraft({ ...draft, steps: replaceStep(draft.steps, i, s) })}
              onMove={(to) => {
                setDraft({ ...draft, steps: moveStep(draft.steps, i, to) });
                setKeys(moveStep(keys, i, to));
              }}
              onRemove={() => {
                setDraft({ ...draft, steps: removeStep(draft.steps, i) });
                setKeys(removeStep(keys, i));
              }}
            />
          ))}
        </ol>
        {editable && (
          <div className="add-step">
            <label htmlFor="new-step">{t('editor.addStep')}</label>
            <select
              id="new-step"
              value={newType}
              onChange={(e) => setNewType(e.target.value as StepType)}
            >
              {STEP_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`step.${type}`)}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft({ ...draft, steps: [...draft.steps, newStep(newType)] });
                setKeys([...keys, crypto.randomUUID()]);
              }}
            >
              +
            </Button>
          </div>
        )}

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

      <LessonPreview draft={draft} />
    </div>
  );
}
