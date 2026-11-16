/**
 * The expression language of question templates (schema doc §4.2).
 *
 * A small hand-written parser over exact rationals instead of a general
 * library: authors get arithmetic, comparisons, logic and a fixed list of
 * functions, and nothing else. There is no property access, no assignment, no
 * strings and no way to reach JavaScript, and length, depth and number size
 * are capped so one template cannot slow the server down.
 */
import { Rational, RationalError } from './rational';

export type Value = Rational | boolean;

export type Node =
  | { kind: 'num'; value: Rational }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; op: '-' | '!'; arg: Node }
  | { kind: 'binary'; op: BinaryOp; left: Node; right: Node }
  | { kind: 'call'; name: FunctionName; args: Node[] };

type BinaryOp = '+' | '-' | '*' | '/' | '^' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';

export const MAX_LENGTH = 300;
export const MAX_DEPTH = 32;

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'SYNTAX'
      | 'TOO_LONG'
      | 'TOO_DEEP'
      | 'UNKNOWN_VARIABLE'
      | 'UNKNOWN_FUNCTION'
      | 'TYPE'
      | 'ARITHMETIC',
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

const num = (v: Value, where: string): Rational => {
  if (typeof v === 'boolean') throw new ExpressionError(`${where} needs a number`, 'TYPE');
  return v;
};
const bool = (v: Value, where: string): boolean => {
  if (typeof v !== 'boolean') throw new ExpressionError(`${where} needs true or false`, 'TYPE');
  return v;
};
const int = (v: Value, where: string): bigint => {
  const n = num(v, where);
  if (!n.isInteger()) throw new ExpressionError(`${where} needs a whole number`, 'TYPE');
  return n.num;
};
const gcdBig = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};

/** The only functions a template can call. */
const FUNCTIONS = {
  abs: {
    arity: [1, 1],
    fn: ([x]: Value[]) => (num(x!, 'abs').num < 0n ? num(x!, 'abs').neg() : x!),
  },
  floor: { arity: [1, 1], fn: ([x]: Value[]) => num(x!, 'floor').floor() },
  ceil: { arity: [1, 1], fn: ([x]: Value[]) => num(x!, 'ceil').neg().floor().neg() },
  round: {
    arity: [1, 1],
    fn: ([x]: Value[]) => Rational.parse(num(x!, 'round').toDecimal(0))!,
  },
  min: {
    arity: [1, 10],
    fn: (xs: Value[]) => xs.map((x) => num(x, 'min')).reduce((a, b) => (b.compare(a) < 0 ? b : a)),
  },
  max: {
    arity: [1, 10],
    fn: (xs: Value[]) => xs.map((x) => num(x, 'max')).reduce((a, b) => (b.compare(a) > 0 ? b : a)),
  },
  gcd: {
    arity: [2, 2],
    fn: ([a, b]: Value[]) => Rational.of(gcdBig(int(a!, 'gcd'), int(b!, 'gcd'))),
  },
  lcm: {
    arity: [2, 2],
    fn: ([a, b]: Value[]) => {
      const x = int(a!, 'lcm');
      const y = int(b!, 'lcm');
      const g = gcdBig(x, y);
      return Rational.of(g === 0n ? 0n : (x < 0n ? -x : x) * ((y < 0n ? -y : y) / g));
    },
  },
  /** Mathematical modulo: mod(-1, 3) = 2. */
  mod: {
    arity: [2, 2],
    fn: ([a, b]: Value[]) => {
      const x = num(a!, 'mod');
      const y = num(b!, 'mod');
      if (y.num === 0n) throw new ExpressionError('mod by zero', 'ARITHMETIC');
      return x.sub(y.mul(x.div(y).floor()));
    },
  },
  numerator: { arity: [1, 1], fn: ([x]: Value[]) => Rational.of(num(x!, 'numerator').num) },
  denominator: { arity: [1, 1], fn: ([x]: Value[]) => Rational.of(num(x!, 'denominator').den) },
} satisfies Record<string, { arity: [number, number]; fn: (args: Value[]) => Value }>;

export type FunctionName = keyof typeof FUNCTIONS;
const isFunction = (name: string): name is FunctionName => Object.hasOwn(FUNCTIONS, name);

type Token =
  | { t: 'num'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'end' };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_]\w*)|(==|!=|<=|>=|&&|\|\||[-+*/^()<>!,]))/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) throw new ExpressionError(`unexpected "${text[at]}" at ${at + 1}`, 'SYNTAX');
    if (m[1] !== undefined) tokens.push({ t: 'num', v: m[1] });
    else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2] });
    else tokens.push({ t: 'op', v: m[3]! });
    at = re.lastIndex;
  }
  tokens.push({ t: 'end' });
  return tokens;
}

const BINARY: Record<string, [number, 'left' | 'right']> = {
  '||': [1, 'left'],
  '&&': [2, 'left'],
  '==': [3, 'left'],
  '!=': [3, 'left'],
  '<': [4, 'left'],
  '<=': [4, 'left'],
  '>': [4, 'left'],
  '>=': [4, 'left'],
  '+': [5, 'left'],
  '-': [5, 'left'],
  '*': [6, 'left'],
  '/': [6, 'left'],
  '^': [8, 'right'],
};
const UNARY_POWER = 7;

