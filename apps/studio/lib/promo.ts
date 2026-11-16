/** Promo code form model for the studio (API: POST /admin/promo-codes). */

export interface PromoCode {
  id: string;
  code: string;
  discountType: 'percent' | 'fixed';
  /** Percent, or tiyin for a fixed discount. */
  value: number;
  planCodes: string[] | null;
  maxRedemptions: number | null;
  perUserLimit: number;
  validFrom: string;
  validTo: string;
  isActive: boolean;
  redemptions: number;
}

/** What the form holds: text as typed, dates as YYYY-MM-DD, a fixed value in sum. */
export interface NewPromo {
  code: string;
  discountType: 'percent' | 'fixed';
  value: string;
  planCodes: string[];
  maxRedemptions: string;
  perUserLimit: string;
  validFrom: string;
  validTo: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** A blank form: valid from today for 30 days, once per parent. */
export function starterPromo(today: Date): NewPromo {
  return {
    code: '',
    discountType: 'percent',
    value: '',
    planCodes: [],
    maxRedemptions: '',
    perUserLimit: '1',
    validFrom: day(today),
    validTo: day(new Date(today.getTime() + 30 * 86_400_000)),
  };
}

const whole = (s: string) => /^\d+$/.test(s.trim());

/** Problems by field, in Uzbek, shown next to the field after the first submit. */
export function promoProblems(form: NewPromo): Partial<Record<keyof NewPromo, string>> {
  const out: Partial<Record<keyof NewPromo, string>> = {};
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(form.code.trim())) {
    out.code = '4–32 belgi: lotin harflari, raqamlar, - va _';
  }
  const value = Number(form.value);
  if (!whole(form.value) || value < 1) out.value = 'Musbat butun son kiriting';
  else if (form.discountType === 'percent' && value > 100) out.value = 'Foiz 100 dan oshmaydi';
  if (
    form.maxRedemptions.trim() !== '' &&
    (!whole(form.maxRedemptions) || Number(form.maxRedemptions) < 1)
  ) {
    out.maxRedemptions = 'Musbat butun son yoki bo‘sh';
  }
  if (!whole(form.perUserLimit) || Number(form.perUserLimit) < 1) {
    out.perUserLimit = 'Musbat butun son kiriting';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.validFrom)) out.validFrom = 'Sanani tanlang';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.validTo)) out.validTo = 'Sanani tanlang';
  else if (form.validTo <= form.validFrom) out.validTo = 'Boshlanishdan keyin bo‘lsin';
  return out;
}

/** The API body: Tashkent midnight for dates, a fixed discount converted to tiyin. */
export function promoInput(form: NewPromo) {
  const value = Number(form.value);
  return {
    code: form.code.trim().toUpperCase(),
    discountType: form.discountType,
    value: form.discountType === 'fixed' ? value * 100 : value,
    ...(form.planCodes.length ? { planCodes: form.planCodes } : {}),
    ...(form.maxRedemptions.trim() ? { maxRedemptions: Number(form.maxRedemptions) } : {}),
    perUserLimit: Number(form.perUserLimit),
    validFrom: `${form.validFrom}T00:00:00+05:00`,
    validTo: `${form.validTo}T00:00:00+05:00`,
  };
}

/** The Tashkent calendar day of an instant, as YYYY-MM-DD (codes start at Tashkent midnight). */
export function tashkentDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 5 * 3_600_000).toISOString().slice(0, 10);
}
