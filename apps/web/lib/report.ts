/**
 * The weekly report for parents (UX S10, S11). Shapes follow
 * docs/api/openapi.yaml (WeeklyReport). The API sends facts and codes; the
 * sentences are written here in the parent's language.
 */

export interface WeeklyReport {
  studentId: string;
  weekStart: string;
  weekEnd: string;
  minutesByDay: number[];
  minutesActive: number;
  minutesLastWeek: number;
  daysActive: number;
  questionsAnswered: number;
  rightFirstTime: number;
  xpEarned: number;
  streak: number;
  topicsMastered: { topicId: string; title: string }[];
  concerns: {
    topicId: string;
    title: string;
    reason: 'gap_found' | 'mastery_not_passed' | 'review_due';
  }[];
}

/** A child as GET /children returns it. */
export interface FamilyChild {
  id: string;
  firstName: string;
  nickname: string;
  grade: number;
  plan: 'free' | 'trial' | 'paid';
}

/** How this week's time compares with last week's. */
export function trend(report: Pick<WeeklyReport, 'minutesActive' | 'minutesLastWeek'>) {
  const { minutesActive: now, minutesLastWeek: before } = report;
  if (now === 0 && before === 0) return 'none' as const;
  if (before === 0) return 'first' as const;
  // Within a tenth either way counts as the same, so small swings are not news.
  if (Math.abs(now - before) <= before / 10) return 'same' as const;
  return now > before ? ('up' as const) : ('down' as const);
}

/** The share of questions answered right on the first try, as a whole percentage. */
export function rightShare(report: Pick<WeeklyReport, 'questionsAnswered' | 'rightFirstTime'>) {
  if (report.questionsAnswered === 0) return null;
  return Math.round((report.rightFirstTime / report.questionsAnswered) * 100);
}

/** The Monday a week before `weekStart` (`YYYY-MM-DD`). */
export function previousWeek(weekStart: string): string {
  return new Date(Date.parse(`${weekStart}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
}

/** The Monday a week after `weekStart`, or null when that is after `current`. */
export function nextWeek(weekStart: string, current: string): string | null {
  const next = new Date(Date.parse(`${weekStart}T00:00:00Z`) + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return next > current ? null : next;
}

/** Bar heights as percentages of the busiest day, for the time chart. */
export function barHeights(minutes: number[]): number[] {
  const most = Math.max(...minutes, 0);
  return minutes.map((m) => (most === 0 ? 0 : Math.round((m / most) * 100)));
}

/**
 * A child's PIN: 4 to 6 digits, and not one of the first guesses (0000, 1234,
 * 4321, 1212, 123123). The same rule as the API (apps/api/src/family/pin.ts),
 * so the parent hears about it before the SMS step.
 */
export function pinProblem(pin: string): 'format' | 'simple' | null {
  if (!/^[0-9]{4,6}$/.test(pin)) return 'format';
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]!);
  if (steps.every((s) => s === 0) || steps.every((s) => s === 1) || steps.every((s) => s === -1)) {
    return 'simple';
  }
  for (const size of [2, 3]) {
    if (
      pin.length % size === 0 &&
      pin.length > size &&
      pin === pin.slice(0, size).repeat(pin.length / size)
    ) {
      return 'simple';
    }
  }
  return null;
}
