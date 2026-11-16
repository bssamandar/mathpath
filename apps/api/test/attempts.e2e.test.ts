import { randomUUID } from 'node:crypto';
import { DEMO_IDS, newId, type Role, seedDemoContent } from '@mathpath/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionService } from '../src/identity/session.service';
import { browser, createTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
  await seedDemoContent(t.db);
});
afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());
const FREE_TOPIC = DEMO_IDS.topics[0]!;
const PAID_TOPIC = DEMO_IDS.topics[1]!;

async function learner(roles: Role[] = ['student']): Promise<{ id: string; auth: string }> {
  const id = newId();
  await t.db.insertInto('users').values({ id, first_name: 'Aziz' }).execute();
  await t.db
    .insertInto('user_roles')
    .values(roles.map((role) => ({ user_id: id, role })))
    .execute();
  const session = await t.app
    .get(SessionService)
    .start(
      id,
      { ipPrefix: null, userAgentSummary: null, requestId: null, automationSuspected: false },
      'password',
    );
  return { id, auth: `Bearer ${session.accessToken}` };
}

async function start(auth: string, type: string, topicId: string = FREE_TOPIC, status = 201) {
  const res = await http()
    .post('/api/v1/attempts')
    .set('Authorization', auth)
    .send({ type, topicId });
  if (res.status !== status) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; itemCount: number; status: string; type: string };
}

/** The server-side key of an item, read straight from the database. */
async function keyOf(attemptId: string, position: number) {
  const row = await t.db
    .selectFrom('attempt_items')
    .select('answer_key')
    .where('attempt_id', '=', attemptId)
    .where('position', '=', position)
    .executeTakeFirstOrThrow();
  return row.answer_key as
    | { kind: 'choice'; correct: string[] }
    | { kind: 'number' | 'fraction'; value: string };
}

const rightAnswer = (key: Awaited<ReturnType<typeof keyOf>>) =>
  key.kind === 'choice' ? { choiceIds: key.correct } : { value: key.value };
const wrongAnswer = (key: Awaited<ReturnType<typeof keyOf>>) =>
  key.kind === 'choice' ? { choiceIds: ['h'] } : { value: '999999' };

const answer = (auth: string, attemptId: string, position: number, response: object) =>
  http()
    .post(`/api/v1/attempts/${attemptId}/items/${position}/answer`)
    .set('Authorization', auth)
    .send({ response });

