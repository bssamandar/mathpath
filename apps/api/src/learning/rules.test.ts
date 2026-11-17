import { loadConfig } from '@mathpath/config';
import { describe, expect, it } from 'vitest';
import {
  buildPath,
  firstReview,
  nextReview,
  type PrerequisiteState,
  routeGap,
  topologicalOrder,
  weakness,
} from './rules';

const rules = loadConfig().learning;
const now = new Date('2026-11-16T10:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const mastered = (topicId: string, mastery = 0.9, at = daysAgo(3)): PrerequisiteState => ({
  topicId,
  state: 'mastered',
  mastery,
  masteredAt: at,
});

describe('weakness', () => {
  it('names why a prerequisite is weak', () => {
    expect(weakness(mastered('a'), rules, now)).toBeNull();
    expect(weakness({ ...mastered('a'), state: 'learning' }, rules, now)).toBe('not_mastered');
    expect(weakness({ ...mastered('a'), state: 'needs_review' }, rules, now)).toBe('needs_review');
    expect(weakness(mastered('a', 0.5), rules, now)).toBe('low_mastery');
    expect(weakness(mastered('a', 0.9, daysAgo(61)), rules, now)).toBe('stale');
  });
});

describe('routeGap', () => {
  const base = { topicId: 't', currentDepth: 0, detoursToday: 0, rules, now };

  it('retries practice when every prerequisite is fine', () => {
    expect(routeGap({ ...base, prerequisites: [mastered('a')] })).toEqual({
      action: 'retry_practice',
      topicId: 't',
      reason: 'no_weak_prerequisite',
    });
  });

  it('sends the learner to the weakest prerequisite', () => {
    const decision = routeGap({
      ...base,
      prerequisites: [mastered('a', 0.7), { ...mastered('b', 0.4), state: 'learning' }],
    });
    expect(decision).toEqual({
      action: 'prerequisite_review',
      topicId: 'b',
      reason: 'not_mastered',
      depth: 1,
    });
  });

  it('stops at the depth and per-day limits', () => {
    const weak = [{ ...mastered('a'), state: 'learning' as const }];
    expect(
      routeGap({ ...base, prerequisites: weak, currentDepth: rules.gapRouting.maxDepth }),
    ).toMatchObject({ action: 'take_break', reason: 'max_depth' });
    expect(
      routeGap({ ...base, prerequisites: weak, detoursToday: rules.gapRouting.maxDetoursPerDay }),
    ).toMatchObject({ action: 'take_break', reason: 'max_per_day' });
  });
});

describe('review scheduling (SM-2)', () => {
  it('walks the configured intervals, then grows by the ease', () => {
    let plan = firstReview(rules, now);
    expect(plan.intervalDays).toBe(rules.reviewIntervalsDays[0]);
    const seen = [plan.intervalDays];
    for (let i = 0; i < rules.reviewIntervalsDays.length + 1; i++) {
      plan = nextReview(
        { intervalDays: plan.intervalDays, ease: plan.ease, reviewCount: plan.reviewCount },
        true,
        rules,
        now,
      );
      seen.push(plan.intervalDays);
    }
    expect(seen.slice(0, rules.reviewIntervalsDays.length)).toEqual(rules.reviewIntervalsDays);
    const last = rules.reviewIntervalsDays.at(-1)!;
    expect(seen.at(-2)).toBe(Math.round(last * rules.review.initialEase));
    expect(plan.nextReviewAt.getTime()).toBe(now.getTime() + plan.intervalDays * 86_400_000);
  });

  it('starts again and lowers the ease after a failed review, never below 1.3', () => {
    const failed = nextReview({ intervalDays: 16, ease: 1.4, reviewCount: 3 }, false, rules, now);
    expect(failed).toMatchObject({
      intervalDays: rules.reviewIntervalsDays[0],
      ease: 1.3,
      reviewCount: 0,
    });
  });
});

describe('learning path', () => {
  it('orders prerequisites first, keeping course order for ties', () => {
    const edges = [
      { topicId: 'a', prerequisiteId: 'c' },
      { topicId: 'x', prerequisiteId: 'outside' },
    ];
    expect(topologicalOrder(['a', 'b', 'c'], edges)).toEqual(['b', 'c', 'a']);
  });

  it('puts due reviews first, skips mastered topics and places gaps before their topic', () => {
    const t = (
      topicId: string,
      state: PrerequisiteState['state'] = 'not_started',
      reviewDue = false,
    ) => ({
      topicId,
      state,
      reviewDue,
    });
    const path = buildPath(
      [t('a', 'mastered', true), t('b', 'learning'), t('c')],
      [{ topicId: 'c', prerequisiteId: 'b' }],
      [{ forTopicId: 'b', prerequisite: t('other', 'learning') }],
    );
    expect(path).toEqual([
      { topicId: 'a', reason: 'review_due', state: 'mastered' },
      { topicId: 'other', reason: 'prerequisite_gap', state: 'learning' },
      { topicId: 'b', reason: 'next_in_course', state: 'learning' },
      { topicId: 'c', reason: 'next_in_course', state: 'not_started' },
    ]);
  });
});
