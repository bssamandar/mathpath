/**
 * The Sunday-evening report SMS to parents (step 7.4b; UX S11; PRD P2).
 *
 * At `sendAt` on Sunday (Tashkent time) the worker texts each parent in the
 * configured audience a short summary of the week with a link to the parent
 * page. Rules:
 * - Never outside Sunday sendAt–stopAt, and never after 21:00 (the config
 *   refuses a later stopAt). The start-up run sends only inside the window,
 *   so a worker restarted at 20:00 finishes the job and one restarted on
 *   Monday does not wake anyone.
 * - At most one SMS per parent and week: a row in report_sms_log is claimed
 *   before sending. A failed send is recorded and not retried that week.
 * - These messages do not count against the sign-in SMS budget (anti-pumping,
 *   C-20): they go to verified parents only, at most once a week, capped by
 *   maxPerRun. They have their own metric, mathpath_report_sms_total.
 */
import type { AppConfig } from '@mathpath/config';
import { leagueWeekOf, type ReportRecipient } from '@mathpath/db';
import { maskPhone, type SmsSender, smsMessages } from '@mathpath/sms';
import { type ScheduledTask, type ScheduleOptions, startScheduled } from '../schedule';

export const WEEKLY_SMS_QUEUE = 'weekly-report-sms';

type WeeklySmsRules = AppConfig['reports']['weeklySms'];

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Cron pattern for Sunday at `sendAt` (HH:MM). */
export function weeklySmsPattern(sendAt: string): string {
  const [hour, minute] = sendAt.split(':').map(Number);
  return `${minute} ${hour} * * 0`;
}

/** The Tashkent weekday (0 = Sunday) and HH:MM of an instant. */
export function tashkentClock(now: Date): { weekday: number; time: string } {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  return { weekday: local.getUTCDay(), time: local.toISOString().slice(11, 16) };
}

/** True while report SMS may be sent: Sunday, from sendAt until before stopAt. */
export function insideWindow(rules: WeeklySmsRules, now: Date): boolean {
  const { weekday, time } = tashkentClock(now);
  return weekday === 0 && time >= rules.sendAt && time < rules.stopAt;
}

export interface WeeklySmsDeps {
  rules: WeeklySmsRules;
  sender: SmsSender;
  /** Link in the message, for example https://mathpath.uz/parent. */
  link: string;
  now(): Date;
  recipients(weekStart: string, limit: number): Promise<ReportRecipient[]>;
  claim(parentId: string, weekStart: string, children: number): Promise<boolean>;
  finish(
    parentId: string,
    weekStart: string,
    outcome: { ok: true } | { ok: false; failure: string },
  ): Promise<void>;
  onOutcome(outcome: 'sent' | 'failed'): void;
  /** Failures, with the phone masked. */
  warn(line: string): void;
}

export interface WeeklySmsResult {
  week: string | null;
  sent: number;
  failed: number;
  /** Parents claimed by another run in the meantime. */
  skipped: number;
  /** Left unsent because the window closed. */
  late: number;
}

/** One run; quiet (null week) outside the window or when the audience is off. */
export async function sendWeeklyReports(deps: WeeklySmsDeps): Promise<WeeklySmsResult> {
  const result: WeeklySmsResult = { week: null, sent: 0, failed: 0, skipped: 0, late: 0 };
  const { rules } = deps;
  if (rules.audience === 'off' || !insideWindow(rules, deps.now())) return result;
  const week = leagueWeekOf(deps.now());
  result.week = week;
  const queue = await deps.recipients(week, rules.maxPerRun);

  const sendOne = async (r: ReportRecipient) => {
    if (!insideWindow(rules, deps.now())) {
      result.late += 1;
      return;
    }
    if (!(await deps.claim(r.parentId, week, r.children.length))) {
      result.skipped += 1;
      return;
    }
    try {
      await deps.sender.send(r.phone, smsMessages.weeklyReport(r.locale, r.children, deps.link));
      await deps.finish(r.parentId, week, { ok: true });
      result.sent += 1;
      deps.onOutcome('sent');
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      await deps.finish(r.parentId, week, { ok: false, failure });
      result.failed += 1;
      deps.onOutcome('failed');
      deps.warn(`report SMS to ${maskPhone(r.phone)} failed: ${failure}`);
    }
  };

  let next = 0;
  const lane = async () => {
    while (next < queue.length) {
      const recipient = queue[next]!;
      next += 1;
      await sendOne(recipient);
    }
  };
  await Promise.all(Array.from({ length: Math.min(rules.concurrency, queue.length) }, lane));
  return result;
}

export function describeWeeklySms(result: WeeklySmsResult): string | undefined {
  if (result.week === null) return undefined;
  return `weekly report SMS for ${result.week}: sent ${result.sent}, failed ${result.failed}, already sent ${result.skipped}, left after the window ${result.late}`;
}

export function startWeeklySms(
  deps: WeeklySmsDeps,
  hooks: { onRun(): void },
  options: ScheduleOptions,
): Promise<ScheduledTask> {
  return startScheduled(
    WEEKLY_SMS_QUEUE,
    weeklySmsPattern(deps.rules.sendAt),
    async () => {
      const result = await sendWeeklyReports(deps);
      hooks.onRun();
      return describeWeeklySms(result);
    },
    options,
  );
}
