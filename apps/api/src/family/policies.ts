/**
 * Object-level authorisation for family data (security plan C-10).
 *
 * A permission such as `family:manage` only says a parent may manage
 * children; these checks say *which* children. "Not linked" and "does not
 * exist" give the same 404, so IDs of other families' children cannot be probed.
 */
import type { Database } from '@mathpath/db';
import type { Kysely } from 'kysely';
import { ProblemException } from '../common/problem';

/** @throws ProblemException 404 unless `childId` is linked to `parentId`. */
export async function assertParentOf(
  db: Kysely<Database>,
  parentId: string,
  childId: string,
): Promise<void> {
  const link = await db
    .selectFrom('parent_child_links')
    .select('child_id')
    .where('parent_id', '=', parentId)
    .where('child_id', '=', childId)
    .executeTakeFirst();
  if (!link) throw new ProblemException(404, 'CHILD_NOT_FOUND', 'Child not found.');
}
