# ADR-0011: Own expression engine for question templates instead of math.js

- Status: Proposed
- Date: 2026-11-16

## Context

Question templates (schema doc §4.2) contain expressions written by authors:
variable ranges (`[1, "d-1"]`), constraints (`a + b != d`), the answer
(`(a+b)/d`) and distractors. The server evaluates them for every generated
item. The design (security plan C-17, threat T29) planned a restricted
math.js instance.

What the templates need is narrow: whole numbers and **exact fractions**,
`+ - * / ^`, comparisons, `&& || !`, and a few functions (`gcd`, `lcm`,
`min`, `max`, `abs`, `floor`, `ceil`, `round`, `mod`). Fractions must be
exact: `0.1 + 0.2` has to equal `0.3`, and `2/4` has to equal `1/2`.

## Decision

`@mathpath/questions` contains its own small engine:

- a Pratt parser over a fixed grammar (no property access, assignment,
  strings or function definitions);
- values that are bigint rationals or booleans;
- a fixed list of functions;
- limits on expression length (300), nesting depth (32), number size
  (60 digits), exponents (|n| ≤ 64), draws (100) and time per item (50 ms).

## Alternatives considered

- **Restricted math.js.** It has a large attack surface: its expression
  parser has had sandbox escapes leading to code execution
  (CVE-2017-1001002, CVE-2017-1001003). It would have to be locked down by
  removing functions, and every upgrade would have to be re-checked. It also
  needs `BigNumber` and `Fraction` configuration for exact results, and it
  adds about 600 kB of dependency.
- **`expr-eval`.** It is smaller, but it uses floating point and has had
  prototype-pollution issues.
- **Running templates in `isolated-vm` or a worker.** This would give strong
  isolation, but templates do not need general code. A native addon also
  complicates the distroless image.

## Consequences

- The whole language is about 300 lines and is covered by tests, including
  inputs that must be refused (`constructor(1)`, `__proto__`, `a[0]`,
  strings, deep nesting).
- Exact arithmetic means answer checking never hits rounding surprises.
- New functions need code here, not configuration. This is intended: each
  one is reviewed.
- Variables are ordered by what they read, not by object key order, because
  PostgreSQL `jsonb` does not keep key order.
