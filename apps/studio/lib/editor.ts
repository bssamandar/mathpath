/**
 * The lesson editor's model, kept free of React so it can be tested alone.
 * Shapes mirror apps/api/src/content/documents.ts and docs/api/openapi.yaml.
 */
import { ApiError } from '@mathpath/client';
import { isMessageKey, type Translate } from './i18n';

export const CONTENT_LOCALES = ['uz-Latn', 'ru'] as const;
export type ContentLocale = (typeof CONTENT_LOCALES)[number] | 'en';
export type LocalisedText = Partial<Record<ContentLocale, string>>;

export const ACTIVITIES = ['fraction_model', 'number_line', 'drag_drop', 'step_solver'] as const;
export type Activity = (typeof ACTIVITIES)[number];

export type LessonStep =
  | { type: 'video'; mediaId: string; required: boolean }
  | {
      type: 'activity';
      activity: Activity;
      config: Record<string, unknown>;
      prompt: LocalisedText;
    }
  | { type: 'practice'; minCorrect: number; prompt: LocalisedText }
  | { type: 'mastery_test' }
  | { type: 'review' };

export type StepType = LessonStep['type'];
export const STEP_TYPES: readonly StepType[] = [
  'video',
  'activity',
  'practice',
  'mastery_test',
  'review',
];

export type VersionStatus =
  | 'draft'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'published'
  | 'archived';

export interface VersionSummary {
  id: string;
  versionNo: number;
  status: VersionStatus;
  authorId: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface Version extends VersionSummary {
  topicId: string;
  etag: string;
  title: LocalisedText;
  summary: LocalisedText;
  steps: LessonStep[];
  questionPool: Record<string, unknown>;
  reviews: { reviewerId: string; decision: string; comments: unknown[]; createdAt: string }[];
}

/** What the editor holds while the author types. */
export interface Draft {
  title: LocalisedText;
  summary: LocalisedText;
  steps: LessonStep[];
  questionPool: Record<string, unknown>;
}

/** A new step with sensible defaults; a video step still needs its upload. */
export function newStep(type: StepType): LessonStep {
  switch (type) {
    case 'video':
      return { type, mediaId: '', required: true };
    case 'activity':
      return { type, activity: 'fraction_model', config: {}, prompt: {} };
    case 'practice':
      return { type, minCorrect: 6, prompt: {} };
    default:
      return { type };
  }
}

/** Moves one item; also used for the steps' list keys, so they move together. */
export function moveStep<T>(steps: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= steps.length || from === to) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function removeStep<T>(steps: readonly T[], index: number): T[] {
  return steps.filter((_, i) => i !== index);
}

export function replaceStep(
  steps: readonly LessonStep[],
  index: number,
  step: LessonStep,
): LessonStep[] {
  return steps.map((s, i) => (i === index ? step : s));
}

export function draftOf(version: Version): Draft {
  return {
    title: version.title,
    summary: version.summary,
    steps: version.steps,
    questionPool: version.questionPool,
  };
}

/**
 * The body for `PUT /studio/topic-versions/{id}`. Blank texts are dropped,
 * and a video step without an upload is kept out until it has one (the API
 * would refuse an empty media ID).
 */
export function saveBody(draft: Draft): Draft {
  const clean = (text: LocalisedText): LocalisedText =>
    Object.fromEntries(Object.entries(text).filter(([, v]) => v && v.trim()));
  return {
    title: clean(draft.title),
    summary: clean(draft.summary),
    questionPool: draft.questionPool,
    steps: draft.steps
      .filter((s) => s.type !== 'video' || s.mediaId !== '')
      .map((s) => ('prompt' in s ? { ...s, prompt: clean(s.prompt) } : s)),
  };
}

export const EDITABLE: readonly VersionStatus[] = ['draft', 'changes_requested'];

export function isEditable(status: VersionStatus): boolean {
  return EDITABLE.includes(status);
}

/** "May open a new draft": only when no version is open. */
export function canStartDraft(versions: readonly VersionSummary[]): boolean {
  return versions.every((v) => v.status === 'published' || v.status === 'archived');
}

/**
 * Whether to offer the review buttons. The API has the last word (an admin
 * may approve their own work while `adminSelfReview` is on), so an author's
 * own version shows the buttons only to admins.
 */
export function canReview(
  version: VersionSummary,
  me: { userId: string; roles: readonly string[] },
): boolean {
  if (version.status !== 'in_review') return false;
  if (!me.roles.some((r) => r === 'reviewer' || r === 'admin')) return false;
  return version.authorId !== me.userId || me.roles.includes('admin');
}

export function canPublish(version: VersionSummary, roles: readonly string[]): boolean {
  return version.status === 'approved' && roles.some((r) => r === 'reviewer' || r === 'admin');
}

/** Field errors from a 422, keyed by field path (for example `steps/0/mediaId`). */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  return Object.fromEntries(error.fields.map((f) => [f.field, f.message]));
}

/** A message to show for any failed call; unknown codes never leak to the screen. */
export function errorMessage(t: Translate, error: unknown): string {
  if (!(error instanceof ApiError)) return t('error.generic');
  if (error.code === 'OFFLINE') return t('error.offline');
  if (error.status === 403 && error.code !== 'FOUR_EYES' && error.code !== 'MFA_REQUIRED') {
    return t('error.FORBIDDEN');
  }
  const key = `error.${error.code}`;
  if (!isMessageKey(key)) return t('error.generic');
  return t(key, { minutes: Math.max(1, Math.ceil((error.retryAfterS ?? 60) / 60)) });
}

/** Seconds to "m:ss" for video lengths. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The text in the first locale that has one, for lists and previews. */
export function anyText(text: LocalisedText, preferred: ContentLocale = 'uz-Latn'): string {
  return text[preferred]?.trim() || Object.values(text).find((v) => v?.trim()) || '';
}
