import { describe, expect, it } from 'vitest';
import { hasReward, nameKey, percentOf } from './gamification';

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
});
