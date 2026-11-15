/**
 * Tamper-evident audit log (security plan C-33).
 *
 * Each entry stores the SHA-256 of its own content plus the previous entry's
 * hash. Editing or deleting any row breaks every hash after it, which
 * {@link verifyAuditChain} detects. The table also refuses UPDATE and DELETE
 * (a trigger), and production gives the app's DB user INSERT and SELECT only.
 *
 * Entries are appended one at a time under a transaction-level advisory lock,
 * so two API instances cannot both link to the same previous entry.
 *
 * Never put personal data that the log does not need into `metadata` (no phone
 * numbers, no names): the audit log is kept for years.
 */
import { createHash } from 'node:crypto';
import { type Database, newId } from '@mathpath/db';
import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, sql, type Transaction } from 'kysely';
import { DB } from '../database/database.module';

/** Arbitrary 64-bit key that identifies the audit-chain lock. */
const AUDIT_LOCK_KEY = 7_316_002_026;

/** What happened, who did it, and to what. */
export interface AuditEntry {
  /** Dotted verb, for example `auth.login` or `user.role.grant`. */
  action: string;
  actorId?: string | null;
  actorRoles?: readonly string[];
  targetType?: string | null;
  targetId?: string | null;
  ipPrefix?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

interface HashedFields {
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

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  /**
   * Appends an entry.
   *
   * @param entry - The event.
   * @param trx - Pass the caller's transaction when the audited change happens
   *   in one, so the change and its audit entry commit or fail together.
   */
  async record(entry: AuditEntry, trx?: Transaction<Database>): Promise<void> {
    if (trx) return this.append(trx, entry);
    return this.db.transaction().execute((t) => this.append(t, entry));
  }

  private async append(trx: Transaction<Database>, entry: AuditEntry): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`.execute(trx);
    const head = await trx
      .selectFrom('audit_log')
      .select(['hash', 'created_at'])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();

    // Strictly increasing timestamps keep the chain order unambiguous even
    // when two entries land in the same millisecond.
    const now = Date.now();
    const created = new Date(head ? Math.max(now, head.created_at.getTime() + 1) : now);
    const fields: HashedFields = {
      id: newId(),
      actor_id: entry.actorId ?? null,
      actor_roles: [...(entry.actorRoles ?? [])],
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      ip_prefix: entry.ipPrefix ?? null,
      request_id: entry.requestId ?? null,
      metadata: entry.metadata ?? {},
      created_at: created,
    };
    const prevHash = head ? Buffer.from(head.hash) : null;
    await trx
      .insertInto('audit_log')
      .values({ ...fields, prev_hash: prevHash, hash: entryHash(prevHash, fields) })
      .execute();
  }
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
