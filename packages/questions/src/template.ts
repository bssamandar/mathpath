/**
 * Question templates (schema doc §3.4 and §4.2): the body of a
 * `question_template_versions` row, and how an item is generated from it.
 *
 * The body never leaves the server. A learner gets only `presented` (the stem
 * with the numbers filled in, and choices in their shuffled order); the
 * answer key stays in `attempt_items.answer_key` (C-16).
 */
import { z } from 'zod';
import { evaluate, ExpressionError, type Node, parse, type Value, variablesOf } from './expression';
import { seededRandom } from './random';
import { Rational } from './rational';

export const QUESTION_TYPES = ['numeric', 'single_choice', 'multiple_choice'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

const locales = ['uz-Latn', 'ru', 'en'] as const;
export type QuestionLocale = (typeof locales)[number];
const text = z.string().trim().min(1).max(2000);
export const localisedText = z.partialRecord(z.enum(locales), text);
export type LocalisedText = z.infer<typeof localisedText>;

const expr = z.string().trim().min(1).max(300);
const bound = z.union([z.number().int().min(-1e9).max(1e9), expr]);
const variableName = z.string().regex(/^[a-z][a-z0-9_]{0,15}$/);

const variableSpec = z.union([
  z.strictObject({ int: z.tuple([bound, bound]) }),
  z.strictObject({
    choice: z
      .array(z.union([z.number().int().min(-1e9).max(1e9), expr]))
      .min(1)
      .max(50),
  }),
  z.strictObject({ expr }),
]);

const answerSpec = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('number'),
    expr,
    /** Digits after the point a learner must give when the value does not end. */
    decimals: z.number().int().min(0).max(6).optional(),
  }),
  z.strictObject({
    kind: z.literal('fraction'),
    expr,
    accept: z
      .array(z.enum(['equivalent', 'mixed_number', 'decimal']))
      .max(3)
      .default(['equivalent']),
    requireSimplified: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal('choice'),
    expr,
    display: z.enum(['number', 'fraction']).default('fraction'),
  }),
  z.strictObject({
    kind: z.literal('choices'),
    options: z
      .array(z.strictObject({ text: localisedText, correct: z.boolean() }))
      .min(2)
      .max(8),
  }),
]);

export const templateBody = z.strictObject({
  variables: z.record(variableName, variableSpec).default({}),
  constraints: z.array(expr).max(20).default([]),
  stem: localisedText,
  answer: answerSpec,
  /** Wrong-answer expressions for a generated single choice. */
  distractors: z.array(expr).max(7).default([]),
  hints: z.array(localisedText).max(5).default([]),
  solution: localisedText.optional(),
});
export type TemplateBody = z.infer<typeof templateBody>;
export type AnswerSpec = TemplateBody['answer'];

/** What the server keeps to mark a response. Never sent to the client. */
export type AnswerKey =
  | { kind: 'number'; value: string; decimals?: number }
  | {
      kind: 'fraction';
      value: string;
      accept: ('equivalent' | 'mixed_number' | 'decimal')[];
      requireSimplified: boolean;
    }
  | { kind: 'choice'; correct: string[] };

/** What the learner sees. */
export interface Presented {
  stem: LocalisedText;
  /** `number` for a typed answer; choices for the other types. */
  input: 'number' | 'fraction' | 'single' | 'multiple';
  choices?: { id: string; text: LocalisedText }[];
}

export interface GeneratedItem {
  /** Variable values as text ("3", "7/2"), stored with the attempt item. */
  params: Record<string, string>;
  presented: Presented;
  answerKey: AnswerKey;
}

export class TemplateError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** Draws before giving up on the constraints (security plan C-17). */
const MAX_TRIES = 100;
const CHOICE_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

interface Compiled {
  variables: [string, { int: [Node, Node] } | { choice: Node[] } | { expr: Node }][];
  constraints: Node[];
  answer: Node | null;
  distractors: Node[];
}

