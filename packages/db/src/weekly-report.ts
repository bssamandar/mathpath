/**
 * Who gets the Sunday-evening report SMS, and what it says (step 7.4b; UX
 * S11). Read straight from the learning tables, with the same time estimate
 * as the weekly report screen: from showing a question to its answer, at most
 * five minutes each.
 *
 * A parent is included when they have a verified phone, an active account,
 * no report row for this week yet, and at least one linked child (consent
 * not revoked) who answered a question this week. With the `subscribers`
 * audience the parent must also hold a paid subscription that is running now
 * (a free trial does not count).
 */
import { type Kysely, sql } from 'kysely';
import { leagueWeekEnd } from './leagues';
import type { Database, Locale } from './schema';

export type ReportAudience = 'subscribers' | 'active_parents';

export interface ReportChild {
  name: string;
  minutes: number;
  questions: number;
  mastered: number;
}

export interface ReportRecipient {
  parentId: string;
  phone: string;
  locale: Locale;
  children: ReportChild[];
}

export interface RecipientQuery {
  /** The Monday of the reported week (Tashkent time). */
  weekStart: string;
  now: Date;
  audience: ReportAudience;
  /** At most this many parents. */
  limit: number;
}

const MAX_ITEM_SECONDS = 300;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface Row {
  parent_id: string;
  phone_e164: string;
  locale: Locale;
  first_name: string;
  seconds: string | number;
  questions: string | number;
  mastered: string | number;
}

/** Parents who should get this week's report and have not yet, in a stable order. */
export async function weeklyReportRecipients(
  db: Kysely<Database>,
  query: RecipientQuery,
): Promise<ReportRecipient[]> {
  const to = leagueWeekEnd(query.weekStart);
  const from = new Date(to.getTime() - WEEK_MS);
  const subscribersOnly = query.audience === 'subscribers';
  const { rows } = await sql<Row>`
    WITH parents AS (
      SELECT p.id, p.phone_e164, p.locale
      FROM users p
      WHERE p.phone_e164 IS NOT NULL
        AND p.phone_verified_at IS NOT NULL
        AND p.deleted_at IS NULL
        AND p.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM report_sms_log r
          WHERE r.parent_id = p.id AND r.week_start = ${query.weekStart}::date)
        AND (NOT ${subscribersOnly} OR EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.owner_id = p.id AND s.status = 'active'
            AND s.current_period_end > ${query.now}))
        AND EXISTS (SELECT 1 FROM parent_child_links l WHERE l.parent_id = p.id)
    ),
    children AS (
      SELECT pa.id AS parent_id, pa.phone_e164, pa.locale, c.id AS child_id, c.first_name
      FROM parents pa
      JOIN parent_child_links l ON l.parent_id = pa.id
      JOIN consents k ON k.id = l.consent_id AND k.revoked_at IS NULL
      JOIN users c ON c.id = l.child_id AND c.deleted_at IS NULL AND c.status = 'active'
    ),
    active AS (
      SELECT ch.*, act.seconds, act.questions
      FROM children ch
      CROSS JOIN LATERAL (
        SELECT coalesce(sum(least(extract(epoch FROM (i.answered_at - i.served_at)),
                                  ${MAX_ITEM_SECONDS})), 0) AS seconds,
               count(*) AS questions
        FROM attempts a
        JOIN attempt_items i ON i.attempt_id = a.id
        WHERE a.user_id = ch.child_id
          AND i.answered_at >= ${from} AND i.answered_at < ${to}
          AND i.served_at IS NOT NULL
      ) act
      WHERE act.questions > 0
    ),
    chosen AS (
      SELECT DISTINCT parent_id FROM active ORDER BY parent_id LIMIT ${query.limit}
    )
    SELECT a.parent_id, a.phone_e164, a.locale, a.first_name, a.seconds, a.questions,
           (SELECT count(*) FROM topic_progress t
            WHERE t.user_id = a.child_id
              AND t.mastered_at >= ${from} AND t.mastered_at < ${to}) AS mastered
    FROM active a
    JOIN chosen USING (parent_id)
    ORDER BY a.parent_id, a.first_name, a.child_id
  `.execute(db);

  const byParent = new Map<string, ReportRecipient>();
  for (const row of rows) {
    let recipient = byParent.get(row.parent_id);
    if (!recipient) {
      recipient = {
        parentId: row.parent_id,
        phone: row.phone_e164,
        locale: row.locale,
        children: [],
      };
      byParent.set(row.parent_id, recipient);
    }
    recipient.children.push({
      name: row.first_name,
      minutes: Math.round(Number(row.seconds) / 60),
      questions: Number(row.questions),
      mastered: Number(row.mastered),
    });
  }
  return [...byParent.values()];
}

/**
 * Claims a parent for this week before the SMS goes out. False when another
 * run already did, so the message is never sent twice.
 */
export async function claimReportSms(
  db: Kysely<Database>,
  parentId: string,
  weekStart: string,
  children: number,
): Promise<boolean> {
  const row = await db
    .insertInto('report_sms_log')
    .values({ parent_id: parentId, week_start: weekStart, children })
    .onConflict((oc) => oc.columns(['parent_id', 'week_start']).doNothing())
    .returning('parent_id')
    .executeTakeFirst();
  return row !== undefined;
}

/** Records how the send went; a failure is kept, not retried this week. */
export async function finishReportSms(
  db: Kysely<Database>,
  parentId: string,
  weekStart: string,
  outcome: { ok: true } | { ok: false; failure: string },
  at: Date,
): Promise<void> {
  await db
    .updateTable('report_sms_log')
    .set(
      outcome.ok
        ? { status: 'sent', finished_at: at }
        : { status: 'failed', failure: outcome.failure.slice(0, 500), finished_at: at },
    )
    .where('parent_id', '=', parentId)
    .where('week_start', '=', weekStart)
    .where('status', '=', 'sending')
    .execute();
}
