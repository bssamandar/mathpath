/** Billing shapes from the API (docs/api/openapi.yaml, tag Billing) and their display helpers. */
import type { Locale } from './i18n';

export interface Money {
  amountTiyin: number;
  currency: 'UZS';
}

export interface Plan {
  code: string;
  interval: 'month' | 'year';
  price: Money;
  maxStudents: number;
  trialDays: number;
  features: string[];
}

export interface PlansResponse {
  items: Plan[];
  providers: ProviderCode[];
  trialDays: number;
}

export type ProviderCode = 'payme' | 'click';

export interface Subscription {
  id: string;
  planCode: string;
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  studentIds: string[];
}

export interface Child {
  id: string;
  firstName: string;
  nickname: string;
  plan: 'free' | 'trial' | 'paid';
}

export type PromoCheck =
  | { valid: true; amount: Money; discount: Money }
  | { valid: false; reason: string };

export interface Order {
  orderId: string;
  status: 'created' | 'pending' | 'paid' | 'cancelled' | 'expired';
  amount: Money;
  subscription?: Subscription;
}

/**
 * Number formats. Uzbek groups thousands with spaces like Russian, and
 * browsers' Uzbek data is incomplete, so it borrows the Russian number format.
 */
const NUMBER_TAGS: Record<Locale, string> = { 'uz-Latn': 'ru-RU', ru: 'ru-RU', en: 'en-GB' };
const DATE_TAGS: Record<Exclude<Locale, 'uz-Latn'>, string> = { ru: 'ru-RU', en: 'en-GB' };
const UZ_MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];

/** Sum with grouped thousands, without tiyin when there are none: 9 900 000 → "99 000". */
export function formatSum(amountTiyin: number, locale: Locale): string {
  return new Intl.NumberFormat(NUMBER_TAGS[locale], {
    minimumFractionDigits: amountTiyin % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amountTiyin / 100);
}

/** A date in the reader's language and Tashkent time, for "access until …". */
export function formatDate(iso: string, locale: Locale): string {
  if (locale === 'uz-Latn') {
    // Browsers render Uzbek dates as "2027 M11 16"; the usual form is "16-noyabr 2027".
    const tashkent = new Date(new Date(iso).getTime() + 5 * 3_600_000);
    return `${tashkent.getUTCDate()}-${UZ_MONTHS[tashkent.getUTCMonth()]} ${tashkent.getUTCFullYear()}`;
  }
  return new Intl.DateTimeFormat(DATE_TAGS[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Tashkent',
  }).format(new Date(iso));
}

/**
 * How much cheaper a yearly plan is than twelve months of the monthly plan
 * with the same number of children, in whole percent; null when there is no
 * such monthly plan or no saving.
 */
export function yearlySaving(plan: Plan, plans: Plan[]): number | null {
  if (plan.interval !== 'year') return null;
  const monthly = plans.find((p) => p.interval === 'month' && p.maxStudents === plan.maxStudents);
  if (!monthly) return null;
  const full = monthly.price.amountTiyin * 12;
  const saving = Math.floor(((full - plan.price.amountTiyin) / full) * 100);
  return saving > 0 ? saving : null;
}

/** The plan to pre-select (UX F7): the yearly plan for one child, else the first. */
export function defaultPlan(plans: Plan[]): Plan | undefined {
  return plans.find((p) => p.interval === 'year' && p.maxStudents === 1) ?? plans[0];
}

/** Subscriptions that still give access, newest end first. */
export function activeSubscriptions(items: Subscription[]): Subscription[] {
  return items.filter((s) => s.status === 'active' || s.status === 'trialing');
}

/** Where the payment return page finds the order, across the provider's redirect. */
export const LAST_ORDER_KEY = 'mathpath.lastOrder';

export function rememberOrder(orderId: string): void {
  try {
    sessionStorage.setItem(LAST_ORDER_KEY, orderId);
  } catch {
    // Private mode: the return page then asks the parent to open their plan page.
  }
}

export function lastOrder(): string | null {
  try {
    return sessionStorage.getItem(LAST_ORDER_KEY);
  } catch {
    return null;
  }
}
