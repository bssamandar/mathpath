/**
 * The audit log's hash chain (security plan C-33), shared by the API, which
 * appends entries, and the worker, which checks the chain every night.
 *
 * Each entry stores the SHA-256 of its own content plus the previous entry's
 * hash. Editing or deleting any row breaks every hash after it, which
 * {@link verifyAuditChain} detects.
 */
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from './schema';

/** The columns that go into an entry's hash. */
export interface HashedFields {
  id: string;
  actor_id: string | null;
  actor_roles: string[];
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip_prefix: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** JSON with sorted keys, so the same content always hashes the same way. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** hash = SHA-256(previous hash ‖ canonical JSON of the entry). */
export function entryHash(prevHash: Buffer | null, fields: HashedFields): Buffer {
  return createHash('sha256')
    .update(prevHash ?? Buffer.alloc(0))
    .update(canonicalJson(fields))
    .digest();
}

/** Result of checking the chain. */
export interface ChainCheck {
  ok: boolean;
  entries: number;
  /** ID of the first entry whose hash does not match, when `ok` is false. */
  brokenAt?: string;
}

/**
 * Recomputes every hash in order. Used by tests and by the daily integrity job.
 * Reads the whole table; the job will check one day at a time once the table
 * grows.
 */
export async function verifyAuditChain(db: Kysely<Database>): Promise<ChainCheck> {
  const rows = await db
    .selectFrom('audit_log')
    .selectAll()
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  let prev: Buffer | null = null;
  for (const row of rows) {
    const { prev_hash: rawPrev, hash: rawHash, ...fields } = row;
    // node-postgres returns bytea as Buffer, PGlite as Uint8Array.
    const prev_hash = rawPrev === null ? null : Buffer.from(rawPrev);
    const hash = Buffer.from(rawHash);
    const linked =
      (prev_hash === null && prev === null) ||
      (prev_hash !== null && prev !== null && prev_hash.equals(prev));
    if (!linked || !hash.equals(entryHash(prev, fields))) {
      return { ok: false, entries: rows.length, brokenAt: row.id };
    }
    prev = hash;
  }
  return { ok: true, entries: rows.length };
}
