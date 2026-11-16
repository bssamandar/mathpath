import { ApiError } from '@mathpath/client';
import { describe, expect, it } from 'vitest';
import {
  anyText,
  canPublish,
  canReview,
  canStartDraft,
  draftOf,
  errorMessage,
  fieldErrors,
  formatDuration,
  isEditable,
  type LessonStep,
  moveStep,
  newStep,
  removeStep,
  replaceStep,
  saveBody,
  type Version,
  type VersionSummary,
} from './editor';
import { t } from './i18n';

const steps: LessonStep[] = [newStep('video'), newStep('activity'), newStep('practice')];

const summary = (over: Partial<VersionSummary> = {}): VersionSummary => ({
  id: 'v1',
  versionNo: 1,
  status: 'draft',
  authorId: 'author',
  updatedAt: '2026-11-16T00:00:00Z',
  publishedAt: null,
  ...over,
});

describe('steps', () => {
  it('creates each step type with defaults', () => {
    expect(newStep('video')).toEqual({ type: 'video', mediaId: '', required: true });
    expect(newStep('activity')).toMatchObject({ activity: 'fraction_model', config: {} });
    expect(newStep('practice')).toMatchObject({ minCorrect: 6 });
    expect(newStep('mastery_test')).toEqual({ type: 'mastery_test' });
    expect(newStep('review')).toEqual({ type: 'review' });
  });

  it('moves, removes and replaces without touching the original', () => {
    expect(moveStep(steps, 0, 2).map((s) => s.type)).toEqual(['activity', 'practice', 'video']);
    expect(moveStep(steps, 2, 0).map((s) => s.type)).toEqual(['practice', 'video', 'activity']);
    expect(moveStep(steps, 0, -1)).toEqual(steps);
    expect(moveStep(steps, 0, 3)).toEqual(steps);
    expect(moveStep(steps, 1, 1)).not.toBe(steps);
    expect(removeStep(steps, 1).map((s) => s.type)).toEqual(['video', 'practice']);
    const review = newStep('review');
    expect(replaceStep(steps, 0, review)[0]).toBe(review);
    expect(steps[0]!.type).toBe('video');
  });
});

describe('saveBody', () => {
  it('drops blank texts and video steps that have no upload yet', () => {
    const body = saveBody({
      title: { 'uz-Latn': 'Kasrlar', ru: '  ' },
      summary: {},
      questionPool: {},
      steps: [
        { type: 'video', mediaId: '', required: true },
        { type: 'video', mediaId: 'm1', required: true },
        { type: 'practice', minCorrect: 3, prompt: { 'uz-Latn': 'Yeching', ru: '' } },
        { type: 'review' },
      ],
    });
    expect(body.title).toEqual({ 'uz-Latn': 'Kasrlar' });
    expect(body.steps).toEqual([
      { type: 'video', mediaId: 'm1', required: true },
      { type: 'practice', minCorrect: 3, prompt: { 'uz-Latn': 'Yeching' } },
      { type: 'review' },
    ]);
  });

  it('takes the editable fields from a version', () => {
    const version = {
      ...summary(),
      topicId: 't',
      etag: '"1"',
      title: { ru: 'Дроби' },
      summary: {},
      steps,
      questionPool: { size: 1 },
      reviews: [],
    } satisfies Version;
    expect(draftOf(version)).toEqual({
      title: { ru: 'Дроби' },
      summary: {},
      steps,
      questionPool: { size: 1 },
    });
  });
});

describe('workflow rules', () => {
  it('lets only drafts and returned versions be edited', () => {
    expect(isEditable('draft')).toBe(true);
    expect(isEditable('changes_requested')).toBe(true);
    expect(isEditable('in_review')).toBe(false);
    expect(isEditable('published')).toBe(false);
  });

  it('offers a new draft only when nothing is open', () => {
    expect(canStartDraft([])).toBe(true);
    expect(canStartDraft([summary({ status: 'published' }), summary({ status: 'archived' })])).toBe(
      true,
    );
    expect(canStartDraft([summary({ status: 'in_review' })])).toBe(false);
  });

  it('applies four eyes, with the admin exception', () => {
    const inReview = summary({ status: 'in_review' });
    expect(canReview(inReview, { userId: 'other', roles: ['reviewer'] })).toBe(true);
    expect(canReview(inReview, { userId: 'author', roles: ['reviewer'] })).toBe(false);
    expect(canReview(inReview, { userId: 'author', roles: ['admin'] })).toBe(true);
    expect(canReview(inReview, { userId: 'other', roles: ['author'] })).toBe(false);
    expect(canReview(summary(), { userId: 'other', roles: ['reviewer'] })).toBe(false);
  });

  it('publishes approved versions for reviewers and admins', () => {
    expect(canPublish(summary({ status: 'approved' }), ['reviewer'])).toBe(true);
    expect(canPublish(summary({ status: 'approved' }), ['author'])).toBe(false);
    expect(canPublish(summary({ status: 'in_review' }), ['admin'])).toBe(false);
  });
});

describe('errors', () => {
  it('keys field errors by path', () => {
    const error = new ApiError(422, 'CONTENT_INCOMPLETE', undefined, [
      { field: 'steps/0/mediaId', message: 'not ready' },
    ]);
    expect(fieldErrors(error)).toEqual({ 'steps/0/mediaId': 'not ready' });
    expect(fieldErrors(new Error('x'))).toEqual({});
  });

  it('maps codes to texts and hides unknown ones', () => {
    expect(errorMessage(t, new Error('boom'))).toBe(t('error.generic'));
    expect(errorMessage(t, new ApiError(0, 'OFFLINE'))).toBe(t('error.offline'));
    expect(errorMessage(t, new ApiError(403, 'NOPE'))).toBe(t('error.FORBIDDEN'));
    expect(errorMessage(t, new ApiError(403, 'FOUR_EYES'))).toBe(t('error.FOUR_EYES'));
    expect(errorMessage(t, new ApiError(500, 'SOMETHING_NEW'))).toBe(t('error.generic'));
    expect(errorMessage(t, new ApiError(429, 'TOO_MANY_REQUESTS', 150))).toContain('3 daqiqa');
    expect(errorMessage(t, new ApiError(429, 'TOO_MANY_REQUESTS'))).toContain('1 daqiqa');
  });
});

describe('display helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(125.4)).toBe('2:05');
  });

  it('picks any available text', () => {
    expect(anyText({ 'uz-Latn': 'Kasr', ru: 'Дробь' })).toBe('Kasr');
    expect(anyText({ 'uz-Latn': ' ', ru: 'Дробь' })).toBe('Дробь');
    expect(anyText({ ru: 'Дробь' }, 'ru')).toBe('Дробь');
    expect(anyText({})).toBe('');
  });
});