/** Parses an expression into a tree. @throws ExpressionError */
export function parse(text: string): Node {
  if (text.length > MAX_LENGTH) {
    throw new ExpressionError(`longer than ${MAX_LENGTH} characters`, 'TOO_LONG');
  }
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos]!;
  const isOp = (v: string) => {
    const tok = peek();
    return tok.t === 'op' && tok.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExpressionError(`expected "${v}"`, 'SYNTAX');
    pos++;
  };

  const expression = (minPower: number, depth: number): Node => {
    if (depth > MAX_DEPTH) throw new ExpressionError('nested too deeply', 'TOO_DEEP');
    let left = prefix(depth);
    for (;;) {
      const tok = peek();
      if (tok.t !== 'op' || !(tok.v in BINARY)) break;
      const [power, assoc] = BINARY[tok.v]!;
      if (power < minPower) break;
      pos++;
      const right = expression(assoc === 'left' ? power + 1 : power, depth + 1);
      left = { kind: 'binary', op: tok.v as BinaryOp, left, right };
    }
    return left;
  };

  const prefix = (depth: number): Node => {
    const tok = peek();
    pos++;
    if (tok.t === 'num') {
      const value = Rational.parse(tok.v);
      if (!value) throw new ExpressionError(`bad number ${tok.v}`, 'SYNTAX');
      return { kind: 'num', value };
    }
    if (tok.t === 'id') {
      if (isOp('(')) {
        if (!isFunction(tok.v)) {
          throw new ExpressionError(`unknown function ${tok.v}`, 'UNKNOWN_FUNCTION');
        }
        pos++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(expression(0, depth + 1));
          while (isOp(',')) {
            pos++;
            args.push(expression(0, depth + 1));
          }
        }
        expect(')');
        const [lo, hi] = FUNCTIONS[tok.v].arity;
        if (args.length < lo || args.length > hi) {
          throw new ExpressionError(`${tok.v} takes ${lo}–${hi} arguments`, 'SYNTAX');
        }
        return { kind: 'call', name: tok.v, args };
      }
      return { kind: 'var', name: tok.v };
    }
    if (tok.t === 'op' && (tok.v === '-' || tok.v === '!')) {
      return { kind: 'unary', op: tok.v, arg: expression(UNARY_POWER, depth + 1) };
    }
    if (tok.t === 'op' && tok.v === '(') {
      const inner = expression(0, depth + 1);
      expect(')');
      return inner;
    }
    throw new ExpressionError(
      tok.t === 'end' ? 'unexpected end' : `unexpected "${tok.v}"`,
      'SYNTAX',
    );
  };

  const tree = expression(0, 0);
  if (peek().t !== 'end')
    throw new ExpressionError('unexpected text after the expression', 'SYNTAX');
  return tree;
}

/** Variable names an expression reads. */
export function variablesOf(node: Node, into = new Set<string>()): Set<string> {
  switch (node.kind) {
    case 'var':
      into.add(node.name);
      break;
    case 'unary':
      variablesOf(node.arg, into);
      break;
    case 'binary':
      variablesOf(node.left, into);
      variablesOf(node.right, into);
      break;
    case 'call':
      node.args.forEach((a) => variablesOf(a, into));
      break;
  }
  return into;
}

/** Evaluates a tree with the given variables. @throws ExpressionError */
export function evaluate(node: Node, scope: ReadonlyMap<string, Value>): Value {
  try {
    return run(node, scope);
  } catch (error) {
    if (error instanceof RationalError) throw new ExpressionError(error.code, 'ARITHMETIC');
    throw error;
  }
}

function run(node: Node, scope: ReadonlyMap<string, Value>): Value {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'var': {
      const v = scope.get(node.name);
      if (v === undefined)
        throw new ExpressionError(`unknown variable ${node.name}`, 'UNKNOWN_VARIABLE');
      return v;
    }
    case 'unary': {
      const v = run(node.arg, scope);
      return node.op === '-' ? num(v, '-').neg() : !bool(v, '!');
    }
    case 'call':
      return FUNCTIONS[node.name].fn(node.args.map((a) => run(a, scope)));
    case 'binary': {
      if (node.op === '&&')
        return bool(run(node.left, scope), '&&') && bool(run(node.right, scope), '&&');
      if (node.op === '||')
        return bool(run(node.left, scope), '||') || bool(run(node.right, scope), '||');
      const l = run(node.left, scope);
      const r = run(node.right, scope);
      if (node.op === '==' || node.op === '!=') {
        const same = typeof l === 'boolean' || typeof r === 'boolean' ? l === r : l.equals(r);
        return node.op === '==' ? same : !same;
      }
      const a = num(l, node.op);
      const b = num(r, node.op);
      switch (node.op) {
        case '+':
          return a.add(b);
        case '-':
          return a.sub(b);
        case '*':
          return a.mul(b);
        case '/':
          return a.div(b);
        case '^':
          return a.pow(b);
        case '<':
          return a.compare(b) < 0;
        case '<=':
          return a.compare(b) <= 0;
        case '>':
          return a.compare(b) > 0;
        default:
          return a.compare(b) >= 0;
      }
    }
  }
}

/** Parses and evaluates in one step, for tests and one-off checks. */
export function calc(text: string, vars: Record<string, Value | number> = {}): Value {
  const scope = new Map<string, Value>(
    Object.entries(vars).map(([k, v]) => [k, typeof v === 'number' ? Rational.of(BigInt(v)) : v]),
  );
  return evaluate(parse(text), scope);
}
