/**
 * XP, level, streak, badges and daily quests (PRD §8; UX S3, S5, S6). The
 * shapes follow docs/api/openapi.yaml (GamificationSummary, Reward). Badge
 * and quest codes come from the server; their names are in the dictionaries.
 */
import type { MessageKey } from './i18n';

/** What one answer or submission earned. */
export interface Reward {
  xp: number;
  badges: string[];
  questsCompleted: { code: string; target: number }[];
}

export interface GamificationSummary {
  xpTotal: number;
  level: number;
  levelProgress: number;
  xpLeftToday: number;
  streak: { current: number; longest: number; freezesLeft: number; activeToday: boolean };
  badges: { code: string; awardedAt: string }[];
  quests: { code: string; progress: number; target: number; completed: boolean }[];
}

/** True when a reward has anything worth showing. */
export function hasReward(reward: Reward | null | undefined): reward is Reward {
  return (
    !!reward && (reward.xp > 0 || reward.badges.length > 0 || reward.questsCompleted.length > 0)
  );
}

/** The dictionary key for a badge or quest code, or null for a code this app does not know yet. */
export function nameKey(kind: 'badge' | 'quest', code: string, keys: readonly string[]) {
  const key = `${kind}.${code}`;
  return keys.includes(key) ? (key as MessageKey) : null;
}

/** Progress as a whole percentage between 0 and 100, for a bar. */
export function percentOf(progress: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((progress / target) * 100)));
}
