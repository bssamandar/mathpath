import { DEMO_IDS, newId, type Role, seedDemoContent } from '@mathpath/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionService } from '../src/identity/session.service';
import { browser, createTestApp, type TestApp } from './helpers';

let t: TestApp;
const [MEANING, COMPARING] = DEMO_IDS.topics;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  t = await createTestApp();
  await seedDemoContent(t.db);
  // Billing is not built yet: open every demo topic so the graph can be walked.
  await t.db.updateTable('topics').set({ is_free: true }).execute();
});
afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());
const client = {
  ipPrefix: null,
  userAgentSummary: null,
  requestId: null,
  automationSuspected: false,
};

async function user(
  roles: Role[] = ['student'],
): Promise<{ id: string; auth: () => Promise<string> }> {
  const id = newId();
  await t.db.insertInto('users').values({ id, first_name: 'Dilnoza' }).execute();
  await t.db
    .insertInto('user_roles')
    .values(roles.map((role) => ({ user_id: id, role })))
    .execute();
  // A fresh token per call, so tests can move the clock past token expiry.
  const auth = async () => {
    const session = await t.app.get(SessionService).start(id, client, 'password');
    return `Bearer ${session.accessToken}`;
  };
  return { id, auth };
}

async function start(auth: string, type: string, topicId: string, status = 201) {
  const res = await http()
    .post('/api/v1/attempts')
    .set('Authorization', auth)
    .send({ type, topicId });
  if (res.status !== status) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; itemCount: number };
}

async function answerAll(
  auth: string,
  attemptId: string,
  right: boolean | ((pos: number) => boolean),
) {
  const items = await t.db
    .selectFrom('attempt_items')
    .select(['position', 'answer_key'])
    .where('attempt_id', '=', attemptId)
    .orderBy('position')
    .execute();
  for (const item of items) {
    const key = item.answer_key as { kind: string; correct?: string[]; value?: string };
    const ok = typeof right === 'function' ? right(item.position) : right;
    const response =
      key.kind === 'choice'
        ? { choiceIds: ok ? key.correct : ['h'] }
        : { value: ok ? key.value : '999999' };
    await http()
      .post(`/api/v1/attempts/${attemptId}/items/${item.position}/answer`)
      .set('Authorization', auth)
      .send({ response })
      .expect(200);
  }
}

const submit = async (auth: string, attemptId: string) =>
  (await http().post(`/api/v1/attempts/${attemptId}/submit`).set('Authorization', auth).expect(200))
    .body as {
    passed: boolean | null;
    recommendation: {
      action: string;
      topicId: string | null;
      reason?: string;
      topicTitle: string | null;
    };
  };

async function practise(auth: string, topicId: string) {
  const attempt = await start(auth, 'practice', topicId);
  await answerAll(auth, attempt.id, true);
  await submit(auth, attempt.id);
}

async function master(auth: string, topicId: string) {
  await practise(auth, topicId);
  const test = await start(auth, 'mastery', topicId);
  await answerAll(auth, test.id, true);
  return submit(auth, test.id);
}

async function failMastery(auth: string, topicId: string) {
  await practise(auth, topicId);
  const test = await start(auth, 'mastery', topicId);
  return submit(auth, test.id);
}

describe('gap routing', () => {
  it('sends a failed test to the weak prerequisite, and back after a passed check', async () => {
    const me = await user();
    const auth = await me.auth();
    const failed = await failMastery(auth, COMPARING);
    expect(failed.recommendation).toMatchObject({
      action: 'prerequisite_review',
      topicId: MEANING,
      reason: 'not_mastered',
    });
    expect(failed.recommendation.topicTitle).toBeTruthy();

    const check = await start(auth, 'review', MEANING);
    expect(check.itemCount).toBe(3); // gapRouting.miniCheckItems
    await answerAll(auth, check.id, true);
    const passed = await submit(auth, check.id);
    expect(passed.recommendation).toMatchObject({
      action: 'continue',
      topicId: COMPARING,
      reason: 'gap_refreshed',
    });

    const progress = await t.db
      .selectFrom('topic_progress')
      .select(['topic_id', 'state'])
      .where('user_id', '=', me.id)
      .orderBy('topic_id')
      .execute();
    expect(progress).toEqual([
      { topic_id: MEANING, state: 'mastered' },
      { topic_id: COMPARING, state: 'learning' },
    ]);
    const events = await t.db
      .selectFrom('learning_events')
      .select('type')
      .where('user_id', '=', me.id)
      .orderBy('created_at')
      .execute();
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['mastery_failed', 'gap_routed', 'gap_check_passed']),
    );
  });

  it('puts the prerequisite on the path after a failed check, and rests after the daily limit', async () => {
    const me = await user();
    const auth = await me.auth();
    await failMastery(auth, COMPARING);
    const check = await start(auth, 'review', MEANING);
    const failedCheck = await submit(auth, check.id);
    expect(failedCheck.recommendation).toMatchObject({
      action: 'continue',
      topicId: MEANING,
      reason: 'gap_added_to_path',
    });

    const path = await http()
      .get(`/api/v1/students/${me.id}/learning-path?courseId=${DEMO_IDS.course}`)
      .set('Authorization', auth)
      .expect(200);
    expect(path.body.items.slice(0, 2)).toMatchObject([
      { topicId: MEANING, state: 'learning' },
      { topicId: COMPARING, state: 'learning' },
    ]);

    // One detour a day (gapRouting.maxDetoursPerDay): the next failure rests.
    const again = await start(auth, 'mastery', COMPARING);
    const rest = await submit(auth, again.id);
    expect(rest.recommendation).toMatchObject({ action: 'take_break', reason: 'max_per_day' });
  });

  it('refuses a review that nothing asked for', async () => {
    const me = await user();
    const res = await start(await me.auth(), 'review', MEANING, 409);
    expect(res).toMatchObject({ code: 'REVIEW_NOT_AVAILABLE' });
  });
});

