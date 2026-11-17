import { describe, expect, it } from 'vitest';
import { canCheck, percent, pressKey, type QuestionInstance, responseFor } from './practice';

describe('pressKey', () => {
  const type = (keys: string) =>
    [...keys].reduce((v, k) => pressKey(v, (k === '<' ? 'back' : k) as never), '');

  it('builds fractions and decimals', () => {
    expect(type('3/4')).toBe('3/4');
    expect(type('2,5')).toBe('2,5');
    expect(type('12<3')).toBe('13');
  });

  it('keeps the value well-formed', () => {
    expect(type('/3')).toBe('3');
    expect(type('3//4')).toBe('3/4');
    expect(type(',5')).toBe('5');
    expect(type('2,,5')).toBe('2,5');
    expect(type('1,5/2,5')).toBe('1,5/2,5');
    expect(type('5-')).toBe('-5');
    expect(type('5--')).toBe('5');
    expect(type('1'.repeat(40))).toHaveLength(24);
  });
});

describe('answers', () => {
  const typed: QuestionInstance = { position: 1, stem: '', inputHint: 'fraction' };
  const choice: QuestionInstance = { position: 1, stem: '', inputHint: 'single' };

  it('enables Check only with something to check', () => {
    expect(canCheck(typed, '', [])).toBe(false);
    expect(canCheck(typed, '-', [])).toBe(false);
    expect(canCheck(typed, '3', [])).toBe(true);
    expect(canCheck(choice, '', [])).toBe(false);
    expect(canCheck(choice, '', ['a'])).toBe(true);
  });

  it('builds the request body for the type', () => {
    expect(responseFor(typed, '3/4', [])).toEqual({ value: '3/4' });
    expect(responseFor(choice, '', ['b'])).toEqual({ choiceIds: ['b'] });
  });

  it('rounds the percentage down', () => {
    expect(percent(7, 8)).toBe(87);
    expect(percent(0, 0)).toBe(0);
  });
});