const compileOne = (field: string, source: string | number): Node => {
  try {
    return parse(String(source));
  } catch (error) {
    throw new TemplateError(field, error instanceof Error ? error.message : 'invalid expression');
  }
};

/**
 * Parses every expression and orders the variables so each comes after the
 * ones it reads. Order is worked out, not taken from the object, because
 * PostgreSQL's jsonb does not keep key order.
 */
function compile(body: TemplateBody): Compiled {
  const declared = new Set(Object.keys(body.variables));
  const checkVars = (field: string, node: Node, known: ReadonlySet<string>) => {
    for (const name of variablesOf(node)) {
      if (!known.has(name)) throw new TemplateError(field, `"${name}" is not a variable`);
    }
    return node;
  };
  const parsed = new Map<string, { spec: Compiled['variables'][number][1]; reads: Set<string> }>();
  for (const [name, spec] of Object.entries(body.variables)) {
    const field = `variables/${name}`;
    const nodes =
      'int' in spec
        ? spec.int.map((b) => compileOne(field, b))
        : 'choice' in spec
          ? spec.choice.map((c) => compileOne(field, c))
          : [compileOne(field, spec.expr)];
    const reads = new Set<string>();
    for (const n of nodes) {
      checkVars(field, n, declared);
      variablesOf(n, reads);
    }
    if (reads.has(name)) throw new TemplateError(field, `"${name}" depends on itself`);
    const compiled: Compiled['variables'][number][1] =
      'int' in spec
        ? { int: [nodes[0]!, nodes[1]!] }
        : 'choice' in spec
          ? { choice: nodes }
          : { expr: nodes[0]! };
    parsed.set(name, { spec: compiled, reads });
  }
  // Kahn's algorithm, picking names alphabetically so the order is stable.
  const variables: Compiled['variables'] = [];
  const done = new Set<string>();
  while (done.size < parsed.size) {
    const ready = [...parsed.keys()]
      .filter((n) => !done.has(n) && [...parsed.get(n)!.reads].every((r) => done.has(r)))
      .sort();
    if (ready.length === 0) {
      const stuck = [...parsed.keys()].filter((n) => !done.has(n)).sort();
      throw new TemplateError(
        `variables/${stuck[0]}`,
        `variables depend on each other in a circle: ${stuck.join(', ')}`,
      );
    }
    for (const name of ready) {
      variables.push([name, parsed.get(name)!.spec]);
      done.add(name);
    }
  }
  return {
    variables,
    constraints: body.constraints.map((c, i) =>
      checkVars(`constraints/${i}`, compileOne(`constraints/${i}`, c), declared),
    ),
    answer:
      'expr' in body.answer
        ? checkVars('answer/expr', compileOne('answer/expr', body.answer.expr), declared)
        : null,
    distractors: body.distractors.map((d, i) =>
      checkVars(`distractors/${i}`, compileOne(`distractors/${i}`, d), declared),
    ),
  };
}

const asInt = (field: string, v: Value): number => {
  if (
    typeof v === 'boolean' ||
    !v.isInteger() ||
    v.num > 1_000_000_000n ||
    v.num < -1_000_000_000n
  ) {
    throw new TemplateError(field, 'a bound must be a whole number up to 10⁹');
  }
  return Number(v.num);
};

/** Formats a value for a stem: `\frac{7}{2}` inside $…$, "7/2" outside. */
export function formatValue(value: Value, inMath: boolean): string {
  if (typeof value === 'boolean') return String(value);
  if (value.isInteger()) return value.num.toString();
  if (!inMath) return value.toString();
  const sign = value.num < 0n ? '-' : '';
  const n = value.num < 0n ? -value.num : value.num;
  return `${sign}\\frac{${n}}{${value.den}}`;
}

/**
 * Fills `{expression}` placeholders. A brace group is replaced only when it
 * parses and reads only defined variables, so LaTeX such as `\text{cm}` is
 * left alone. `\frac{{a}}{{d}}` becomes `\frac{3}{7}`.
 */
