/**
 * Reading what a learner typed and marking it against the answer key.
 *
 * Learners in Uzbekistan write decimals with a comma ("2,5"), may use a
 * typographic minus, and write mixed numbers as "1 2/3". All of these are
 * accepted; a form the question does not allow is marked with a reason so
 * the screen can say why ("write it as a fraction").
 */
import { Rational } from './rational';
import type { AnswerKey } from './template';

export type NumberForm = 'integer' | 'decimal' | 'fraction' | 'mixed';

export interface ReadNumber {
  value: Rational;
  form: NumberForm;
  /** False for a fraction such as 2/4 that is not in lowest terms. */
  simplified: boolean;
  /** Digits after the point, for decimals. */
  places: number;
}

/** @returns null when the text is not a number we understand. */
export function readNumber(input: string): ReadNumber | null {
  const text = input
    .trim()
    .replace(/[−–]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/');
  if (text.length === 0 || text.length > 40) return null;

  const mixed = /^(-?)(\d{1,12}) (\d{1,12})\/(\d{1,12})$/.exec(text);
  if (mixed) {
    const [, sign, whole, n, d] = mixed;
    if (BigInt(d!) === 0n || BigInt(n!) >= BigInt(d!)) return null;
    const part = Rational.of(BigInt(n!), BigInt(d!));
    const value = Rational.of(BigInt(whole!)).add(part);
    return {
      value: sign ? value.neg() : value,
      form: 'mixed',
      simplified: part.num === BigInt(n!),
      places: 0,
    };
  }
  const fraction = /^(-?\d{1,12})\/(-?\d{1,12})$/.exec(text);
  if (fraction) {
    const n = BigInt(fraction[1]!);
    const d = BigInt(fraction[2]!);
    if (d === 0n) return null;
    const value = Rational.of(n, d);
    const simplified =
      (value.num === n && value.den === d) || (value.num === -n && value.den === -d);
    return { value, form: 'fraction', simplified, places: 0 };
  }
  const decimal = /^(-?\d{1,15})(?:[.,](\d{1,12}))?$/.exec(text);
  if (decimal) {
    const value = Rational.parse(`${decimal[1]}${decimal[2] ? `.${decimal[2]}` : ''}`)!;
    return {
      value,
      form: decimal[2] ? 'decimal' : 'integer',
      simplified: true,
      places: decimal[2]?.length ?? 0,
    };
  }
  return null;
}

export type Response = { value: string } | { choices: string[] };

export interface Mark {
  correct: boolean;
  /** Why a response was not accepted, when it is about the form rather than the value. */
  reason?: 'unreadable' | 'not_simplified' | 'form' | 'wrong';
}

/** Marks one response. Never throws on learner input. */
export function check(key: AnswerKey, response: Response): Mark {
  if (key.kind === 'choice') {
    if (!('choices' in response)) return { correct: false, reason: 'unreadable' };
    const given = [...new Set(response.choices)].sort();
    const want = [...key.correct].sort();
    const correct = given.length === want.length && given.every((c, i) => c === want[i]);
    return correct ? { correct } : { correct, reason: 'wrong' };
  }
  if (!('value' in response)) return { correct: false, reason: 'unreadable' };
  const read = readNumber(response.value);
  if (!read) return { correct: false, reason: 'unreadable' };
  const expected = Rational.parse(key.value)!;

  if (key.kind === 'number') {
    if (read.value.equals(expected)) return { correct: true };
    // A value that does not end is accepted when rounded to the asked number of places.
    if (
      key.decimals !== undefined &&
      read.form === 'decimal' &&
      read.places === key.decimals &&
      read.value.toDecimal(key.decimals) === expected.toDecimal(key.decimals)
    ) {
      return { correct: true };
    }
    return { correct: false, reason: 'wrong' };
  }

  if (!read.value.equals(expected)) return { correct: false, reason: 'wrong' };
  if (read.form === 'decimal' && !key.accept.includes('decimal'))
    return { correct: false, reason: 'form' };
  if (read.form === 'mixed' && !key.accept.includes('mixed_number'))
    return { correct: false, reason: 'form' };
  if (key.requireSimplified && !read.simplified)
    return { correct: false, reason: 'not_simplified' };
  if (!key.accept.includes('equivalent') && !read.simplified)
    return { correct: false, reason: 'not_simplified' };
  return { correct: true };
}
