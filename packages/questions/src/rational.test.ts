import { describe, expect, it } from 'vitest';
import { Rational, RationalError } from './rational';

const r = (n: number, d = 1) => Rational.of(BigInt(n), BigInt(d));

describe('Rational', () => {
  it('keeps lowest terms with a positive denominator', () => {
    expect(r(2, 4).toString()).toBe('1/2');
    expect(r(3, -6).toString()).toBe('-1/2');
    expect(r(0, 5).toString()).toBe('0');
    expect(() => r(1, 0)).toThrow(RationalError);
  });

  it('adds without floating point error', () => {
    expect(Rational.parse('0.1')!.add(Rational.parse('0.2')!).equals(Rational.parse('0.3')!)).toBe(
      true,
    );
    expect(r(1, 3).add(r(1, 6)).toString()).toBe('1/2');
    expect(r(1, 2).sub(r(3, 4)).toString()).toBe('-1/4');
    expect(r(2, 3).mul(r(3, 4)).toString()).toBe('1/2');
    expect(r(1, 2).div(r(1, 4)).toString()).toBe('2');
    expect(() => r(1).div(r(0))).toThrow('DIVISION_BY_ZERO');
    expect(r(3, 4).neg().toString()).toBe('-3/4');
  });

  it('raises to whole powers only, within limits', () => {
    expect(r(2, 3).pow(r(2)).toString()).toBe('4/9');
    expect(r(2).pow(r(-2)).toString()).toBe('1/4');
    expect(() => r(2).pow(r(1, 2))).toThrow('NOT_INTEGER');
    expect(() => r(2).pow(r(65))).toThrow('TOO_LARGE');
    expect(() => r(10).pow(r(64))).toThrow('TOO_LARGE');
  });

  it('parses integers, decimals and fractions', () => {
    expect(Rational.parse('-3.25')!.toString()).toBe('-13/4');
    expect(Rational.parse('7/8')!.toString()).toBe('7/8');
    expect(Rational.parse('7/0')).toBeNull();
    expect(Rational.parse('abc')).toBeNull();
    expect(Rational.parse('1e5')).toBeNull();
  });

  it('compares, floors and rounds', () => {
    expect(r(1, 3).compare(r(1, 2))).toBe(-1);
    expect(r(1, 2).compare(r(2, 4))).toBe(0);
    expect(r(3).compare(r(2))).toBe(1);
    expect(r(-7, 2).floor().toString()).toBe('-4');
    expect(r(7, 2).floor().toString()).toBe('3');
    expect(r(-4).floor().toString()).toBe('-4');
    expect(r(2, 3).toDecimal(2)).toBe('0.67');
    expect(r(-1, 8).toDecimal(2)).toBe('-0.13');
    expect(r(5, 2).toDecimal(0)).toBe('3');
    expect(r(-1, 1000).toDecimal(1)).toBe('0.0');
    expect(r(1, 3).toNumber()).toBeCloseTo(0.3333);
  });

  it('knows which decimals end', () => {
    expect(r(3, 40).isTerminating()).toBe(true);
    expect(r(1, 3).isTerminating()).toBe(false);
    expect(r(4).isInteger()).toBe(true);
  });
});
