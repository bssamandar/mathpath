/**
 * Request validation (security plan C-12).
 *
 * Bodies are parsed with strict Zod schemas that mirror docs/api/openapi.yaml:
 * unknown fields are rejected, so a client cannot slip in fields such as
 * `role: admin` that a handler might later pass through by mistake.
 */
import { z } from 'zod';
import { ProblemException } from './problem';

/**
 * Validates untrusted input against a schema.
 *
 * @param schema - The Zod schema of the expected shape.
 * @param input - The raw request body.
 * @returns The parsed, typed value.
 * @throws ProblemException 400 `VALIDATION_FAILED` with one entry per invalid field.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  throw new ProblemException(400, 'VALIDATION_FAILED', 'The request is not valid.', {
    errors: result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    })),
  });
}

/** E.164 phone number, as in the OpenAPI `PhoneE164` schema. */
export const phoneE164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'expected an E.164 phone number');
/** The OpenAPI `PersonName` schema; trimmed so " " is not a name. */
export const personName = z.string().trim().min(1).max(60);
/** The OpenAPI `Locale` schema. */
export const locale = z.enum(['uz-Latn', 'ru', 'en']);
/** The OpenAPI `DeviceToken` schema. Accepted now, used by the risk module (C-22). */
export const deviceToken = z.string().max(512);
