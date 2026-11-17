/**
 * Removes personal data and secrets from log entries (security plan C-34).
 *
 * Two layers, because a log line can carry data either way:
 * - by key: values under keys such as `password`, `token` or `phone` are
 *   replaced, at any depth;
 * - by pattern: phone numbers, bearer tokens and JWTs inside free text are
 *   masked, so `Login for +998901234567 failed` is safe to log.
 *
 * Names are redacted by key only: a pattern cannot tell a name from any
 * other word.
 */

export const REDACTED = '[redacted]';

/** Keys whose values never reach a log (compared without case, `_` or `-`). */
const SECRET_KEYS = new Set([
  'password',
  'passwordhash',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'captchatoken',
  'devicetoken',
  'otp',
  'otpcode',
  'smscode',
  'pin',
  'pinhash',
  'secret',
  'totp',
  'recoverycode',
  'recoverycodes',
  'authorization',
  'cookie',
  'setcookie',
  'phone',
  'phonee164',
  'firstname',
  'lastname',
  'fullname',
  'cardmask',
  'cardnumber',
  'email',
]);

const normalise = (key: string) => key.toLowerCase().replace(/[_-]/g, '');

/** Uzbek and other international numbers: `+998901234567` or `998901234567`. */
const PHONE = /\+?\b998\d{9}\b|\+[1-9]\d{9,14}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Keeps the country and operator code and the last two digits, as the admin console does. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `+${digits.slice(0, 5)}${'*'.repeat(Math.max(0, digits.length - 7))}${digits.slice(-2)}`;
}

export function redactText(text: string): string {
  return text
    .replace(JWT, '[jwt]')
    .replace(BEARER, (_, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(PHONE, maskPhone);
}

/**
 * A copy of `value` that is safe to log. Cycles and very deep values are
 * cut off instead of throwing.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6 || seen.has(value)) return '[…]';
  seen.add(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEYS.has(normalise(key)) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}
