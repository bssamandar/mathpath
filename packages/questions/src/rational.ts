/**
 * Exact rational numbers on bigint. Questions about fractions must compare
 * 2/4 and 1/2 as equal and never meet 0.1 + 0.2 = 0.30000000000000004.
 */

/** Numbers beyond this many digits are refused, so a template cannot make the server spin. */
export const MAX_DIGITS = 60;

const abs = (n: bigint) => (n < 0n ? -n : n);

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

export class RationalError extends Error {
  constructor(readonly code: 'DIVISION_BY_ZERO' | 'TOO_LARGE' | 'NOT_INTEGER') {
    super(code);
    this.name = 'RationalError';
  }
}

export class Rational {
  /** Always in lowest terms with a positive denominator. */
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static of(num: bigint | number, den: bigint | number = 1n): Rational {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new RationalError('DIVISION_BY_ZERO');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d) || 1n;
    n /= g;
    d /= g;
    if (abs(n).toString().length > MAX_DIGITS || d.toString().length > MAX_DIGITS) {
      throw new RationalError('TOO_LARGE');
    }
    return new Rational(n, d);
  }

  /** Parses "12", "-3.25" or "7/8" (no spaces). @returns null when it is not a number. */
  static parse(text: string): Rational | null {
    const fraction = /^(-?\d{1,30})\/(\d{1,30})$/.exec(text);
    if (fraction) {
      return fraction[2] === '0' || /^0+$/.test(fraction[2]!)
        ? null
        : Rational.of(BigInt(fraction[1]!), BigInt(fraction[2]!));
    }
    const decimal = /^(-?)(\d{1,30})(?:\.(\d{1,30}))?$/.exec(text);
    if (!decimal) return null;
    const [, sign, whole, frac = ''] = decimal;
    const num = BigInt(`${whole}${frac}`) * (sign ? -1n : 1n);
    return Rational.of(num, 10n ** BigInt(frac.length));
  }

  add(o: Rational): Rational {
    return Rational.of(this.num * o.den + o.num * this.den, this.den * o.den);
  }
  sub(o: Rational): Rational {
    return Rational.of(this.num * o.den - o.num * this.den, this.den * o.den);
  }
  mul(o: Rational): Rational {
    return Rational.of(this.num * o.num, this.den * o.den);
  }
  div(o: Rational): Rational {
    if (o.num === 0n) throw new RationalError('DIVISION_BY_ZERO');
    return Rational.of(this.num * o.den, this.den * o.num);
  }
  neg(): Rational {
    return new Rational(-this.num, this.den);
  }
  /** Integer powers only, |exponent| ≤ 64. */
  pow(exponent: Rational): Rational {
    if (!exponent.isInteger()) throw new RationalError('NOT_INTEGER');
    const e = exponent.num;
    if (abs(e) > 64n) throw new RationalError('TOO_LARGE');
    const base = e < 0n ? Rational.of(1n).div(this) : this;
    return Rational.of(base.num ** abs(e), base.den ** abs(e));
  }

  isInteger(): boolean {
    return this.den === 1n;
  }
  compare(o: Rational): number {
    const d = this.num * o.den - o.num * this.den;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  equals(o: Rational): boolean {
    return this.num === o.num && this.den === o.den;
  }
  /** Floor for any sign: floor(-7/2) = -4. */
  floor(): Rational {
    const q = this.num / this.den;
    return Rational.of(this.num < 0n && q * this.den !== this.num ? q - 1n : q);
  }
  /** True when the decimal expansion ends (the denominator has only 2s and 5s). */
  isTerminating(): boolean {
    let d = this.den;
    while (d % 2n === 0n) d /= 2n;
    while (d % 5n === 0n) d /= 5n;
    return d === 1n;
  }
  /** Rounded half away from zero to `places` digits, as text with a dot. */
  toDecimal(places: number): string {
    const scale = 10n ** BigInt(places);
    const scaled = abs(this.num) * scale * 2n + this.den;
    const rounded = scaled / (this.den * 2n);
    const sign = this.num < 0n && rounded !== 0n ? '-' : '';
    const digits = rounded.toString().padStart(places + 1, '0');
    return places === 0
      ? `${sign}${digits}`
      : `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
  }
  /** "7", "-3/4". */
  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }
}