export function renderText(template: string, scope: ReadonlyMap<string, Value>): string {
  return template.replace(/\{([^{}]{1,300})\}/g, (match, inner: string, offset: number) => {
    let node: Node;
    try {
      node = parse(inner);
    } catch {
      return match;
    }
    const names = variablesOf(node);
    if (names.size === 0 || [...names].some((n) => !scope.has(n))) return match;
    const inMath = (template.slice(0, offset).match(/(?<!\\)\$/g)?.length ?? 0) % 2 === 1;
    return formatValue(evaluate(node, scope), inMath);
  });
}

const renderLocalised = (t: LocalisedText, scope: ReadonlyMap<string, Value>): LocalisedText =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [k, renderText(v, scope)]));

/**
 * Generates one item from a template. The same seed always gives the same item.
 * @throws TemplateError when the template is broken or its constraints cannot be met.
 */
export function generate(
  type: QuestionType,
  body: TemplateBody,
  seed: string,
  budgetMs = 50,
): GeneratedItem {
  const startedAt = performance.now();
  const compiled = compile(body);
  const random = seededRandom(seed);
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    // Security plan C-17: one item may take at most 50 ms of server time.
    if (attempt > 0 && performance.now() - startedAt > budgetMs) {
      throw new TemplateError('constraints', `generating took longer than ${budgetMs} ms`);
    }
    const scope = new Map<string, Value>();
    try {
      for (const [name, spec] of compiled.variables) {
        const field = `variables/${name}`;
        if ('int' in spec) {
          const lo = asInt(field, evaluate(spec.int[0], scope));
          const hi = asInt(field, evaluate(spec.int[1], scope));
          if (lo > hi) throw new ExpressionError('empty range', 'ARITHMETIC');
          scope.set(name, Rational.of(BigInt(random.int(lo, hi))));
        } else if ('choice' in spec) {
          scope.set(name, evaluate(spec.choice[random.int(0, spec.choice.length - 1)]!, scope));
        } else {
          scope.set(name, evaluate(spec.expr, scope));
        }
      }
      if (!compiled.constraints.every((c, i) => mustBool(`constraints/${i}`, evaluate(c, scope)))) {
        continue;
      }
      const item = build(type, body, compiled, scope, random);
      if (!item) continue;
      return item;
    } catch (error) {
      // Division by zero and the like reject this draw; a broken template fails at once.
      if (error instanceof ExpressionError && error.code === 'ARITHMETIC') continue;
      if (error instanceof ExpressionError) throw new TemplateError('variables', error.message);
      throw error;
    }
  }
  throw new TemplateError('constraints', `no values met the constraints in ${MAX_TRIES} tries`);
}

const mustBool = (field: string, v: Value): boolean => {
  if (typeof v !== 'boolean') throw new TemplateError(field, 'a constraint must be true or false');
  return v;
};
const mustNumber = (field: string, v: Value): Rational => {
  if (typeof v === 'boolean') throw new TemplateError(field, 'the answer must be a number');
  return v;
};

