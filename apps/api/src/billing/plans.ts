/**
 * Plans and periods (config/billing.yaml; ADR-0008). Pure functions, so the
 * money and calendar rules can be tested without a database.
 */
import type { AppConfig } from '@mathpath/config';

export type BillingRules = AppConfig['billing'];
export type Plan = BillingRules['plans'][number];

/** What GET /plans returns for one plan (OpenAPI `Plan`). */
export interface PlanView {
  code: string;
  interval: 'month' | 'year';
  price: Money;
  maxStudents: number;
  trialDays: number;
  features: string[];
}

/** OpenAPI `Money`: integer tiyin, never floats. */
export interface Money {
  amountTiyin: number;
  currency: 'UZS';
}

export const money = (amountTiyin: number): Money => ({ amountTiyin, currency: 'UZS' });

/** Every paid plan opens all topics and lifts the free daily limit (PRD §6). */
const FEATURES = ['all_topics', 'unlimited_practice', 'parent_reports'];

export function planViews(rules: BillingRules): PlanView[] {
  return rules.plans.map((p) => ({
    code: p.code,
    interval: p.interval,
    price: money(p.priceTiyin),
    maxStudents: p.maxStudents,
    trialDays: rules.trialDays,
    features: p.maxStudents > 1 ? [...FEATURES, 'family'] : FEATURES,
  }));
}

export function findPlan(rules: BillingRules, code: string): Plan | undefined {
  return rules.plans.find((p) => p.code === code);
}

/**
 * The end of a billing period: the same day and time one month or year
 * later, clamped to the month's last day (31 January + 1 month = 28 or 29
 * February), so no period is ever shorter than the calendar says.
 */
export function periodEnd(start: Date, interval: 'month' | 'year'): Date {
  const months = interval === 'month' ? 1 : 12;
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(start.getUTCDate(), lastDay),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}
