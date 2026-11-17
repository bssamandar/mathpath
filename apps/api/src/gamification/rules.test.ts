import { describe, expect, it } from 'vitest';
import { advanceStreak, levelFor, type StreakState, visibleStreak, xpForLevel } from './rules';

const levels = { levelBase: 100, levelExponent: 1.5 };
const streak = { freezeEveryDays: 7, maxFreezes: 2 };
const start: StreakState = { current: 0, longest: 0, freezes: 0, lastActiveDay: null };

describe('levels', () => {
  it('follows the configured curve', () => {
    expect([1, 2, 3, 4, 5].map((l) => xpForLevel(l, levels))).toEqual([0, 100, 283, 520, 800]);
    expect(levelFor(0, levels)).toEqual({ level: 1, progress: 0 });
    expect(levelFor(99, levels).level).toBe(1);
    expect(levelFor(100, levels)).toEqual({ level: 2, progress: 0 });
    expect(levelFor(800, levels).level).toBe(5);
    expect(levelFor(191, levels).progress).toBeCloseTo(0.5, 1);
  });
});

describe('streaks', () => {
  const days = (from: StreakState, list: string[]) =>
    list.reduce((s, day) => advanceStreak(s, day, streak), from);

  it('counts consecutive days once each', () => {
    const s = days(start, ['2026-11-01', '2026-11-01', '2026-11-02', '2026-11-03']);
    expect(s).toMatchObject({ current: 3, longest: 3, lastActiveDay: '2026-11-03' });
  });

  it('starts again after a missed day without a freeze', () => {
    const s = days(start, ['2026-11-01', '2026-11-02', '2026-11-04']);
    expect(s).toMatchObject({ current: 1, longest: 2 });
  });

  it('earns a freeze every seven days and spends it on a missed day', () => {
    const week = Array.from({ length: 7 }, (_, i) => `2026-11-0${i + 1}`);
    const s = days(start, week);
    expect(s).toMatchObject({ current: 7, freezes: 1 });
    // 8 November missed: the freeze covers it.
    expect(visibleStreak(s, '2026-11-09')).toBe(7);
    const after = advanceStreak(s, '2026-11-09', streak);
    expect(after).toMatchObject({ current: 8, freezes: 0 });
    // Two missed days with no freeze left: the streak is gone.
    expect(visibleStreak(after, '2026-11-12')).toBe(0);
  });

  it('never holds more freezes than allowed', () => {
    const month = Array.from({ length: 28 }, (_, i) =>
      new Date(Date.UTC(2026, 10, i + 1)).toISOString().slice(0, 10),
    );
    expect(days(start, month).freezes).toBe(2);
  });

  it('ignores a day earlier than the last active day', () => {
    const s = days(start, ['2026-11-05']);
    expect(advanceStreak(s, '2026-11-04', streak)).toEqual(s);
  });
});
