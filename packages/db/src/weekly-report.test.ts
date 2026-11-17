import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from './ids';
import type { Database } from './schema';
import { DEMO_IDS, seedDemoContent } from './seeds/demo-content';
import { createTestDb } from './testing';
import { claimReportSms, finishReportSms, weeklyReportRecipients } from './weekly-report';

// Sunday 2026-12-06, 19:00 in Tashkent; the week started on Monday 2026-11-30.
const NOW = new Date('2026-12-06T14:00:00Z');
const WEEK = '2026-11-30';
const MIN = 60_000;

describe('weekly report recipients', () => {
  let db: Kysely<Database>;
  let assessmentId: string;
  let templateVersionId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoContent(db, NOW);
    templateVersionId = (
      await db.selectFrom('question_template_versions').select('id').executeTakeFirstOrThrow()
    ).id;
    assessmentId = newId();
    await db
      .insertInto('assessments')
      .values({
        id: assessmentId,
        type: 'practice',
        scope_type: 'topic',
        scope_id: DEMO_IDS.topics[0],
        blueprint: {},
      })
      .execute();
  });
  afterEach(async () => {
    await db.destroy();
  });

  async function parent(options: { phone?: string | null; verified?: boolean } = {}) {
    const id = newId();
    const phone =
      options.phone === undefined ? `+99890${String(Math.random()).slice(2, 9)}` : options.phone;
    await db
      .insertInto('users')
      .values({
        id,
        first_name: 'Ota',
        phone_e164: phone,
        phone_verified_at: options.verified === false ? null : NOW,
        locale: 'uz-Latn',
      })
      .execute();
    return id;
  }

  async function child(parentId: string, name: string, revoked = false) {
    const id = newId();
    const consent = newId();
    await db.insertInto('users').values({ id, first_name: name }).execute();
    await db
      .insertInto('consents')
      .values({
        id: consent,
        parent_id: parentId,
        child_id: id,
        policy_version: 'test',
        scopes: ['learning'],
        method: 'otp_confirmed',
        revoked_at: revoked ? NOW : null,
      })
      .execute();
    await db
      .insertInto('parent_child_links')
      .values({ parent_id: parentId, child_id: id, consent_id: consent })
      .execute();
    return id;
  }

  /** `count` answered questions, each `seconds` long, ending at `at`. */
  async function practised(studentId: string, at: Date, count: number, seconds: number) {
    const attemptId = newId();
    await db
      .insertInto('attempts')
      .values({
        id: attemptId,
        user_id: studentId,
        assessment_id: assessmentId,
        topic_id: null,
        status: 'submitted',
        submitted_at: at,
      })
      .execute();
    await db
      .insertInto('attempt_items')
      .values(
        Array.from({ length: count }, (_, i) => ({
          id: newId(),
          attempt_id: attemptId,
          position: i + 1,
          template_version_id: templateVersionId,
          seed: '1',
          params: {},
          presented: {},
          answer_key: {},
          feedback: {},
          served_at: new Date(at.getTime() - seconds * 1000),
          answered_at: at,
        })),
      )
      .execute();
  }

  async function subscribe(
    ownerId: string,
    status: 'active' | 'trialing',
    endsIn = 10 * 1440 * MIN,
  ) {
    await db
      .insertInto('subscriptions')
      .values({
        id: newId(),
        owner_id: ownerId,
        order_id: null,
        plan_code: 'family-month',
        status,
        seats: 1,
        price_tiyin: 0,
        current_period_start: new Date(NOW.getTime() - 1440 * MIN),
        current_period_end: new Date(NOW.getTime() + endsIn),
      })
      .execute();
  }

  const query = (audience: 'subscribers' | 'active_parents' = 'subscribers', limit = 100) =>
    weeklyReportRecipients(db, { weekStart: WEEK, now: NOW, audience, limit });

  it('sums each active child’s week, capping a question at five minutes', async () => {
    const p = await parent();
    await subscribe(p, 'active');
    const aziz = await child(p, 'Aziz');
    const bona = await child(p, 'Bona');
    await child(p, 'Idle');
    await practised(aziz, new Date(NOW.getTime() - 60 * MIN), 10, 60);
    await practised(aziz, new Date(NOW.getTime() - 120 * MIN), 2, 3600);
    await practised(bona, new Date(NOW.getTime() - 30 * MIN), 3, 120);
    // Last week does not count.
    await practised(bona, new Date('2026-11-29T10:00:00Z'), 50, 60);
    await db
      .insertInto('topic_progress')
      .values({ user_id: aziz, topic_id: DEMO_IDS.topics[0], state: 'mastered', mastered_at: NOW })
      .execute();

    const [r, ...rest] = await query();
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ parentId: p, locale: 'uz-Latn' });
    expect(r!.children).toEqual([
      { name: 'Aziz', minutes: 20, questions: 12, mastered: 1 },
      { name: 'Bona', minutes: 6, questions: 3, mastered: 0 },
    ]);
  });

  it('keeps to the audience: no trial, ended, unverified or unconsented families', async () => {
    const at = new Date(NOW.getTime() - 60 * MIN);
    const trial = await parent();
    await subscribe(trial, 'trialing');
    await practised(await child(trial, 'T'), at, 1, 60);
    const ended = await parent();
    await subscribe(ended, 'active', -MIN);
    await practised(await child(ended, 'E'), at, 1, 60);
    const unverified = await parent({ verified: false });
    await subscribe(unverified, 'active');
    await practised(await child(unverified, 'U'), at, 1, 60);
    const revoked = await parent();
    await subscribe(revoked, 'active');
    await practised(await child(revoked, 'R', true), at, 1, 60);

    expect(await query()).toEqual([]);
    // Without the subscription rule, the trial and ended families are included.
    expect((await query('active_parents')).map((r) => r.parentId).sort()).toEqual(
      [trial, ended].sort(),
    );
  });

  it('skips parents already claimed this week and honours the limit', async () => {
    const at = new Date(NOW.getTime() - 60 * MIN);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const p = await parent();
      await subscribe(p, 'active');
      await practised(await child(p, `C${i}`), at, 1, 60);
      ids.push(p);
    }
    ids.sort();
    expect((await query('subscribers', 2)).map((r) => r.parentId)).toEqual(ids.slice(0, 2));

    expect(await claimReportSms(db, ids[0]!, WEEK, 1)).toBe(true);
    expect(await claimReportSms(db, ids[0]!, WEEK, 1)).toBe(false);
    expect((await query()).map((r) => r.parentId)).toEqual(ids.slice(1));

    await finishReportSms(db, ids[0]!, WEEK, { ok: false, failure: 'Eskiz 500' }, NOW);
    const row = await db
      .selectFrom('report_sms_log')
      .selectAll()
      .where('parent_id', '=', ids[0]!)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'failed', failure: 'Eskiz 500', children: 1 });
    // A finished row is not changed again.
    await finishReportSms(db, ids[0]!, WEEK, { ok: true }, NOW);
    expect(
      (await db.selectFrom('report_sms_log').select('status').executeTakeFirstOrThrow()).status,
    ).toBe('failed');
  });
});
