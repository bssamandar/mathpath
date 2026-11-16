import { describe, expect, it } from 'vitest';
import { daysLeft, hasReward, nameKey, percentOf, zoneOf } from './gamification';

describe('gamification helpers', () => {
  it('shows a reward only when something was earned', () => {
    expect(hasReward(undefined)).toBe(false);
    expect(hasReward({ xp: 0, badges: [], questsCompleted: [] })).toBe(false);
    expect(hasReward({ xp: 10, badges: [], questsCompleted: [] })).toBe(true);
    expect(hasReward({ xp: 0, badges: ['streak_3'], questsCompleted: [] })).toBe(true);
    expect(hasReward({ xp: 0, badges: [], questsCompleted: [{ code: 'xp_50', target: 50 }] })).toBe(
      true,
    );
  });

  it('names known codes and skips unknown ones', () => {
    const keys = ['badge.first_correct', 'quest.correct_5'];
    expect(nameKey('badge', 'first_correct', keys)).toBe('badge.first_correct');
    expect(nameKey('quest', 'correct_5', keys)).toBe('quest.correct_5');
    expect(nameKey('badge', 'from_the_future', keys)).toBeNull();
  });

  it('clamps progress to a percentage', () => {
    expect(percentOf(3, 5)).toBe(60);
    expect(percentOf(9, 5)).toBe(100);
    expect(percentOf(1, 0)).toBe(0);
  });

  it('counts the days left in the week', () => {
    const now = new Date('2026-11-20T10:00:00Z');
    expect(daysLeft('2026-11-22T19:00:00Z', now)).toBe(3);
    expect(daysLeft('2026-11-20T11:00:00Z', now)).toBe(1);
    expect(daysLeft('2026-11-19T19:00:00Z', now)).toBe(0);
  });

  it('marks the promotion and demotion zones', () => {
    const zones = { up: 2, down: 2 };
    expect([1, 2, 3, 10, 11, 12].map((rank) => zoneOf(rank, 12, zones))).toEqual([
      'up',
      'up',
      null,
      null,
      'down',
      'down',
    ]);
    expect(zoneOf(1, 1, { up: 0, down: 0 })).toBeNull();
  });
});
