/**
 * Pure rules for building and marking attempts (UX F4, S5; config/learning.yaml).
 * Kept free of the database so they are cheap to test at the edges.
 */
import type { AppConfig } from '@mathpath/config';

export interface TemplateChoice {
  versionId: string;
  difficulty: number;
}

/**
 * Which template each position uses. Every template appears before any
 * repeats (so a set covers the topic), and the set runs easy to hard.
 * `shuffle` decides the order among templates of the same difficulty.
 */
export function planItems(
  templates: readonly TemplateChoice[],
  count: number,
  shuffle: <T>(items: T[]) => T[],
): TemplateChoice[] {
  if (templates.length === 0 || count <= 0) return [];
  const picked: TemplateChoice[] = [];
  while (picked.length < count) {
    picked.push(...shuffle([...templates]).slice(0, count - picked.length));
  }
  // Array.prototype.sort is stable, so the shuffle survives within a difficulty.
  return picked.sort((a, b) => a.difficulty - b.difficulty);
}

export interface PracticeStep {
  /** The item is finished: answered correctly or the solution was shown. */
  closed: boolean;
  /** Index of the hint to show now, if any. */
  hintIndex: number | null;
  showSolution: boolean;
  triesLeft: number;
}

/**
 * What practice shows after a marked answer: a hint after the first mistake,
 * the worked solution (and the item closes) after the configured number.
 * @param tries - Tries so far, including this one.
 */
export function practiceStep(
  correct: boolean,
  tries: number,
  hintCount: number,
  rules: AppConfig['learning']['practice'],
): PracticeStep {
  const { hintAfterMistakes, solutionAfterMistakes } = rules;
  if (correct) return { closed: true, hintIndex: null, showSolution: false, triesLeft: 0 };
  if (tries >= solutionAfterMistakes) {
    return { closed: true, hintIndex: null, showSolution: true, triesLeft: 0 };
  }
  const hintIndex =
    tries >= hintAfterMistakes && hintCount > 0
      ? Math.min(tries - hintAfterMistakes, hintCount - 1)
      : null;
  return {
    closed: false,
    hintIndex,
    showSolution: false,
    triesLeft: solutionAfterMistakes - tries,
  };
}

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

/** The calendar day in Tashkent (UTC+5, no daylight saving), `YYYY-MM-DD`. */
export function tashkentDay(now: Date): string {
  return new Date(now.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}
