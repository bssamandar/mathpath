/**
 * Types and pure helpers for practice and the mastery test (UX F4, S5, S6).
 * The shapes follow docs/api/openapi.yaml (Attempt, QuestionInstance,
 * AnswerFeedback, AttemptResult, TopicAssessmentStatus).
 */

export interface Attempt {
  id: string;
  type: 'practice' | 'mastery';
  topicId: string | null;
  status: 'in_progress' | 'submitted' | 'expired' | 'invalidated';
  itemCount: number;
  answeredCount: number;
}

export type AnswerResponse = { choiceIds: string[] } | { value: string };

export interface Feedback {
  accepted: boolean;
  correct: boolean | null;
  reason?: 'unreadable' | 'not_simplified' | 'form' | 'wrong';
  triesLeft?: number;
  hint?: string | null;
  solution?: string | null;
  correctAnswer?: string | null;
}

export interface QuestionInstance {
  position: number;
  stem: string;
  inputHint: 'number' | 'fraction' | 'single' | 'multiple';
  choices?: { id: string; label: string }[];
  previousResponse?: AnswerResponse;
  closed?: boolean;
  lastFeedback?: Feedback;
}

export interface AttemptResult {
  attemptId: string;
  score: number;
  maxScore: number;
  passed: boolean | null;
  review: {
    position: number;
    correct: boolean;
    stem: string;
    correctAnswer: string;
    solution: string | null;
  }[];
  recommendation?: { action: 'continue' | 'retry_practice'; topicId: string | null };
}

export interface TopicStatus {
  questionCount: number;
  practice: { correct: number; required: number; openAttemptId: string | null };
  mastery: {
    unlocked: boolean;
    openAttemptId: string | null;
    best: { score: number; maxScore: number; passed: boolean } | null;
  };
  dailyExercisesLeft: number | null;
}

/**
 * Splits text with inline LaTeX (`$...$`) into plain and math parts.
 * `\$` is a literal dollar sign. An unclosed `$` is kept as plain text.
 */
export function splitMath(text: string): { math: boolean; text: string }[] {
  const parts: { math: boolean; text: string }[] = [];
  let current = '';
  let math = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\\' && text[i + 1] === '$') {
      current += math ? '\\$' : '$';
      i += 1;
    } else if (char === '$') {
      if (current) parts.push({ math, text: current });
      current = '';
      math = !math;
    } else {
      current += char;
    }
  }
  if (math) {
    // No closing dollar: show what was typed instead of half a formula.
    const last = parts.at(-1);
    const rest = `$${current}`;
    if (last && !last.math) last.text += rest;
    else parts.push({ math: false, text: rest });
  } else if (current) {
    parts.push({ math: false, text: current });
  }
  return parts;
}

/** Keys of the on-screen number pad (UX S5): digits, comma, minus, fraction bar. */
export type PadKey =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | ','
  | '-'
  | '/'
  | 'back';

const MAX_INPUT = 24;

/**
 * The typed answer after one pad key. Keeps the value well-formed: one
 * minus at the start (the key toggles it), one fraction bar, one comma per
 * number, and a comma only after a digit.
 */
export function pressKey(value: string, key: PadKey): string {
  if (key === 'back') return value.slice(0, -1);
  if (key === '-') return value.startsWith('-') ? value.slice(1) : `-${value}`;
  if (value.length >= MAX_INPUT) return value;
  const part = value.split('/').at(-1)!;
  if (key === '/') return value.includes('/') || !/\d$/.test(value) ? value : `${value}/`;
  if (key === ',') return part.includes(',') || !/\d$/.test(value) ? value : `${value},`;
  return value + key;
}

/** True when there is something to check: a choice picked or a digit typed. */
export function canCheck(question: QuestionInstance, value: string, picked: string[]): boolean {
  if (question.inputHint === 'single' || question.inputHint === 'multiple') {
    return picked.length > 0;
  }
  return /\d/.test(value);
}

/** The request body for an answer. */
export function responseFor(
  question: QuestionInstance,
  value: string,
  picked: string[],
): AnswerResponse {
  return question.inputHint === 'single' || question.inputHint === 'multiple'
    ? { choiceIds: picked }
    : { value };
}

/** Whole percent, rounded down so 79.9% never shows as "80%". */
export function percent(score: number, max: number): number {
  return max > 0 ? Math.floor((score / max) * 100) : 0;
}
