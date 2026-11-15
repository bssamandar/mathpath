import { v7 } from 'uuid';

/**
 * Generates a new primary key.
 *
 * UUIDv7 is time-ordered (good B-tree locality) and not guessable (no
 * enumeration of other users' records), see ADR-0004.
 *
 * @returns A UUIDv7 string.
 */
export function newId(): string {
  return v7();
}
