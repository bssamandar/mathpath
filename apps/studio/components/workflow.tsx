'use client';

import type { Version } from '../lib/editor';
import { t } from '../lib/i18n';
import { Badge, Button, Field } from './ui';

/**
 * The review workflow parts shared by the lesson and question editors (UX
 * S16): opening a draft, the reviewer's decision and the review history.
 */
export function NewDraft({
  busy,
  hint = t('editor.newDraftHint'),
  onClick,
}: {
  busy: boolean;
  hint?: string;
  onClick(): void;
}) {
  return (
    <div className="new-draft">
      <Button busy={busy} onClick={onClick}>
        {t('editor.newDraft')}
      </Button>
      <p className="hint">{hint}</p>
    </div>
  );
}

export function ReviewPanel({
  allowed,
  busy,
  comment,
  setComment,
  onDecide,
}: {
  allowed: boolean;
  busy: boolean;
  comment: string;
  setComment(value: string): void;
  onDecide(decision: 'approved' | 'changes_requested'): void;
}) {
  return (
    <section className="panel">
      <h2>{t('review.title')}</h2>
      {!allowed ? (
        <p className="hint">{t('review.ownWork')}</p>
      ) : (
        <>
          <Field label={t('review.comment')} multiline value={comment} onChange={setComment} />
          <div className="actions">
            <Button busy={busy} onClick={() => onDecide('approved')}>
              {t('review.approve')}
            </Button>
            <Button variant="secondary" busy={busy} onClick={() => onDecide('changes_requested')}>
              {t('review.requestChanges')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export function ReviewHistory({ reviews }: { reviews: Version['reviews'] }) {
  if (reviews.length === 0) return null;
  return (
    <section className="panel">
      <h2>{t('review.history')}</h2>
      <ul>
        {reviews.map((r) => (
          <li key={r.createdAt}>
            <Badge tone={r.decision}>{t(`status.${r.decision as 'approved'}`)}</Badge>{' '}
            {new Date(r.createdAt).toLocaleString('uz-Latn')}
            {(r.comments as { text: string }[]).map((c, i) => (
              <blockquote key={i}>{c.text}</blockquote>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