describe('practice', () => {
  it('deals an easy-to-hard set and hides the answer key', async () => {
    const me = await learner();
    const attempt = await start(me.auth, 'practice');
    expect(attempt).toMatchObject({ type: 'practice', status: 'in_progress', itemCount: 8 });

    const item = await http()
      .get(`/api/v1/attempts/${attempt.id}/items/1?locale=ru`)
      .set('Authorization', me.auth)
      .expect(200);
    expect(item.body).toMatchObject({ position: 1, closed: false });
    expect(item.body.stem).toMatch(/[а-я]/);
    const text = JSON.stringify(item.body);
    for (const secret of ['answer', 'correct', 'solution', '"hints"', 'expr']) {
      expect(text).not.toContain(secret);
    }

    const levels = await t.db
      .selectFrom('attempt_items as i')
      .innerJoin('question_template_versions as v', 'v.id', 'i.template_version_id')
      .select(['i.position', 'v.difficulty'])
      .where('i.attempt_id', '=', attempt.id)
      .orderBy('i.position')
      .execute();
    const difficulties = levels.map((l) => l.difficulty);
    expect(difficulties).toEqual([...difficulties].sort((a, b) => a - b));
    // All three demo templates of the topic appear in a set of eight.
    const served = await t.db
      .selectFrom('attempt_items')
      .select('template_version_id')
      .distinct()
      .where('attempt_id', '=', attempt.id)
      .execute();
    expect(served).toHaveLength(3);
  });

  it('resumes the open set instead of dealing a new one', async () => {
    const me = await learner();
    const first = await start(me.auth, 'practice');
    const again = await start(me.auth, 'practice', FREE_TOPIC, 200);
    expect(again.id).toBe(first.id);
  });

  it('gives a hint after the first mistake and the solution after the second', async () => {
    const me = await learner();
    const attempt = await start(me.auth, 'practice');
    const key = await keyOf(attempt.id, 1);

    const first = await answer(me.auth, attempt.id, 1, wrongAnswer(key)).expect(200);
    expect(first.body).toMatchObject({ accepted: true, correct: false, triesLeft: 1 });
    expect(first.body.solution).toBeNull();

    const second = await answer(me.auth, attempt.id, 1, wrongAnswer(key)).expect(200);
    expect(second.body).toMatchObject({ correct: false, triesLeft: 0, hint: null });
    expect(second.body.correctAnswer).toEqual(expect.any(String));
    expect(second.body.correctAnswer.length).toBeGreaterThan(0);

    await answer(me.auth, attempt.id, 1, rightAnswer(key)).expect(409);
    const item = await http()
      .get(`/api/v1/attempts/${attempt.id}/items/1`)
      .set('Authorization', me.auth)
      .expect(200);
    expect(item.body).toMatchObject({ closed: true, lastFeedback: { correct: false } });
  });

  it('marks a right answer and does not count a typo as a try', async () => {
    const me = await learner();
    const attempt = await start(me.auth, 'practice');
    // Find a typed-answer item: a typo only exists there.
    let position = 1;
    while ((await keyOf(attempt.id, position)).kind === 'choice') position += 1;
    const typo = await answer(me.auth, attempt.id, position, { value: '3,,5' }).expect(200);
    expect(typo.body).toEqual({ accepted: false, correct: null, reason: 'unreadable' });

    const key = await keyOf(attempt.id, position);
    const right = await answer(me.auth, attempt.id, position, rightAnswer(key)).expect(200);
    expect(right.body).toMatchObject({ accepted: true, correct: true, triesLeft: 0 });
    const row = await t.db
      .selectFrom('attempt_items')
      .select(['tries', 'is_correct', 'served_at', 'answered_at'])
      .where('attempt_id', '=', attempt.id)
      .where('position', '=', position)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ tries: 1, is_correct: true });
    expect(row.answered_at).not.toBeNull();
  });

  it('returns the first result for a retried answer with the same Idempotency-Key', async () => {
    const me = await learner();
    const attempt = await start(me.auth, 'practice');
    const key = await keyOf(attempt.id, 1);
    const requestKey = randomUUID();
    const send = () =>
      http()
        .post(`/api/v1/attempts/${attempt.id}/items/1/answer`)
        .set('Authorization', me.auth)
        .set('Idempotency-Key', requestKey)
        .send({ response: wrongAnswer(key) })
        .expect(200);
    const one = await send();
    const two = await send();
    expect(two.body).toEqual(one.body);
    const row = await t.db
      .selectFrom('attempt_items')
      .select('tries')
      .where('attempt_id', '=', attempt.id)
      .where('position', '=', 1)
      .executeTakeFirstOrThrow();
    expect(row.tries).toBe(1);
  });

  it('stops free practice at the daily limit and starts again the next Tashkent day', async () => {
    const me = await learner();
    // 20 exercises a day on the free plan (config/limits.yaml).
    await t.db
      .insertInto('daily_usage')
      .values({ user_id: me.id, day: '2026-11-15', exercises_count: 19 })
      .execute();
    const attempt = await start(me.auth, 'practice');
    const k1 = await keyOf(attempt.id, 1);
    await answer(me.auth, attempt.id, 1, rightAnswer(k1)).expect(200);
    const k2 = await keyOf(attempt.id, 2);
    const blocked = await answer(me.auth, attempt.id, 2, rightAnswer(k2)).expect(402);
    expect(blocked.body.code).toBe('DAILY_LIMIT_REACHED');

    const status = await http()
      .get(`/api/v1/topics/${FREE_TOPIC}/assessment-status`)
      .set('Authorization', me.auth)
      .expect(200);
    expect(status.body.dailyExercisesLeft).toBe(0);

    t.clock.advance(14 * 60 * 60 * 1000); // 10:00Z + 14 h = 05:00 next day in Tashkent
    const tomorrow = await t.app
      .get(SessionService)
      .start(
        me.id,
        { ipPrefix: null, userAgentSummary: null, requestId: null, automationSuspected: false },
        'password',
      );
    await answer(`Bearer ${tomorrow.accessToken}`, attempt.id, 2, rightAnswer(k2)).expect(200);
  });

  it('refuses a paid topic, someone else’s attempt and a parent', async () => {
    const me = await learner();
    const other = await learner();
    const parent = await learner(['parent']);
    const paid = await start(me.auth, 'practice', PAID_TOPIC, 402);
    expect(paid).toMatchObject({ code: 'PAYMENT_REQUIRED' });
    const attempt = await start(me.auth, 'practice');
    await http()
      .get(`/api/v1/attempts/${attempt.id}/items/1`)
      .set('Authorization', other.auth)
      .expect(404);
    await answer(other.auth, attempt.id, 1, { value: '1' }).expect(404);
    await start(parent.auth, 'practice', FREE_TOPIC, 403);
  });

  it('says which kinds are not available yet', async () => {
    const me = await learner();
    const res = await start(me.auth, 'mock_exam', FREE_TOPIC, 422);
    expect(res).toMatchObject({ code: 'ASSESSMENT_UNAVAILABLE' });
  });
});

