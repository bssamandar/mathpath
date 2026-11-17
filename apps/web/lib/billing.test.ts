import { describe, expect, it } from 'vitest';
import { defaultPlan, formatDate, formatSum, type Plan, yearlySaving } from './billing';

const plan = (code: string, interval: 'month' | 'year', sum: number, maxStudents = 1): Plan => ({
  code,
  interval,
  price: { amountTiyin: sum * 100, currency: 'UZS' },
  maxStudents,
  trialDays: 7,
  features: [],
});

const plans = [
  plan('individual_monthly', 'month', 99_000),
  plan('individual_annual', 'year', 899_000),
  plan('family_annual', 'year', 1_499_000, 4),
];

describe('billing display', () => {
  it('formats sum with grouped thousands and keeps tiyin only when present', () => {
    expect(formatSum(9_900_000, 'en')).toBe('99,000');
    expect(formatSum(9_900_050, 'en')).toBe('99,000.50');
    expect(formatSum(9_900_000, 'ru').replace(/\s/g, ' ')).toBe('99 000');
    expect(formatSum(9_900_000, 'uz-Latn').replace(/\s/g, ' ')).toBe('99 000');
  });

  it('writes Uzbek dates in the usual form, in Tashkent time', () => {
    expect(formatDate('2027-11-15T20:30:00Z', 'uz-Latn')).toBe('16-noyabr 2027');
    expect(formatDate('2027-11-15T20:30:00Z', 'en')).toBe('16 November 2027');
  });

  it('shows the yearly saving against twelve monthly payments', () => {
    expect(yearlySaving(plans[1]!, plans)).toBe(24);
    expect(yearlySaving(plans[0]!, plans)).toBeNull();
    // No monthly family plan to compare with.
    expect(yearlySaving(plans[2]!, plans)).toBeNull();
  });

  it('pre-selects the yearly plan for one child', () => {
    expect(defaultPlan(plans)?.code).toBe('individual_annual');
    expect(defaultPlan([plans[0]!])?.code).toBe('individual_monthly');
  });
});
