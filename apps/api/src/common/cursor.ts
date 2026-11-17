/**
 * Keyset pagination for lists ordered newest first (OpenAPI `Cursor` and
 * `Limit` parameters). The cursor is the last row's time and ID, so a page
 * stays correct while new rows arrive, and the database reads only one page
 * through an index instead of skipping rows with OFFSET.
 *
 * The cursor is not signed: it only says where to continue, and every query
 * still applies the caller's filters and permissions.
 */
import { z } from 'zod';
import { ProblemException } from './problem';

export interface Position {
  at: Date;
  id: string;
}

const shape = z.tuple([z.iso.datetime(), z.uuid()]);

export function encodeCursor(position: Position): string {
  return Buffer.from(JSON.stringify([position.at.toISOString(), position.id])).toString(
    'base64url',
  );
}

/** @throws ProblemException 400 for a cursor this API did not make. */
export function decodeCursor(cursor: string): Position {
  try {
    const [at, id] = shape.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { at: new Date(at), id };
  } catch {
    throw new ProblemException(400, 'VALIDATION_FAILED', 'The request is not valid.', {
      errors: [{ field: 'cursor', message: 'is not a cursor from this list' }],
    });
  }
}

/** The OpenAPI `Limit` parameter: 1 to 100, 20 when not given. */
export const pageLimit = z.coerce.number().int().min(1).max(100).default(20);

/**
 * Splits one extra row off a query that asked for `limit + 1`: the extra row
 * only says that another page exists.
 */
export function page<T>(
  rows: T[],
  limit: number,
  positionOf: (row: T) => Position,
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const kept = rows.slice(0, limit);
  return { rows: kept, nextCursor: encodeCursor(positionOf(kept.at(-1)!)) };
}