describe('mastery test', () => {
  async function practise(auth: string, correct: number) {
    const attempt = await start(auth, 'practice');
    for (let position = 1; position <= correct; position++) {
      await answer(
        auth,
        attempt.id,
        position,
        rightAnswer(await keyOf(attempt.id, position)),
      ).expect(200);
    }
    return attempt;
  }

  it('unlocks after enough correct practice answers', async () => {
    const me = await learner();
    const locked = await start(me.auth, 'mastery', FREE_TOPIC, 409);
    expect(locked).toMatchObject({ code: 'MASTERY_LOCKED' });
    await practise(me.auth, 6);
    const status = await http()
      .get(`/api/v1/topics/${FREE_TOPIC}/assessment-status`)
      .set('Authorization', me.auth)
      .expect(200);
    expect(status.body).toMatchObject({
      questionCount: 3,
      practice: { correct: 6, required: 6 },
      mastery: { unlocked: true, best: null },
      dailyExercisesLeft: 14,
    });
    await start(me.auth, 'mastery');
  });

  it('accepts answers without marking them, then marks all on submit', async () => {
    const me = await learner();
    await practise(me.auth, 6);
    const attempt = await start(me.auth, 'mastery');
    for (let position = 1; position <= attempt.itemCount; position++) {
      const key = await keyOf(attempt.id, position);
      // Seven of eight right: 87.5% passes the 80% mark.
      const response = position === 1 ? wrongAnswer(key) : rightAnswer(key);
      const res = await answer(me.auth, attempt.id, position, response).expect(200);
      expect(res.body).toEqual({ accepted: true, correct: null });
    }
    // A learner may change an answer before submitting.
    await answer(me.auth, attempt.id, 2, rightAnswer(await keyOf(attempt.id, 2))).expect(200);

    const result = await http()
      .post(`/api/v1/attempts/${attempt.id}/submit`)
      .set('Authorization', me.auth)
      .expect(200);
    expect(result.body).toMatchObject({
      type: 'mastery',
      score: 7,
      maxScore: 8,
      passed: true,
      byTopic: [{ topicId: FREE_TOPIC, correct: 7, total: 8 }],
      recommendation: { action: 'continue' },
    });
    expect(result.body.review).toHaveLength(8);
    expect(result.body.review[0]).toMatchObject({ position: 1, correct: false });
    expect(result.body.review[0].correctAnswer).not.toBe('');

    // Submitting twice returns the same result; answering after is refused.
    const again = await http()
      .post(`/api/v1/attempts/${attempt.id}/submit`)
      .set('Authorization', me.auth)
      .expect(200);
    expect(again.body.score).toBe(7);
    const late = await answer(me.auth, attempt.id, 1, { value: '1' }).expect(409);
    expect(late.body.code).toBe('ATTEMPT_CLOSED');

    const status = await http()
      .get(`/api/v1/topics/${FREE_TOPIC}/assessment-status`)
      .set('Authorization', me.auth)
      .expect(200);
    expect(status.body.mastery.best).toMatchObject({ score: 7, maxScore: 8, passed: true });
  });

  it('suggests more practice after a low score', async () => {
    const me = await learner();
    await practise(me.auth, 6);
    const attempt = await start(me.auth, 'mastery');
    const result = await http()
      .post(`/api/v1/attempts/${attempt.id}/submit`)
      .set('Authorization', me.auth)
      .expect(200);
    expect(result.body).toMatchObject({
      score: 0,
      passed: false,
      recommendation: { action: 'retry_practice', topicId: FREE_TOPIC },
    });
  });
});
