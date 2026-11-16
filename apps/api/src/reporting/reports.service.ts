/**
 * Weekly report (architecture §4 `reporting`; PRD P2; UX S10, S11). Read on
 * request from the learning tables: a week is Monday to Sunday in Tashkent
 * time, the same week as the leagues.
 *
 * The report holds facts and stable codes, not sentences: the app writes the
 * summary in the parent's language. Time is estimated from questions (time
 * from showing a question to its answer, at most five minutes each), the
 * same estimate as the progress screen; lesson videos are not counted yet.
 */
import type { AppConfig } from '@mathpath/config';
import { type Database, leagueWeekEnd, leagueWeekOf } from '@mathpath/db';
import { type Kysely, sql } from 'kysely';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import { pickText } from '../content/documents';

const MAX_ITEM_SECONDS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
/** At most this many "needs attention" lines, so the report stays short. */
const MAX_CONCERNS = 3;

export type ConcernReason = 'mastery_not_passed' | 'review_due' | 'gap_found';

export interface WeeklyReport {
  studentId: string;
  weekStart: string;
  weekEnd: string;
  /** Monday to Sunday, minutes per day. */
  minutesByDay: number[];
  minutesActive: number;
  minutesLastWeek: number;
  daysActive: number;
  questionsAnswered: number;
  /** Right on the first try, out of `questionsAnswered`. */
  rightFirstTime: number;
  xpEarned: number;
  streak: number;
  topicsMastered: { topicId: string; title: string }[];
  concerns: { topicId: string; title: string; reason: ConcernReason }[];
}

/** Tashkent day of a timestamp column, independent of the session time zone. */
const tashkentDate = (column: string) =>
  sql<string>`to_char((${sql.ref(column)} at time zone 'UTC') + interval '5 hours', 'YYYY-MM-DD')`;

