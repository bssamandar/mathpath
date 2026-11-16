import { describe, expect, it } from 'vitest';
import { splitMath } from './math';

describe('splitMath', () => {
  it('splits plain text and inline formulas', () => {
    expect(splitMath('Hisoblang: $\\frac{1}{2}$ + 1')).toEqual([
      { math: false, text: 'Hisoblang: ' },
      { math: true, text: '\\frac{1}{2}' },
      { math: false, text: ' + 1' },
    ]);
  });

  it('keeps escaped dollars and an unclosed formula as text', () => {
    expect(splitMath('narxi 5\\$')).toEqual([{ math: false, text: 'narxi 5$' }]);
    expect(splitMath('a $b')).toEqual([{ math: false, text: 'a $b' }]);
    expect(splitMath('$x$ va $y')).toEqual([
      { math: true, text: 'x' },
      { math: false, text: ' va $y' },
    ]);
  });
});
