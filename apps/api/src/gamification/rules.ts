/**
 * Pure gamification rules (PRD §8, config/gamification.yaml): levels,
 * streaks with earned freezes, and the badge catalogue. The service applies
 * them to the database; keeping them here makes the edge cases testable.
 */
import type { AppConfig } from '@mathpath/config';

export type GamificationRules = AppConfig['gamification'];

/**
 * Level 1 starts at 0 XP; level n (n ≥ 2) needs levelBase · (n − 1)^levelExponent
 * total XP. With 100 and 1.5: 100, 283, 520, 800 … XP for levels 2, 3, 4, 5.
 */
export function xpForLevel(level: number, rules: GamificationRules['levels']): number {
  return level <= 1 ? 0 : Math.round(rules.levelBase * (level - 1) ** rules.levelExponent);
}

export function levelFor(
  xpTotal: number,
  rules: GamificationRules['levels'],
): { level: number; progress: number } {
  let level = 1;
  while (xpForLevel(level + 1, rules) <= xpTotal) level += 1;
  const from = xpForLevel(level, rules);
  const to = xpForLevel(level + 1, rules);
  return { level, progress: Math.min(1, Math.max(0, (xpTotal - from) / (to - from))) };
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export interface StreakState {
  current: number;
  longest: number;
  freezes: number;
  lastActiveDay: string | null;
}

/**
 * The streak after learning on `today`. Each missed day uses one freeze;
 * with too few freezes the streak starts again at 1. A freeze is earned on
 * every `freezeEveryDays`-th streak day, up to `maxFreezes`. Freezes are
 * never bought (PRD §8: no paid streak repair).
 */
export function advanceStreak(
  state: StreakState,
  today: string,
  rules: GamificationRules['streak'],
): StreakState {
  if (state.lastActiveDay === today) return state;
  const missed =
    state.lastActiveDay === null ? Infinity : daysBetween(state.lastActiveDay, today) - 1;
  let { current, freezes } = state;
  if (missed < 0) return state; // a clock that went back: change nothing
  if (missed === 0) current += 1;
  else if (missed <= freezes) {
    freezes -= missed;
    current += 1;
  } else current = 1;
  if (current % rules.freezeEveryDays === 0) freezes = Math.min(rules.maxFreezes, freezes + 1);
  return { current, longest: Math.max(state.longest, current), freezes, lastActiveDay: today };
}

/**
 * The streak to show on `today` before any learning today: still alive while
 * the missed days (not counting today) can be covered by freezes.
 */
export function visibleStreak(state: StreakState, today: string): number {
  if (state.lastActiveDay === null) return 0;
  const missed = daysBetween(state.lastActiveDay, today) - 1;
  return missed <= state.freezes ? state.current : 0;
}

export interface BadgeFacts {
  firstTryCorrect: number;
  masteries: number;
  questsCompleted: number;
  longestStreak: number;
  level: number;
}

/** The badge catalogue. Codes are stable: the web app translates them. */
export const BADGES: readonly { code: string; earned(f: BadgeFacts): boolean }[] = [
  { code: 'first_correct', earned: (f) => f.firstTryCorrect >= 1 },
  { code: 'streak_3', earned: (f) => f.longestStreak >= 3 },
  { code: 'streak_7', earned: (f) => f.longestStreak >= 7 },
  { code: 'streak_30', earned: (f) => f.longestStreak >= 30 },
  { code: 'mastery_1', earned: (f) => f.masteries >= 1 },
  { code: 'mastery_5', earned: (f) => f.masteries >= 5 },
  { code: 'mastery_10', earned: (f) => f.masteries >= 10 },
  { code: 'level_5', earned: (f) => f.level >= 5 },
  { code: 'level_10', earned: (f) => f.level >= 10 },
  { code: 'quests_10', earned: (f) => f.questsCompleted >= 10 },
];