export class ReportsService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly rules: AppConfig,
  ) {}

  /**
   * GET /students/{studentId}/reports/weekly. The caller's access to the
   * student is checked by the controller.
   * @param weekStart A Monday; defaults to this week.
   * @throws ProblemException 422 for a date that is not a Monday or is in the future.
   */
  async weekly(
    studentId: string,
    weekStart: string | undefined,
    locale: string,
  ): Promise<WeeklyReport> {
    const current = leagueWeekOf(this.clock.now());
    const week = weekStart ?? current;
    if (leagueWeekOf(new Date(`${week}T12:00:00Z`)) !== week || week > current) {
      throw new ProblemException(
        422,
        'VALIDATION_FAILED',
        'Choose the Monday of a past or this week.',
        {
          errors: [{ field: 'weekStart', message: 'must be a Monday, not in the future' }],
        },
      );
    }
    const start = Date.parse(`${week}T00:00:00Z`);
    const days = Array.from({ length: 7 }, (_, i) =>
      new Date(start + i * DAY_MS).toISOString().slice(0, 10),
    );
    const lastWeek = new Date(start - 7 * DAY_MS).toISOString().slice(0, 10);
    // Instants that bound the week in Tashkent time, with the week before for comparison.
    const from = new Date(leagueWeekEnd(lastWeek).getTime() - 7 * DAY_MS);
    const to = leagueWeekEnd(week);

    const [answered, xp, stats, mastered, concerns] = await Promise.all([
      this.db
        .selectFrom('attempt_items as i')
        .innerJoin('attempts as a', 'a.id', 'i.attempt_id')
        .select([
          tashkentDate('i.answered_at').as('day'),
          sql<string>`coalesce(sum(least(extract(epoch from (i.answered_at - i.served_at)), ${MAX_ITEM_SECONDS})), 0)`.as(
            'seconds',
          ),
          (eb) => eb.fn.countAll<string>().as('answered'),
          (eb) =>
            eb.fn
              .countAll<string>()
              .filterWhere((w) => w.and([w('i.tries', '=', 1), w('i.is_correct', '=', true)]))
              .as('right_first'),
        ])
        .where('a.user_id', '=', studentId)
        .where('i.answered_at', '>=', from)
        .where('i.answered_at', '<', to)
        .where('i.served_at', 'is not', null)
        .groupBy(tashkentDate('i.answered_at'))
        .execute(),
      this.db
        .selectFrom('xp_ledger')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount'), eb.lit(0)).as('xp'))
        .where('user_id', '=', studentId)
        .where('day', '>=', week)
        .where('day', '<=', days[6]!)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('user_stats')
        .select('current_streak')
        .where('user_id', '=', studentId)
        .executeTakeFirst(),
      this.db
        .selectFrom('topic_progress as p')
        .innerJoin('topics as t', 't.id', 'p.topic_id')
        .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
        .select(['p.topic_id', 'v.title'])
        .where('p.user_id', '=', studentId)
        .where('p.mastered_at', '>=', new Date(to.getTime() - 7 * DAY_MS))
        .where('p.mastered_at', '<', to)
        .orderBy('p.mastered_at')
        .execute(),
      this.concerns(studentId, to),
    ]);

    const byDay = new Map(answered.map((row) => [row.day, row]));
    const minutes = (day: string) => Math.round(Number(byDay.get(day)?.seconds ?? 0) / 60);
    const thisWeek = answered.filter((row) => row.day >= week);
    const minutesByDay = days.map(minutes);
    return {
      studentId,
      weekStart: week,
      weekEnd: days[6]!,
      minutesByDay,
      minutesActive: minutesByDay.reduce((a, b) => a + b, 0),
      minutesLastWeek: Math.round(
        answered
          .filter((row) => row.day < week)
          .reduce((sum, row) => sum + Number(row.seconds), 0) / 60,
      ),
      daysActive: thisWeek.length,
      questionsAnswered: thisWeek.reduce((sum, row) => sum + Number(row.answered), 0),
      rightFirstTime: thisWeek.reduce((sum, row) => sum + Number(row.right_first), 0),
      xpEarned: Number(xp.xp),
      // Only meaningful for this week; a past report does not show today's streak.
      streak: week === current ? (stats?.current_streak ?? 0) : 0,
      topicsMastered: mastered.map((m) => ({
        topicId: m.topic_id,
        title: this.text(m.title, locale),
      })),
      concerns: concerns.map((c) => ({ ...c, title: this.text(c.title, locale) })),
    };
  }

  /**
   * What needs a parent's attention at the end of the week, most useful first:
   * a gap the router found, a mastery test not yet passed, a review that is due.
   */
  private async concerns(studentId: string, to: Date) {
    const weekFrom = new Date(to.getTime() - 7 * DAY_MS);
    const [gaps, failed, due] = await Promise.all([
      this.db
        .selectFrom('learning_detours as d')
        .innerJoin('topics as t', 't.id', 'd.to_topic_id')
        .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
        .select(['d.to_topic_id as topicId', 'v.title'])
        .where('d.user_id', '=', studentId)
        .where('d.status', 'in', ['open', 'added_to_path'])
        .where('d.created_at', '<', to)
        .orderBy('d.created_at', 'desc')
        .execute(),
      this.db
        .selectFrom('attempts as a')
        .innerJoin('assessments as s', 's.id', 'a.assessment_id')
        .innerJoin('topics as t', 't.id', 'a.topic_id')
        .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
        .leftJoin('topic_progress as p', (join) =>
          join.onRef('p.topic_id', '=', 'a.topic_id').onRef('p.user_id', '=', 'a.user_id'),
        )
        .select(['a.topic_id as topicId', 'v.title'])
        .where('a.user_id', '=', studentId)
        .where('s.type', '=', 'mastery')
        .where('a.passed', '=', false)
        .where('a.submitted_at', '>=', weekFrom)
        .where('a.submitted_at', '<', to)
        .where((eb) => eb.or([eb('p.state', 'is', null), eb('p.state', '!=', 'mastered')]))
        .orderBy('a.submitted_at', 'desc')
        .execute(),
      this.db
        .selectFrom('topic_progress as p')
        .innerJoin('topics as t', 't.id', 'p.topic_id')
        .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
        .select(['p.topic_id as topicId', 'v.title'])
        .where('p.user_id', '=', studentId)
        .where('p.next_review_at', '<', to)
        .orderBy('p.next_review_at')
        .execute(),
    ]);
    const seen = new Set<string>();
    const out: {
      topicId: string;
      title: Record<string, string | undefined>;
      reason: ConcernReason;
    }[] = [];
    const add = (rows: { topicId: string | null; title: unknown }[], reason: ConcernReason) => {
      for (const row of rows) {
        if (!row.topicId || seen.has(row.topicId) || out.length >= MAX_CONCERNS) continue;
        seen.add(row.topicId);
        out.push({
          topicId: row.topicId,
          title: row.title as Record<string, string | undefined>,
          reason,
        });
      }
    };
    add(gaps, 'gap_found');
    add(failed, 'mastery_not_passed');
    add(due, 'review_due');
    return out;
  }

  private text(text: unknown, locale: string): string {
    return pickText(
      text as Record<string, string | undefined>,
      locale,
      this.rules.content.defaultLocale,
    );
  }
}