function build(
  type: QuestionType,
  body: TemplateBody,
  compiled: Compiled,
  scope: Map<string, Value>,
  random: ReturnType<typeof seededRandom>,
): GeneratedItem | null {
  const params = Object.fromEntries([...scope].map(([k, v]) => [k, String(v)]));
  const stem = renderLocalised(body.stem, scope);
  const answer = body.answer;

  if (answer.kind === 'number' || answer.kind === 'fraction') {
    if (type !== 'numeric')
      throw new TemplateError('answer/kind', `${answer.kind} answers need the numeric type`);
    const value = mustNumber('answer/expr', evaluate(compiled.answer!, scope));
    if (answer.kind === 'number' && !value.isTerminating() && answer.decimals === undefined) {
      throw new TemplateError(
        'answer/decimals',
        'the answer does not end; set how many decimals to give',
      );
    }
    return {
      params,
      presented: { stem, input: answer.kind },
      answerKey:
        answer.kind === 'number'
          ? {
              kind: 'number',
              value: value.toString(),
              ...(answer.decimals === undefined ? {} : { decimals: answer.decimals }),
            }
          : {
              kind: 'fraction',
              value: value.toString(),
              accept: answer.accept,
              requireSimplified: answer.requireSimplified,
            },
    };
  }

  if (answer.kind === 'choice') {
    if (type !== 'single_choice')
      throw new TemplateError('answer/kind', 'a generated choice needs the single choice type');
    const correct = mustNumber('answer/expr', evaluate(compiled.answer!, scope));
    const values: Rational[] = [correct];
    for (const [i, d] of compiled.distractors.entries()) {
      const v = mustNumber(`distractors/${i}`, evaluate(d, scope));
      if (!values.some((x) => x.equals(v))) values.push(v);
    }
    if (values.length < 2) return null; // every distractor equalled the answer; draw again
    const shown = random.shuffle(values.map((v) => ({ v, correct: v === correct })));
    const choices = shown.map((c, i) => ({
      id: CHOICE_IDS[i]!,
      text: sameInAll(body.stem, choiceText(c.v, answer.display)),
    }));
    return {
      params,
      presented: { stem, input: 'single', choices },
      answerKey: {
        kind: 'choice',
        correct: shown.flatMap((c, i) => (c.correct ? [CHOICE_IDS[i]!] : [])),
      },
    };
  }

  const correctCount = answer.options.filter((o) => o.correct).length;
  if (type === 'numeric')
    throw new TemplateError('answer/kind', 'listed options need a choice type');
  if (type === 'single_choice' && correctCount !== 1) {
    throw new TemplateError('answer/options', 'a single choice needs exactly one correct option');
  }
  if (correctCount === 0)
    throw new TemplateError('answer/options', 'mark at least one option correct');
  const shown = random.shuffle(answer.options);
  return {
    params,
    presented: {
      stem,
      input: type === 'single_choice' ? 'single' : 'multiple',
      choices: shown.map((o, i) => ({ id: CHOICE_IDS[i]!, text: renderLocalised(o.text, scope) })),
    },
    answerKey: {
      kind: 'choice',
      correct: shown.flatMap((o, i) => (o.correct ? [CHOICE_IDS[i]!] : [])),
    },
  };
}

const choiceText = (v: Rational, display: 'number' | 'fraction') =>
  display === 'number' && v.isTerminating()
    ? `$${v.toDecimal(decimalsOf(v))}$`
    : `$${formatValue(v, true)}$`;

/** Digits after the point of a terminating value: max of its powers of 2 and 5. */
export const decimalsOf = (v: Rational): number => {
  let d = v.den;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    twos++;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives++;
  }
  return Math.max(twos, fives);
};

const sameInAll = (stem: LocalisedText, value: string): LocalisedText =>
  Object.fromEntries(Object.keys(stem).map((k) => [k, value]));

/**
 * Checks a template for authors: every expression parses, variables are
 * defined in order, and many seeds generate an item. @returns problems keyed by field.
 */
export function validateTemplate(
  type: QuestionType,
  raw: unknown,
  samples = 50,
): { body: TemplateBody | null; problems: { field: string; message: string }[] } {
  const parsed = templateBody.safeParse(raw);
  if (!parsed.success) {
    return {
      body: null,
      problems: parsed.error.issues.map((i) => ({
        field: i.path.join('/') || 'body',
        message: i.message,
      })),
    };
  }
  try {
    for (let i = 0; i < samples; i++) generate(type, parsed.data, `validate-${i}`);
  } catch (error) {
    if (error instanceof TemplateError) {
      return { body: parsed.data, problems: [{ field: error.field, message: error.message }] };
    }
    throw error;
  }
  return { body: parsed.data, problems: [] };
}
