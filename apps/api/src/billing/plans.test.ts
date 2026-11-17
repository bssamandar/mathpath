import { loadConfig } from '@mathpath/config';
import { describe, expect, it } from 'vitest';
import { findPlan, periodEnd, planViews } from './plans';

describe('periodEnd', () => {
  it('adds a calendar month or year at the same time of day', () => {
    expect(periodEnd(new Date('2026-11-16T09:30:00Z'), 'month').toISOString()).toBe(
      '2026-12-16T09:30:00.000Z',
    );
    expect(periodEnd(new Date('2026-12-20T00:00:00Z'), 'month').toISOString()).toBe(
      '2027-01-20T00:00:00.000Z',
    );
    expect(periodEnd(new Date('2026-11-16T09:30:00Z'), 'year').toISOString()).toBe(
      '2027-11-16T09:30:00.000Z',
    );
  });

  it('clamps to the last day of a shorter month', () => {
    expect(periodEnd(new Date('2027-01-31T10:00:00Z'), 'month').toISOString()).toBe(
      '2027-02-28T10:00:00.000Z',
    );
    expect(periodEnd(new Date('2028-01-31T10:00:00Z'), 'month').toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    );
    expect(periodEnd(new Date('2028-02-29T10:00:00Z'), 'year').toISOString()).toBe(
      '2029-02-28T10:00:00.000Z',
    );
  });
});

describe('plans', () => {
  const rules = loadConfig().billing;

  it('shows every plan with its price in tiyin and marks family plans', () => {
    const views = planViews(rules);
    expect(views.map((p) => p.code)).toEqual(rules.plans.map((p) => p.code));
    const family = views.find((p) => p.maxStudents > 1);
    expect(family?.features).toContain('family');
    expect(Number.isInteger(views[0]!.price.amountTiyin)).toBe(true);
  });

  it('finds plans by code only', () => {
    expect(findPlan(rules, 'individual_monthly')?.interval).toBe('month');
    expect(findPlan(rules, 'nope')).toBeUndefined();
  });
});
