import { describe, expect, it } from 'vitest';
import { calc, ExpressionError, MAX_DEPTH, parse, variablesOf } from './expression';
import { Rational } from './rational';

const s = (text: string, vars = {}) => String(calc(text, vars));

describe('expressions', () => {
  it('follows the usual precedence', () => {
    expect(s('1 + 2 * 3')).toBe('7');
    expect(s('(1 + 2) * 3')).toBe('9');
    expect(s('2 ^ 3 ^ 2')).toBe('512');
    expect(s('-2 ^ 2')).toBe('-4');
    expect(s('10 - 4 - 3')).toBe('3');
    expect(s('1 / 3 + 1 / 6')).toBe('1/2');
    expect(s('0.1 + 0.2 == 0.3')).toBe('true');
  });

  it('reads variables, comparisons and logic', () => {
    expect(s('a + b != d', { a: 2, b: 3, d: 5 })).toBe('false');
    expect(s('a < b && b <= 3 || !(a >= 1)', { a: 1, b: 3 })).toBe('true');
    expect(s('a > b || a == b', { a: 1, b: 3 })).toBe('false');
    expect(s('true_flag == (1 < 2)', { true_flag: true })).toBe('true');
  });

  it('offers a fixed set of functions', () => {
    expect(s('gcd(12, 18) + lcm(4, 6)')).toBe('18');
    expect(s('lcm(0, 5)')).toBe('0');
    expect(s('min(3, 1, 2) * max(3, 1, 2)')).toBe('3');
    expect(s('abs(-5) + abs(5)')).toBe('10');
    expect(s('floor(7/2) + ceil(7/2) + round(5/2)')).toBe('10');
    expect(s('mod(-1, 3) + mod(7, 3)')).toBe('3');
    expect(s('numerator(6/8) * 10 + denominator(6/8)')).toBe('34');
  });

  it('refuses anything outside the language', () => {
    for (const bad of [
      'constructor(1)',
      'process.exit()',
      'a[0]',
      '"text"',
      'x = 1',
      '1 +',
      '(1',
      '1 2',
      'gcd(1)',
      'max()',
      '@',
    ]) {
      expect(() => calc(bad, { a: 1 }), bad).toThrow(ExpressionError);
    }
    expect(() => calc('toString + 1')).toThrow('unknown variable toString');
    expect(() => calc('__proto__')).toThrow('unknown variable');
  });

  it('caps length, depth and size', () => {
    expect(() => parse('1+'.repeat(200) + '1')).toThrow('longer than');
    expect(() => parse('('.repeat(MAX_DEPTH + 2) + '1' + ')'.repeat(MAX_DEPTH + 2))).toThrow(
      'nested too deeply',
    );
    expect(() => calc('10 ^ 64')).toThrow(ExpressionError);
    expect(() => calc('1 / 0')).toThrow(ExpressionError);
    expect(() => calc('mod(1, 0)')).toThrow('mod by zero');
  });

  it('checks types', () => {
    expect(() => calc('1 + (1 < 2)')).toThrow('needs a number');
    expect(() => calc('!1')).toThrow('needs true or false');
    expect(() => calc('1 && 2')).toThrow('needs true or false');
    expect(() => calc('1 || 2')).toThrow('needs true or false');
    expect(() => calc('gcd(1/2, 2)')).toThrow('whole number');
  });

  it('lists the variables an expression reads', () => {
    expect([...variablesOf(parse('a + gcd(b, -c) * (d > 1 || !e)'))].sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('accepts Rational values in scope', () => {
    expect(String(calc('x * 2', { x: Rational.of(1n, 4n) }))).toBe('1/2');
  });
});
