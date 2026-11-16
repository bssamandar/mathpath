import { describe, expect, it } from 'vitest';
import {
  answerKindsFor,
  formProblems,
  type QuestionVersion,
  questionDraftOf,
  questionInput,
  sampleAnswer,
  sectionOf,
  splitValues,
  starterInput,
  withAnswerKind,
  withType,
} from './questions';

const version = (over: Partial<QuestionVersion> = {}): QuestionVersion => ({
  id: 'v1',
  versionNo: 1,
  status: 'draft',
  authorId: 'u1',
  updatedAt: '2026-11-16T00:00:00.000Z',
  publishedAt: null,
  templateId: 't1',
  topicId: 'topic',
  etag: '"1"',
  type: 'single_choice',
  difficulty: 3,
  skills: ['compare', 'fractions'],
  externalRef: 'Q-7',
  body: {
    variables: { n: { int: [2, 9] }, k: { int: [1, 'n - 1'] }, d: { choice: [2, 'max(n, 3)'] } },
    constraints: ['gcd(k, n) == 1'],
    stem: { 'uz-Latn': '$\\frac{{k}}{{n}}$ ni toping', ru: 'Найдите' },
    answer: { kind: 'choice', expr: 'k/n', display: 'fraction' },
    distractors: ['(k+1)/n', 'n/k'],
    hints: [{ 'uz-Latn': 'Surat', ru: 'Числитель' }],
    solution: { 'uz-Latn': 'Javob' },
  },
  reviews: [],
  ...over,
});

describe('questionDraftOf and questionInput', () => {
  it('round-trips a stored body through the form', () => {
    const v = version();
    const input = questionInput(questionDraftOf(v));
    expect(input).toEqual({
      type: 'single_choice',
      difficulty: 3,
      skills: ['compare', 'fractions'],
      externalRef: 'Q-7',
      body: v.body,
    });
  });

  it('keeps variable order and reads defaults for missing parts', () => {
    const draft = questionDraftOf(
      version({ type: 'numeric', externalRef: null, body: { stem: {}, answer: { kind: 'x' } } }),
    );
    expect(draft.variables).toEqual([]);
    expect(draft.answer).toEqual({ kind: 'number', expr: '', decimals: '' });
    expect(draft.externalRef).toBe('');
    expect(questionDraftOf(version()).variables.map((r) => r.name)).toEqual(['n', 'k', 'd']);
  });

  it('drops blank rows and texts so a half-typed form still saves', () => {
    const draft = questionDraftOf(version({ type: 'numeric' }));
    draft.answer = { kind: 'number', expr: ' a ', decimals: '2' };
    draft.variables.push({ name: ' ', kind: 'int', lo: '', hi: '', text: '' });
    draft.constraints.push('  ');
    draft.hints.push({ 'uz-Latn': ' ' });
    draft.solution = { ru: '' };
    draft.stem = { 'uz-Latn': ' Savol ', ru: '' };
    draft.skills = ' a,  b c ';
    const input = questionInput(draft);
    expect(input.body.variables).not.toHaveProperty(' ');
    expect(input.body.constraints).toEqual(['gcd(k, n) == 1']);
    expect(input.body.hints).toHaveLength(1);
    expect(input.body).not.toHaveProperty('solution');
    expect(input.body.stem).toEqual({ 'uz-Latn': 'Savol' });
    expect(input.body.answer).toEqual({ kind: 'number', expr: 'a', decimals: 2 });
    expect(input.body.distractors).toEqual([]);
    expect(input.skills).toEqual(['a', 'b', 'c']);
  });

  it('writes fraction and listed-option answers', () => {
    const draft = questionDraftOf(version());
    const fraction = questionInput(withType(draft, 'numeric'));
    expect(fraction.body.answer).toEqual({ kind: 'number', expr: 'k/n' });
    const asFraction = questionInput(withAnswerKind(withType(draft, 'numeric'), 'fraction'));
    expect(asFraction.body.answer).toEqual({
      kind: 'fraction',
      expr: 'k/n',
      accept: ['equivalent'],
      requireSimplified: false,
    });
    const listed = withType(draft, 'multiple_choice');
    expect(listed.answer.kind).toBe('choices');
    expect(questionInput(listed).body.answer).toEqual({
      kind: 'choices',
      options: [
        { text: {}, correct: true },
        { text: {}, correct: false },
      ],
    });
  });
});

describe('types and answer kinds', () => {
  it('offers only the kinds the engine accepts', () => {
    expect(answerKindsFor('numeric')).toEqual(['number', 'fraction']);
    expect(answerKindsFor('single_choice')).toEqual(['choice', 'choices']);
    expect(answerKindsFor('multiple_choice')).toEqual(['choices']);
  });

  it('keeps the answer when the new type allows it', () => {
    const draft = questionDraftOf(version());
    expect(withType(draft, 'single_choice').answer).toBe(draft.answer);
    expect(withAnswerKind(draft, 'choice')).toBe(draft);
  });

  it('starts every type with a body the API accepts', () => {
    expect(starterInput().body.answer).toEqual({ kind: 'number', expr: 'a' });
    expect(starterInput('single_choice').body.answer).toMatchObject({ kind: 'choice' });
    expect(starterInput('multiple_choice').body.answer).toMatchObject({ kind: 'choices' });
  });
});

describe('helpers', () => {
  it('splits values at top-level commas only', () => {
    expect(splitValues('2, max(a, b), , 7')).toEqual(['2', 'max(a, b)', '7']);
    expect(splitValues('')).toEqual([]);
  });

  it('finds bad and repeated variable names and a list without a right option', () => {
    const draft = questionDraftOf(version());
    draft.variables.push({ name: 'N', kind: 'expr', lo: '', hi: '', text: '1' });
    draft.variables.push({ name: 'n', kind: 'expr', lo: '', hi: '', text: '1' });
    expect(formProblems(draft)).toEqual({
      'variables/3/name': 'name',
      'variables/4/name': 'duplicate',
    });
    const listed = withType(draft, 'multiple_choice');
    if (listed.answer.kind !== 'choices') throw new Error('expected choices');
    listed.answer.options.forEach((o) => (o.correct = false));
    expect(formProblems(listed)).toMatchObject({ 'answer/options': 'noCorrect' });
  });

  it('maps API fields to form sections', () => {
    expect(sectionOf('body/answer/options/1/text')).toBe('answer');
    expect(sectionOf('constraints')).toBe('constraints');
    expect(sectionOf('')).toBe('body');
  });

  it('shows the right answer of a sample', () => {
    const instance = {
      stem: {},
      input: 'single' as const,
      choices: [
        { id: 'x', text: {} },
        { id: 'y', text: {} },
      ],
    };
    expect(sampleAnswer({ params: {}, instance, answer: { kind: 'choice', correct: ['y'] } })).toBe(
      'B',
    );
    expect(
      sampleAnswer({
        params: {},
        instance: { stem: {}, input: 'fraction' },
        answer: { kind: 'fraction', value: '3/4' },
      }),
    ).toBe('3/4');
  });
});
