import { describe, expect, it } from 'vitest';
import { check } from './answer';
import { Rational } from './rational';
import { seededRandom } from './random';
import {
  formatValue,
  generate,
  renderText,
  type TemplateBody,
  templateBody,
  TemplateError,
  validateTemplate,
} from './template';

/** The example from the schema document §4.2. */
const fractionAddition = templateBody.parse({
  variables: { d: { int: [2, 9] }, a: { int: [1, 'd-1'] }, b: { int: [1, 'd-1'] } },
  constraints: ['a + b != d'],
  stem: {
    'uz-Latn': 'Hisoblang: $\\frac{{a}}{{d}} + \\frac{{b}}{{d}}$',
    ru: 'Вычислите: $\\frac{{a}}{{d}} + \\frac{{b}}{{d}}$',
  },
  answer: { kind: 'fraction', expr: '(a+b)/d', accept: ['equivalent', 'mixed_number'] },
  hints: [{ 'uz-Latn': 'Maxrajlar bir xil: {d}.', ru: 'Знаменатели одинаковые.' }],
  solution: { 'uz-Latn': '$\\frac{{a}+{b}}{{d}}$' },
  distractors: ['(a+b)/(2*d)', 'a*b/d'],
});

describe('generate', () => {
  it('fills the stem, keeps the key on the server side, and repeats for a seed', () => {
    const item = generate('numeric', fractionAddition, 'seed-1');
    const { a, b, d } = item.params;
    expect(item.presented.stem['uz-Latn']).toBe(
      `Hisoblang: $\\frac{${a}}{${d}} + \\frac{${b}}{${d}}$`,
    );
    expect(item.presented.input).toBe('fraction');
    expect(JSON.stringify(item.presented)).not.toContain('(a+b)');
    expect(Number(a) + Number(b)).not.toBe(Number(d));
    const expected = Rational.of(BigInt(Number(a) + Number(b)), BigInt(d!));
    expect(item.answerKey).toMatchObject({ kind: 'fraction', value: expected.toString() });
    expect(generate('numeric', fractionAddition, 'seed-1')).toEqual(item);
    expect(check(item.answerKey, { value: `${Number(a) + Number(b)}/${d}` }).correct).toBe(true);
    expect(item.feedback.hints[0]!['uz-Latn']).toBe(`Maxrajlar bir xil: ${d}.`);
    expect(item.feedback.solution!['uz-Latn']).toBe(`$\\frac{${a}+${b}}{${d}}$`);
    expect(JSON.stringify(item.presented)).not.toContain('Maxrajlar');
  });

  it('varies with the seed', () => {
    const seen = new Set(
      Array.from({ length: 30 }, (_, i) =>
        JSON.stringify(generate('numeric', fractionAddition, `s${i}`).params),
      ),
    );
    expect(seen.size).toBeGreaterThan(15);
  });

  it('builds a shuffled single choice from distractors', () => {
    const body: TemplateBody = {
      ...fractionAddition,
      answer: { kind: 'choice', expr: '(a+b)/d', display: 'fraction' },
    };
    const item = generate('single_choice', body, 'x');
    expect(item.presented.input).toBe('single');
    expect(item.presented.choices!.length).toBeGreaterThanOrEqual(2);
    expect(item.answerKey).toEqual({ kind: 'choice', correct: [expect.any(String)] });
    const key = item.answerKey as { correct: string[] };
    const right = item.presented.choices!.find((c) => c.id === key.correct[0])!;
    const { a, b, d } = item.params;
    expect(right.text['uz-Latn']).toBe(
      `$${formatValue(Rational.of(BigInt(Number(a) + Number(b)), BigInt(d!)), true)}$`,
    );
    // Ids are positions, so they say nothing about the answer.
    expect(item.presented.choices!.map((c) => c.id)).toEqual(
      ['a', 'b', 'c'].slice(0, item.presented.choices!.length),
    );
  });

  it('shows decimal choices when asked', () => {
    const body = templateBody.parse({
      variables: { x: { choice: [1, 3, 5] } },
      stem: { 'uz-Latn': '{x}/4 = ?' },
      answer: { kind: 'choice', expr: 'x/4', display: 'number' },
      distractors: ['x/2', 'x/3'],
    });
    const item = generate('single_choice', body, 'k');
    const texts = item.presented.choices!.map((c) => c.text['uz-Latn']);
    expect(texts.some((t) => /^\$0\.\d+\$|^\$1\.25\$/.test(t!))).toBe(true);
    expect(texts.some((t) => t!.includes('\\frac'))).toBe(true); // x/3 does not end
  });

  it('serves listed options for single and multiple choice', () => {
    const body = templateBody.parse({
      stem: { 'uz-Latn': 'Qaysilari juft?' },
      answer: {
        kind: 'choices',
        options: [
          { text: { 'uz-Latn': '2' }, correct: true },
          { text: { 'uz-Latn': '3' }, correct: false },
          { text: { 'uz-Latn': '4' }, correct: true },
        ],
      },
    });
    const item = generate('multiple_choice', body, 'm');
    expect(item.presented.input).toBe('multiple');
    const key = item.answerKey as { correct: string[] };
    expect(key.correct).toHaveLength(2);
    const texts = key.correct.map(
      (id) => item.presented.choices!.find((c) => c.id === id)!.text['uz-Latn'],
    );
    expect(texts.sort()).toEqual(['2', '4']);
    expect(() => generate('single_choice', body, 'm')).toThrow('exactly one correct');
    expect(() => generate('numeric', body, 'm')).toThrow('choice type');
  });

  it('asks for decimals when a number answer does not end', () => {
    const body = templateBody.parse({
      variables: { n: { int: [1, 2] } },
      stem: { 'uz-Latn': '{n}/3' },
      answer: { kind: 'number', expr: 'n/3' },
    });
    expect(() => generate('numeric', body, 'z')).toThrow('decimals');
    const ok = generate(
      'numeric',
      { ...body, answer: { kind: 'number', expr: 'n/3', decimals: 2 } },
      'z',
    );
    expect(ok.answerKey).toMatchObject({ kind: 'number', decimals: 2 });
    expect(ok.presented.input).toBe('number');
  });

  it('reports broken templates by field', () => {
    const broken = (
      patch: Partial<TemplateBody>,
      type: 'numeric' | 'single_choice' = 'numeric',
    ) => {
      try {
        generate(type, { ...fractionAddition, ...patch }, 's');
        return null;
      } catch (error) {
        return error instanceof TemplateError ? error.field : 'other';
      }
    };
    expect(
      broken({ variables: { a: { int: [1, 'zz'] }, b: { int: [1, 2] }, d: { int: [3, 4] } } }),
    ).toBe('variables/a');
    expect(
      broken({ variables: { a: { int: [1, 'a'] }, b: { int: [1, 2] }, d: { int: [3, 4] } } }),
    ).toBe('variables/a');
    expect(
      broken({
        variables: { a: { int: [1, 'b'] }, b: { int: [1, 'd'] }, d: { int: [1, 'a + 3'] } },
      }),
    ).toBe('variables/a');
    expect(broken({ constraints: ['a +'] })).toBe('constraints/0');
    expect(broken({ constraints: ['a + 1'] })).toBe('constraints/0');
    expect(broken({ constraints: ['a > 100'] })).toBe('constraints');
    expect(
      broken({ answer: { kind: 'fraction', expr: 'a < b', accept: [], requireSimplified: false } }),
    ).toBe('answer/expr');
    expect(
      broken({ answer: { kind: 'fraction', expr: 'zz', accept: [], requireSimplified: false } }),
    ).toBe('answer/expr');
    expect(broken({}, 'single_choice')).toBe('answer/kind');
    expect(broken({ answer: { kind: 'choice', expr: 'a', display: 'number' } })).toBe(
      'answer/kind',
    );
    // A bound that divides by zero spoils every draw.
    expect(
      broken({
        variables: { a: { int: [1, '1/0'] }, b: { int: [1, 2] }, d: { int: [3, 4] } },
        constraints: [],
      }),
    ).toBe('constraints');
    expect(
      broken({ variables: { a: { int: ['1/2', 3] }, b: { int: [1, 2] }, d: { int: [3, 4] } } }),
    ).toBe('variables/a');
    expect(
      broken({ variables: { a: { int: [1, 'gcd(1)'] }, b: { int: [1, 2] }, d: { int: [3, 4] } } }),
    ).toBe('variables/a');
    expect(
      broken({ variables: { a: { int: [1, 3] }, b: { expr: 'a + nope(1)' }, d: { int: [3, 4] } } }),
    ).toBe('variables/b');
  });

  it('stops when generating takes too long', () => {
    const slow = templateBody.parse({ ...fractionAddition, constraints: ['a > 100'] });
    expect(() => generate('numeric', slow, 's', -1)).toThrow('longer than -1 ms');
  });

  it('draws again when every distractor equals the answer', () => {
    const body = templateBody.parse({
      variables: { a: { int: [0, 1] } },
      stem: { 'uz-Latn': '{a}' },
      answer: { kind: 'choice', expr: 'a', display: 'number' },
      distractors: ['a * a'],
    });
    // a = 0 and a = 1 both make a*a = a, so no draw works. A generous time
    // budget makes this test the attempt limit, not the 50 ms clock, which a
    // slow CI runner under coverage can hit first.
    expect(() => generate('single_choice', body, 'q', 60_000)).toThrow('constraints');
  });
});