describe('spaced review', () => {
  it('schedules reviews after mastery and moves to longer intervals', async () => {
    const me = await user();
    const passed = await master(await me.auth(), MEANING);
    expect(passed).toMatchObject({
      passed: true,
      recommendation: { action: 'continue', topicId: COMPARING },
    });

    const due = async () =>
      (
        await http()
          .get('/api/v1/me/reviews/due')
          .set('Authorization', await me.auth())
          .expect(200)
      ).body.items as { topicId: string }[];
    expect(await due()).toEqual([]);
    t.clock.advance(DAY + 60_000); // reviewIntervalsDays[0] = 1
    expect((await due()).map((d) => d.topicId)).toEqual([MEANING]);

    const auth = await me.auth();
    const review = await start(auth, 'review', MEANING);
    expect(review.itemCount).toBe(4); // review.items
    await answerAll(auth, review.id, true);
    const result = await submit(auth, review.id);
    expect(result.recommendation).toMatchObject({ action: 'continue', reason: 'review_passed' });
    const row = await t.db
      .selectFrom('topic_progress')
      .select(['review_interval_days', 'review_count', 'state'])
      .where('user_id', '=', me.id)
      .where('topic_id', '=', MEANING)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ review_interval_days: 3, review_count: 1, state: 'mastered' });
    expect(await due()).toEqual([]);
  });

  it('marks a failed review as needing review and suggests practice', async () => {
    const me = await user();
    await master(await me.auth(), MEANING);
    t.clock.advance(DAY + 60_000);
    const auth = await me.auth();
    const review = await start(auth, 'review', MEANING);
    const result = await submit(auth, review.id);
    expect(result.recommendation).toMatchObject({ action: 'retry_practice', topicId: MEANING });
    const course = await http()
      .get(`/api/v1/courses/${DEMO_IDS.course}`)
      .set('Authorization', auth)
      .expect(200);
    const topic = course.body.chapters[0].topics.find((x: { id: string }) => x.id === MEANING);
    expect(topic).toMatchObject({ state: 'needs_review' });
  });
});

describe('progress and steps', () => {
  it('reports progress to the learner and a linked parent only', async () => {
    const me = await user();
    const parent = await user(['parent']);
    const stranger = await user(['parent']);
    const consent = newId();
    await t.db
      .insertInto('consents')
      .values({
        id: consent,
        parent_id: parent.id,
        child_id: me.id,
        policy_version: 'test',
        scopes: ['learning'],
        method: 'otp_confirmed',
      })
      .execute();
    await t.db
      .insertInto('parent_child_links')
      .values({ parent_id: parent.id, child_id: me.id, consent_id: consent })
      .execute();
    await master(await me.auth(), MEANING);

    const url = `/api/v1/students/${me.id}/progress?courseId=${DEMO_IDS.course}`;
    const mine = await http()
      .get(url)
      .set('Authorization', await me.auth())
      .expect(200);
    expect(mine.body.topics[0]).toMatchObject({ topicId: MEANING, state: 'mastered', mastery: 1 });
    expect(mine.body.timeSpentMin).toEqual(expect.any(Number));
    await http()
      .get(url)
      .set('Authorization', await parent.auth())
      .expect(200);
    const other = await http()
      .get(url)
      .set('Authorization', await stranger.auth())
      .expect(404);
    expect(other.body.code).toBe('STUDENT_NOT_FOUND');
  });

  it('completes video and activity steps, not assessed ones', async () => {
    const me = await user();
    const auth = await me.auth();
    await http()
      .post(`/api/v1/topics/${MEANING}/steps/0/complete`)
      .set('Authorization', auth)
      .expect(204);
    await http()
      .post(`/api/v1/topics/${MEANING}/steps/0/complete`)
      .set('Authorization', auth)
      .expect(204);
    const practice = await http()
      .post(`/api/v1/topics/${MEANING}/steps/2/complete`)
      .set('Authorization', auth)
      .expect(409);
    expect(practice.body.code).toBe('STEP_ASSESSED');
    await http()
      .post(`/api/v1/topics/${MEANING}/steps/40/complete`)
      .set('Authorization', auth)
      .expect(404);
    const lesson = await http()
      .get(`/api/v1/topics/${MEANING}/lesson`)
      .set('Authorization', auth)
      .expect(200);
    expect(lesson.body.steps.map((s: { completed: boolean }) => s.completed)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});
