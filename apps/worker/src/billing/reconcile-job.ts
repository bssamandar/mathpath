/**
 * The daily billing reconciliation (security plan C-28, C-39): runs the
 * checks in @mathpath/db at 06:00 Tashkent time, after the night's provider
 * callbacks have settled, and once at start. The counts go to a metric that
 * the BillingReconciliationMismatch alert reads; the first IDs go to the log.
 */
import type { ReconciliationResult } from '@mathpath/db';
import { type ScheduledTask, type ScheduleOptions, startScheduled } from '../schedule';

export const RECONCILE_QUEUE = 'billing-reconciliation';
export const RECONCILE_PATTERN = '0 6 * * *';

export interface ReconcileHooks {
  /** Called after every run, so the caller can export metrics. */
  onResult(result: ReconciliationResult): void;
}

/** One log line: the checks that found rows, with counts and sample IDs. */
export function describeResult(result: ReconciliationResult): string {
  if (result.ok) return 'billing books agree';
  const parts = Object.entries(result.counts)
    .filter(([, n]) => n > 0)
    .map(([check, n]) => {
      const ids = result.samples[check as keyof typeof result.samples] ?? [];
      return `${check}=${n} [${ids.join(', ')}]`;
    });
  return `billing mismatches: ${parts.join('; ')}`;
}

export function startReconciliation(
  reconcile: () => Promise<ReconciliationResult>,
  hooks: ReconcileHooks,
  options: ScheduleOptions,
): Promise<ScheduledTask> {
  return startScheduled(
    RECONCILE_QUEUE,
    RECONCILE_PATTERN,
    async () => {
      const result = await reconcile();
      hooks.onResult(result);
      // A mismatch is a finding, not a failed run: the metric alerts on it,
      // and retrying would find the same rows.
      return describeResult(result);
    },
    options,
  );
}
