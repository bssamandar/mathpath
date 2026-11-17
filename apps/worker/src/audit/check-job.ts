/**
 * The nightly audit-log check (security plan C-33): recomputes the hash
 * chain and reports a changed or deleted entry. Runs at 03:30 Tashkent time,
 * when traffic is lowest, and once at start.
 *
 * It reads the whole table in one pass. That is fine for the first year
 * (millions of short rows); checking one day at a time from a stored
 * checkpoint is the next step when it grows.
 */
import type { ChainCheck } from '@mathpath/db';
import { type ScheduledTask, type ScheduleOptions, startScheduled } from '../schedule';

export const AUDIT_CHECK_QUEUE = 'audit-chain-check';
export const AUDIT_CHECK_PATTERN = '30 3 * * *';

export interface AuditCheckHooks {
  /** Called after every check, so the caller can export metrics. */
  onResult(check: ChainCheck): void;
}

export function startAuditCheck(
  verify: () => Promise<ChainCheck>,
  hooks: AuditCheckHooks,
  options: ScheduleOptions,
): Promise<ScheduledTask> {
  return startScheduled(
    AUDIT_CHECK_QUEUE,
    AUDIT_CHECK_PATTERN,
    async () => {
      const check = await verify();
      hooks.onResult(check);
      if (!check.ok) {
        // Thrown so the job shows as failed and the log has an error line;
        // the metric has already been set for the alert.
        throw new Error(`audit chain broken at entry ${check.brokenAt} (${check.entries} entries)`);
      }
      return `audit chain ok (${check.entries} entries)`;
    },
    { ...options },
  );
}
