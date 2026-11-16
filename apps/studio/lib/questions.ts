/**
 * The question editor's model (UX S15, ADR-0011), kept free of React so it
 * can be tested alone. The form holds plain strings the author types; this
 * module turns a stored template body into the form and back into the
 * `QuestionTemplateInput` the API checks (docs/api/openapi.yaml).
 */
import type { LocalisedText, VersionSummary } from './editor';

export const QUESTION_TYPES = ['numeric', 'single_choice', 'multiple_choice'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export type AnswerKind = 'number' | 'fraction' | 'choice' | 'choices';
export const FRACTION_FORMS = ['equivalent', 'mixed_number', 'decimal'] as const;
export type FractionForm = (typeof FRACTION_FORMS)[number];

export type VariableKind = 'int' | 'choice' | 'expr';

/** One variable as the author types it; order matters (each may use the ones before). */
export interface VariableRow {
  name: string;
  kind: VariableKind;
  /** `int`: lower and upper bound (a number or an expression). */
  lo: string;
  hi: string;
  /** `choice`: values separated by commas; `expr`: the expression. */
  text: string;
}

export interface ChoiceOption {
  text: LocalisedText;
  correct: boolean;
}

export type AnswerForm =
  | { kind: 'number'; expr: string; decimals: string }
  | { kind: 'fraction'; expr: string; accept: FractionForm[]; requireSimplified: boolean }
  | { kind: 'choice'; expr: string; display: 'number' | 'fraction' }
  | { kind: 'choices'; options: ChoiceOption[] };

export interface QuestionDraft {
  type: QuestionType;
  difficulty: number;
  /** Comma-separated skill codes. */
  skills: string;
  externalRef: string;
  variables: VariableRow[];
  constraints: string[];
  stem: LocalisedText;
  answer: AnswerForm;
  distractors: string[];
  hints: LocalisedText[];
  solution: LocalisedText;
}

export interface QuestionVersion extends VersionSummary {
  templateId: string;
  topicId: string;
  etag: string;
  type: QuestionType;
  difficulty: number;
  skills: string[];
  externalRef: string | null;
  body: Record<string, unknown>;
  reviews: { reviewerId: string; decision: string; comments: unknown[]; createdAt: string }[];
}

export interface QuestionSummary {
  id: string;
  externalRef: string | null;
  publishedVersionId: string | null;
  latest: VersionSummary & { type: QuestionType; difficulty: number; stem: LocalisedText };
}

/** What `POST /studio/question-templates/preview` returns. */
export interface Preview {
  samples: {
    params: Record<string, string>;
    instance: {
      stem: LocalisedText;
      input: 'number' | 'fraction' | 'single' | 'multiple';
      choices?: { id: string; text: LocalisedText }[];
    };
    answer: { kind: 'number' | 'fraction'; value: string } | { kind: 'choice'; correct: string[] };
  }[];
  warnings: { field: string; message: string }[];
}

/** Which answer kinds fit a question type (the engine refuses the others). */
export function answerKindsFor(type: QuestionType): AnswerKind[] {
  if (type === 'numeric') return ['number', 'fraction'];
  if (type === 'single_choice') return ['choice', 'choices'];
  return ['choices'];
}

export function newAnswer(kind: AnswerKind, expr = ''): AnswerForm {
  switch (kind) {
    case 'number':
      return { kind, expr, decimals: '' };
    case 'fraction':
      return { kind, expr, accept: ['equivalent'], requireSimplified: false };
    case 'choice':
      return { kind, expr, display: 'fraction' };
    case 'choices':
      return {
        kind,
        options: [
          { text: {}, correct: true },
          { text: {}, correct: false },
        ],
      };
  }
}

/**
 * Changes the type and keeps as much of the answer as fits: the expression
 * survives a move between number, fraction and generated choice.
 */
export function withType(draft: QuestionDraft, type: QuestionType): QuestionDraft {
  const kinds = answerKindsFor(type);
  if (kinds.includes(draft.answer.kind)) return { ...draft, type };
  const expr = 'expr' in draft.answer ? draft.answer.expr : '';
  return { ...draft, type, answer: newAnswer(kinds[0]!, expr) };
}

export function withAnswerKind(draft: QuestionDraft, kind: AnswerKind): QuestionDraft {
  if (draft.answer.kind === kind) return draft;
  const expr = 'expr' in draft.answer ? draft.answer.expr : '';
  return { ...draft, answer: newAnswer(kind, expr) };
}

/** The first draft of a new question: one variable and its value as the answer. */
export function starterInput(type: QuestionType = 'numeric') {
  return {
    type,
    difficulty: 2,
    skills: [],
    body: {
      variables: { a: { int: [1, 9] } },
      constraints: [],
      stem: {},
      answer:
        type === 'numeric'
          ? { kind: 'number', expr: 'a' }
          : type === 'single_choice'
            ? { kind: 'choice', expr: 'a', display: 'number' }
            : {
                kind: 'choices',
                options: [
                  { text: { 'uz-Latn': '1', ru: '1' }, correct: true },
                  { text: { 'uz-Latn': '2', ru: '2' }, correct: false },
                ],
              },
    },
  };
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const textOf = (v: unknown): LocalisedText =>
  v && typeof v === 'object' ? { ...(v as LocalisedText) } : {};

/** A stored version as the form shows it. Unknown or missing parts get defaults. */
export function questionDraftOf(version: QuestionVersion): QuestionDraft {
  const body = version.body;
  const variables = Object.entries((body.variables ?? {}) as Record<string, unknown>).map(
    ([name, spec]): VariableRow => {
      const s = (spec ?? {}) as { int?: unknown[]; choice?: unknown[]; expr?: unknown };
      if (Array.isArray(s.int)) {
        return { name, kind: 'int', lo: str(s.int[0]), hi: str(s.int[1]), text: '' };
      }
      if (Array.isArray(s.choice)) {
        return { name, kind: 'choice', lo: '', hi: '', text: s.choice.map(str).join(', ') };
      }
      return { name, kind: 'expr', lo: '', hi: '', text: str(s.expr) };
    },
  );
  return {
    type: version.type,
    difficulty: version.difficulty,
    skills: version.skills.join(', '),
    externalRef: version.externalRef ?? '',
    variables,
    constraints: ((body.constraints ?? []) as unknown[]).map(str),
    stem: textOf(body.stem),
    answer: answerFormOf(body.answer, version.type),
    distractors: ((body.distractors ?? []) as unknown[]).map(str),
    hints: ((body.hints ?? []) as unknown[]).map(textOf),
    solution: textOf(body.solution),
  };
}

function answerFormOf(raw: unknown, type: QuestionType): AnswerForm {
  const a = (raw ?? {}) as Record<string, unknown>;
  switch (a.kind) {
    case 'number':
      return { kind: 'number', expr: str(a.expr), decimals: str(a.decimals) };
    case 'fraction':
      return {
        kind: 'fraction',
        expr: str(a.expr),
        accept: Array.isArray(a.accept) ? (a.accept as FractionForm[]) : ['equivalent'],
        requireSimplified: a.requireSimplified === true,
      };
    case 'choice':
      return {
        kind: 'choice',
        expr: str(a.expr),
        display: a.display === 'number' ? 'number' : 'fraction',
      };
    case 'choices':
      return {
        kind: 'choices',
        options: ((a.options ?? []) as { text?: unknown; correct?: unknown }[]).map((o) => ({
          text: textOf(o.text),
          correct: o.correct === true,
        })),
      };
    default:
      return newAnswer(answerKindsFor(type)[0]!);
  }
}

const INTEGER = /^-?\d{1,10}$/;

/** A whole number stays a number; anything else is sent as an expression. */
function numberOrExpr(text: string): number | string {
  const t = text.trim();
  return INTEGER.test(t) ? Number(t) : t;
}

/**
 * Splits at commas outside brackets, so `max(a, b), 3` gives two values.
 * Blank parts are dropped.
 */
export function splitValues(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((v) => v.trim()).filter(Boolean);
}

function cleanText(text: LocalisedText): LocalisedText {
  return Object.fromEntries(
    Object.entries(text)
      .map(([k, v]) => [k, v?.trim() ?? ''] as const)
      .filter(([, v]) => v),
  );
}

const isBlank = (text: LocalisedText) => Object.values(cleanText(text)).length === 0;

/**
 * The body for create and save. Blank rows and texts are dropped, so a half
 * typed form still saves; the engine's checks run on submit and in preview.
 */
export function questionInput(draft: QuestionDraft) {
  const variables: Record<string, unknown> = {};
  for (const v of draft.variables) {
    const name = v.name.trim();
    if (!name) continue;
    if (v.kind === 'int') variables[name] = { int: [numberOrExpr(v.lo), numberOrExpr(v.hi)] };
    else if (v.kind === 'choice')
      variables[name] = { choice: splitValues(v.text).map(numberOrExpr) };
    else variables[name] = { expr: v.text.trim() };
  }
  const a = draft.answer;
  const answer =
    a.kind === 'number'
      ? {
          kind: a.kind,
          expr: a.expr.trim(),
          ...(a.decimals.trim() ? { decimals: Number(a.decimals) } : {}),
        }
      : a.kind === 'fraction'
        ? {
            kind: a.kind,
            expr: a.expr.trim(),
            accept: a.accept,
            requireSimplified: a.requireSimplified,
          }
        : a.kind === 'choice'
          ? { kind: a.kind, expr: a.expr.trim(), display: a.display }
          : {
              kind: a.kind,
              options: a.options.map((o) => ({ text: cleanText(o.text), correct: o.correct })),
            };
  const skills = draft.skills
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    type: draft.type,
    difficulty: draft.difficulty,
    skills,
    ...(draft.externalRef.trim() ? { externalRef: draft.externalRef.trim() } : {}),
    body: {
      variables,
      constraints: draft.constraints.map((c) => c.trim()).filter(Boolean),
      stem: cleanText(draft.stem),
      answer,
      distractors:
        a.kind === 'choice' ? draft.distractors.map((d) => d.trim()).filter(Boolean) : [],
      hints: draft.hints.filter((h) => !isBlank(h)).map(cleanText),
      ...(isBlank(draft.solution) ? {} : { solution: cleanText(draft.solution) }),
    },
  };
}

const NAME = /^[a-z][a-z0-9_]{0,15}$/;

/**
 * Problems the form can see before asking the server: variable names the
 * engine would refuse, names used twice, and a list answer without a right
 * option. Keyed like the API's fields (`variables/0/name`).
 */
export function formProblems(
  draft: QuestionDraft,
): Record<string, 'name' | 'duplicate' | 'noCorrect'> {
  const out: Record<string, 'name' | 'duplicate' | 'noCorrect'> = {};
  const seen = new Set<string>();
  draft.variables.forEach((v, i) => {
    const name = v.name.trim();
    if (!name) return;
    if (!NAME.test(name)) out[`variables/${i}/name`] = 'name';
    else if (seen.has(name)) out[`variables/${i}/name`] = 'duplicate';
    seen.add(name);
  });
  if (draft.answer.kind === 'choices' && !draft.answer.options.some((o) => o.correct)) {
    out['answer/options'] = 'noCorrect';
  }
  return out;
}

/** The form section an API field belongs to (`body/answer/expr` → `answer`). */
export function sectionOf(field: string): string {
  const path = field.replace(/^body\//, '');
  return path.split('/')[0] || 'body';
}

/** The right answer of a preview sample as the learner would have to give it. */
export function sampleAnswer(sample: Preview['samples'][number]): string {
  const answer = sample.answer;
  if (answer.kind !== 'choice') return answer.value;
  const labels = 'ABCDEFGH';
  const ids = sample.instance.choices?.map((c) => c.id) ?? [];
  return answer.correct.map((id) => labels[ids.indexOf(id)] ?? id).join(', ');
}

/** Moves one list item up or down; the same helper as the lesson steps use. */
export { moveStep as moveItem, removeStep as removeItem } from './editor';
