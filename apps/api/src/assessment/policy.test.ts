import { describe, expect, it } from 'vitest';
import { planItems, practiceStep, tashkentDay } from './policy';

const rules = {
  hintAfterMistakes: 1,
  solutionAfterMistakes: 2,
  minCorrectBeforeMasteryTest: 6,
  itemsPerSet: 8,
};
const identity = <T>(items: T[]) => items;
const reverse = <T>(items: T[]) => [...items].reverse();

describe('planItems', () => {
  const templates = [
    { versionId: 'hard', difficulty: 3 },
    { versionId: 'easy', difficulty: 1 },
    { versionId: 'mid', difficulty: 2 },
  ];

  it('uses every template before repeating and runs easy to hard', () => {
    const plan = planItems(templates, 5, identity).map((p) => p.versionId);
    expect(plan).toEqual(['easy', 'easy', 'mid', 'hard', 'hard']);
    expect(new Set(planItems(templates, 3, reverse).map((p) => p.versionId)).size).toBe(3);
  });

  it('copes with fewer items than templates and with nothing to pick', () => {
    expect(planItems(templates, 2, identity)).toHaveLength(2);
    expect(planItems([], 5, identity)).toEqual([]);
    expect(planItems(templates, 0, identity)).toEqual([]);
  });
});

describe('practiceStep', () => {
  it('closes a right answer', () => {
    expect(practiceStep(true, 1, 2, rules)).toEqual({
      closed: true,
      hintIndex: null,
      showSolution: false,
      triesLeft: 0,
    });
  });

  it('gives a hint after the first mistake, the solution after the second', () => {
    expect(practiceStep(false, 1, 2, rules)).toMatchObject({
      closed: false,
      hintIndex: 0,
      triesLeft: 1,
    });
    expect(practiceStep(false, 2, 2, rules)).toMatchObject({ closed: true, showSolution: true });
  });

  it('has no hint when the template has none, and walks through several', () => {
    expect(practiceStep(false, 1, 0, rules).hintIndex).toBeNull();
    const longer = { ...rules, solutionAfterMistakes: 4 };
    expect(practiceStep(false, 2, 2, longer).hintIndex).toBe(1);
    expect(practiceStep(false, 3, 2, longer).hintIndex).toBe(1);
  });
});

describe('tashkentDay', () => {
  it('switches day at midnight in Tashkent (19:00 UTC)', () => {
    expect(tashkentDay(new Date('2026-11-15T18:59:00Z'))).toBe('2026-11-15');
    expect(tashkentDay(new Date('2026-11-15T19:00:00Z'))).toBe('2026-11-16');
  });
});
