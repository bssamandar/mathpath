/**
 * Shapes of the versioned lesson documents (docs/database-schema.md §4.1)
 * and the rules a version must meet before review.
 *
 * Validated on every save, so a malformed step can never reach the lesson
 * player. Localised fields are objects keyed by locale; completeness in the
 * required content locales (config/content.yaml) is checked only on submit,
 * so an author can save work in progress.
 */
import { createHash } from 'node:crypto';
import type { LocalisedText } from '@mathpath/db';
import { z } from 'zod';
const uuid = z.uuid();

const LOCALES = ['uz-Latn', 'ru', 'en'] as const;
export type ContentLocale = (typeof LOCALES)[number];

/** `{"uz-Latn": "...", "ru": "..."}`; plain text only (rendered as text, C-13). */
export const localisedText = z.partialRecord(z.enum(LOCALES), z.string().trim().max(4000));

export const ACTIVITIES = ['drag_drop', 'number_line', 'fraction_model', 'step_solver'] as const;

const videoStep = z
  .object({ type: z.literal('video'), mediaId: uuid, required: z.boolean().default(true) })
  .strict();
const activityStep = z
  .object({
    type: z.literal('activity'),
    activity: z.enum(ACTIVITIES),
    // Bounded JSON: activity settings are small; the cap stops a 10 MB blob.
    config: z
      .record(z.string().max(40), z.unknown())
      .refine((c) => JSON.stringify(c).length <= 8000, 'config is too large')
      .default({}),
    prompt: localisedText.default({}),
  })
  .strict();
const practiceStep = z
  .object({
    type: z.literal('practice'),
    minCorrect: z.number().int().min(1).max(50).default(6),
    prompt: localisedText.default({}),
  })
  .strict();
const masteryStep = z.object({ type: z.literal('mastery_test') }).strict();
const reviewStep = z.object({ type: z.literal('review') }).strict();

export const lessonStep = z.discriminatedUnion('type', [
  videoStep,
  activityStep,
  practiceStep,
  masteryStep,
  reviewStep,
]);
export type LessonStep = z.infer<typeof lessonStep>;

export const questionPool = z
  .object({
    practice: z.array(uuid).max(200).optional(),
    mastery: z.array(uuid).max(200).optional(),
    review: z.array(uuid).max(200).optional(),
  })
  .strict();

/** The `TopicVersionInput` schema (docs/api/openapi.yaml). */
export const topicVersionInput = z
  .object({
    title: localisedText,
    summary: localisedText.default({}),
    steps: z.array(lessonStep).max(10),
    questionPool: questionPool.default({}),
  })
  .strict();
export type TopicVersionInput = z.infer<typeof topicVersionInput>;

/**
 * Lists what keeps a version from going to review: missing translations in
 * the required locales, and a lesson without steps.
 * @returns Problem `errors` entries; empty when the version is complete.
 */
export function incompleteFields(
  version: { title: LocalisedText; summary: LocalisedText; steps: LessonStep[] },
  required: readonly string[],
): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  const check = (field: string, text: LocalisedText | undefined, optional = false) => {
    const filled = Object.values(text ?? {}).some((v) => v && v.trim());
    if (optional && !filled) return;
    for (const locale of required) {
      if (!text?.[locale as ContentLocale]?.trim()) {
        errors.push({ field, message: `missing ${locale} text` });
      }
    }
  };
  check('title', version.title);
  check('summary', version.summary, true);
  if (version.steps.length === 0) errors.push({ field: 'steps', message: 'a lesson needs steps' });
  version.steps.forEach((step, i) => {
    if ('prompt' in step) check(`steps/${i}/prompt`, step.prompt, true);
  });
  return errors;
}

/** Sorts object keys at every level, so equal content always hashes the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** SHA-256 of the canonical JSON of a version's content (schema doc: `content_hash`). */
export function contentHash(content: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(content)))
    .digest('hex');
}

/**
 * Picks the text for a reader: their locale, then the default, then any.
 * Missing text falls back instead of showing an empty label.
 */
export function pickText(text: LocalisedText, locale: string, fallback: string): string {
  return (
    text[locale as ContentLocale] ??
    text[fallback as ContentLocale] ??
    Object.values(text).find(Boolean) ??
    ''
  );
}
