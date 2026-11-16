import { describe, expect, it } from 'vitest';
import { promoInput, promoProblems, starterPromo, tashkentDay } from './promo';

describe('promo code form', () => {
  const today = new Date('2026-11-16T10:00:00Z');

  it('starts valid for 30 days and needs a code and a value', () => {
    const form = starterPromo(today);
    expect(form).toMatchObject({ validFrom: '2026-11-16', validTo: '2026-12-16' });
    expect(Object.keys(promoProblems(form)).sort()).toEqual(['code', 'value']);
  });

  it('checks percentages, limits and dates', () => {
    const form = { ...starterPromo(today), code: 'SPRING', value: '120' };
    expect(promoProblems(form).value).toBeDefined();
    expect(
      promoProblems({ ...form, value: '20', maxRedemptions: '0' }).maxRedemptions,
    ).toBeDefined();
    expect(promoProblems({ ...form, value: '20', validTo: '2026-11-16' }).validTo).toBeDefined();
    expect(promoProblems({ ...form, discountType: 'fixed', value: '120' })).toEqual({});
  });

  it('sends Tashkent dates and a fixed discount in tiyin', () => {
    const body = promoInput({
      ...starterPromo(today),
      code: ' spring ',
      discountType: 'fixed',
      value: '20000',
      planCodes: ['individual_monthly'],
    });
    expect(body).toEqual({
      code: 'SPRING',
      discountType: 'fixed',
      value: 2_000_000,
      planCodes: ['individual_monthly'],
      perUserLimit: 1,
      validFrom: '2026-11-16T00:00:00+05:00',
      validTo: '2026-12-16T00:00:00+05:00',
    });
  });

  it('shows the Tashkent day a code starts on', () => {
    expect(tashkentDay('2026-11-15T19:00:00.000Z')).toBe('2026-11-16');
  });
});