describe('variable order', () => {
  it('works out the order from the expressions, not from the object', () => {
    const shuffled = templateBody.parse({
      ...fractionAddition,
      variables: { b: { int: [1, 'd-1'] }, a: { int: [1, 'd-1'] }, d: { int: [2, 9] } },
    });
    const item = generate('numeric', shuffled, 'order');
    expect(Number(item.params.a)).toBeLessThan(Number(item.params.d));
    expect(Number(item.params.b)).toBeLessThan(Number(item.params.d));
  });
});

describe('renderText', () => {
  const scope = new Map([
    ['a', Rational.of(3n)],
    ['h', Rational.of(-7n, 2n)],
  ]);
  it('fills placeholders and leaves other braces alone', () => {
    expect(renderText('$\\frac{{a}}{4}$ \\text{cm} {nope} {a+1}', scope)).toBe(
      '$\\frac{3}{4}$ \\text{cm} {nope} 4',
    );
    expect(renderText('{h} va ${h}$', scope)).toBe('-7/2 va $-\\frac{7}{2}$');
    expect(renderText('{1+1}', scope)).toBe('{1+1}');
    expect(formatValue(true, false)).toBe('true');
  });
});

describe('validateTemplate', () => {
  it('passes a good template and lists problems in a bad one', () => {
    expect(validateTemplate('numeric', fractionAddition).problems).toEqual([]);
    expect(
      validateTemplate('numeric', { stem: {}, answer: { kind: 'fraction' } }).problems[0]!.field,
    ).toBe('answer/expr');
    expect(
      validateTemplate('numeric', { ...fractionAddition, constraints: ['a > 50'] }).problems,
    ).toEqual([{ field: 'constraints', message: expect.stringContaining('no values') }]);
    expect(validateTemplate('numeric', { ...fractionAddition, extra: 1 }).problems[0]!.field).toBe(
      'body',
    );
  });
});

describe('seededRandom', () => {
  it('stays in range and shuffles every item once', () => {
    const random = seededRandom('r');
    for (let i = 0; i < 200; i++) {
      const n = random.int(-2, 2);
      expect(n).toBeGreaterThanOrEqual(-2);
      expect(n).toBeLessThanOrEqual(2);
    }
    expect(random.shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
  });
});
