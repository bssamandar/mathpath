import { describe, expect, it } from 'vitest';
import { check, readNumber } from './answer';

describe('readNumber', () => {
  it('rejects long input before parsing it', () => {
    expect(readNumber(`1${' '.repeat(10_000)}x`)).toBeNull();
    expect(readNumber(`${' '.repeat(30)}3   /   4${' '.repeat(30)}`)).toMatchObject({
      form: 'fraction',
    });
  });

  it('reads the ways learners write numbers', () => {
    expect(readNumber(' 12 ')).toMatchObject({ form: 'integer' });
    expect(String(readNumber('2,5')!.value)).toBe('5/2');
    expect(readNumber('2.50')).toMatchObject({ form: 'decimal', places: 2 });
    expect(String(readNumber('−3/4')!.value)).toBe('-3/4');
    expect(readNumber('3 / 4')).toMatchObject({ form: 'fraction', simplified: true });
    expect(readNumber('2/4')).toMatchObject({ form: 'fraction', simplified: false });
    expect(readNumber('3/-4')).toMatchObject({ form: 'fraction', simplified: true });
    expect(String(readNumber('-1 2/3')!.value)).toBe('-5/3');
    expect(readNumber('1 2/4')).toMatchObject({ form: 'mixed', simplified: false });
  });

  it('refuses what it cannot read', () => {
    for (const bad of ['', 'abc', '1/0', '1 5/3', '1 1/0', '1e5', '1..2', '9'.repeat(41)]) {
      expect(readNumber(bad), bad).toBeNull();
    }
  });
});

describe('check', () => {
  const fraction = (over = {}) => ({
    kind: 'fraction' as const,
    value: '5/7',
    accept: ['equivalent' as const],
    requireSimplified: false,
    ...over,
  });

  it('accepts equivalent fractions unless simplest form is required', () => {
    expect(check(fraction(), { value: '10/14' })).toEqual({ correct: true });
    expect(check(fraction({ requireSimplified: true }), { value: '10/14' })).toEqual({
      correct: false,
      reason: 'not_simplified',
    });
    expect(check(fraction({ accept: [] }), { value: '10/14' }).reason).toBe('not_simplified');
    expect(check(fraction(), { value: '4/7' }).reason).toBe('wrong');
    expect(check(fraction(), { value: 'five' }).reason).toBe('unreadable');
  });

  it('applies the allowed forms', () => {
    const key = fraction({ value: '5/2' });
    expect(check(key, { value: '2,5' }).reason).toBe('form');
    expect(check({ ...key, accept: ['equivalent', 'decimal'] }, { value: '2,5' }).correct).toBe(
      true,
    );
    expect(check(key, { value: '2 1/2' }).reason).toBe('form');
    expect(check({ ...key, accept: ['mixed_number'] }, { value: '2 1/2' }).correct).toBe(true);
  });

  it('marks numbers, with rounding for values that do not end', () => {
    expect(check({ kind: 'number', value: '5/2' }, { value: '2.5' }).correct).toBe(true);
    expect(check({ kind: 'number', value: '5/2' }, { value: '5/2' }).correct).toBe(true);
    expect(check({ kind: 'number', value: '2/3', decimals: 2 }, { value: '0,67' }).correct).toBe(
      true,
    );
    expect(check({ kind: 'number', value: '2/3', decimals: 2 }, { value: '0.6' }).correct).toBe(
      false,
    );
    expect(check({ kind: 'number', value: '2/3', decimals: 2 }, { value: '0.66' }).correct).toBe(
      false,
    );
    expect(check({ kind: 'number', value: '3' }, { choices: ['a'] }).reason).toBe('unreadable');
  });

  it('marks choices as a set', () => {
    const key = { kind: 'choice' as const, correct: ['a', 'c'] };
    expect(check(key, { choices: ['c', 'a'] })).toEqual({ correct: true });
    expect(check(key, { choices: ['a', 'a', 'c'] }).correct).toBe(true);
    expect(check(key, { choices: ['a'] }).reason).toBe('wrong');
    expect(check(key, { value: 'a' }).reason).toBe('unreadable');
  });
});
