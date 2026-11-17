/**
 * Tamper-evident audit log (security plan C-33).
 *
 * The hashing lives in @mathpath/db (`audit-chain.ts`), so the worker can
 * check the chain every night. The table also refuses UPDATE and DELETE
 * (a trigger), and production gives the app's DB user INSERT and SELECT only.
 *
 * Entries are appended one at a time under a transaction-level advisory lock,
 * so two API instances cannot both link to the same previous entry.
 *
 * Never put personal data that the log does not need into `metadata` (no phone
 * numbers, no names): the audit log is kept for years.
 */
import { type Database, entryHash, type HashedFields, newId } from '@mathpath/db';
import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, sql, type Transaction } from 'kysely';
import { DB } from '../database/database.module';
import { METRICS, type Metrics } from '../observability/observability.module';

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

@Injectable()
export class AuditService {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  /**
   * Appends an entry.
   *
   * @param entry - The event.
   * @param trx - Pass the caller's transaction when the audited change happens
   *   in one, so the change and its audit entry commit or fail together.
   */
  async record(entry: AuditEntry, trx?: Transaction<Database>): Promise<void> {
    if (trx) await this.append(trx, entry);
    else await this.db.transaction().execute((t) => this.append(t, entry));
    // Counted when written; an entry in a transaction that later rolls back
    // is still counted, which is fine for alerting on spikes.
    this.metrics.auditEvents.inc({ action: entry.action });
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

export { type ChainCheck, verifyAuditChain } from '@mathpath/db';
