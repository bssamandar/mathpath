/**
 * Weekly report (step 6.7a): time per Tashkent day, questions, XP, topics
 * mastered and what needs attention, for the student and their parent only.
 */
import { DEMO_IDS, leagueWeekOf, seedDemoContent } from '@mathpath/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { family, user } from './billing.helpers';
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
const TOPIC = DEMO_IDS.topics[0]!;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

async function keyOf(attemptId: string, position: number) {
  const row = await t.db
    .selectFrom('attempt_items')
    .select('answer_key')
    .where('attempt_id', '=', attemptId)
    .where('position', '=', position)
    .executeTakeFirstOrThrow();
  const key = row.answer_key as { kind: string; correct?: string[]; value?: string };
  return {
    right: key.kind === 'choice' ? { choiceIds: key.correct } : { value: key.value },
    wrong: key.kind === 'choice' ? { choiceIds: ['h'] } : { value: '999999' },
  };
}

type Auth = () => Promise<string>;

async function start(auth: Auth, type: string) {
  const res = await http()
    .post('/api/v1/attempts')
    .set('Authorization', await auth())
    .send({ type, topicId: TOPIC });
  expect([200, 201]).toContain(res.status);
  return res.body as { id: string; itemCount: number };
}

/** Shows a question, waits `minutes` on the fake clock, then answers it. */
async function answer(
  auth: Auth,
  attemptId: string,
  position: number,
  right: boolean,
  minutes = 1,
) {
  await http()
    .get(`/api/v1/attempts/${attemptId}/items/${position}`)
    .set('Authorization', await auth())
    .expect(200);
  t.clock.advance(minutes * MINUTE);
  const key = await keyOf(attemptId, position);
  await http()
    .post(`/api/v1/attempts/${attemptId}/items/${position}/answer`)
    .set('Authorization', await auth())
    .send({ response: right ? key.right : key.wrong })
    .expect(200);
}

const submit = async (auth: Auth, attemptId: string) =>
  http()
    .post(`/api/v1/attempts/${attemptId}/submit`)
    .set('Authorization', await auth())
    .expect(200);

async function report(auth: string, studentId: string, query = '') {
  const res = await http()
    .get(`/api/v1/students/${studentId}/reports/weekly${query}`)
    .set('Authorization', auth);
  return res;
}

describe('weekly report', () => {
  it('counts time per Tashkent day, questions, XP and what needs attention', async () => {
    const { parent, children } = await family(t);
    const child = children[0]!;
    const auth = child.auth;
    // The fake clock starts on Sunday 15 Nov, 15:00 in Tashkent: the last day of its week.
    const week = leagueWeekOf(t.clock.now());
    expect(week).toBe('2026-11-09');

    const practice = await start(auth, 'practice');
    for (let position = 1; position <= 6; position++) {
      await answer(auth, practice.id, position, true, 2);
    }
    await answer(auth, practice.id, 7, false, 3);
    await submit(auth, practice.id);
    // A mastery test answered mostly wrong: the topic needs attention.
    const test = await start(auth, 'mastery');
    for (let position = 1; position <= test.itemCount; position++) {
      await answer(auth, test.id, position, position === 1, 1);
    }
    await submit(auth, test.id);

    const res = await report(await parent.auth(), child.id, '?locale=ru');
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body).toMatchObject({
      studentId: child.id,
      weekStart: '2026-11-09',
      weekEnd: '2026-11-15',
      minutesActive: 6 * 2 + 3 + 8,
      minutesLastWeek: 0,
      daysActive: 1,
      questionsAnswered: 15,
      topicsMastered: [],
    });
    expect(body.minutesByDay).toEqual([0, 0, 0, 0, 0, 0, 23]);
    expect(body.rightFirstTime).toBeGreaterThanOrEqual(6);
    expect(body.xpEarned).toBeGreaterThanOrEqual(60);
    expect(body.streak).toBe(1);
    expect(body.concerns).toHaveLength(1);
    expect(body.concerns[0]).toMatchObject({ topicId: TOPIC });
    expect(['mastery_not_passed', 'gap_found']).toContain(body.concerns[0].reason);
    expect(body.concerns[0].title).toMatch(/[а-я]/);

    // Next week: this week's time is "last week", and the old report stays the same.
    t.clock.advance(DAY);
    const next = (await report(await child.auth(), child.id)).body;
    expect(next).toMatchObject({ weekStart: '2026-11-16', minutesActive: 0, minutesLastWeek: 23 });
    const old = (await report(await parent.auth(), child.id, '?weekStart=2026-11-09')).body;
    expect(old).toMatchObject({ minutesActive: 23, streak: 0 });
  });

  it('lists topics mastered this week', async () => {
    const { parent, children } = await family(t);
    const child = children[0]!;
    const auth = child.auth;
    const practice = await start(auth, 'practice');
    for (let position = 1; position <= 6; position++)
      await answer(auth, practice.id, position, true);
    const test = await start(auth, 'mastery');
    for (let position = 1; position <= test.itemCount; position++) {
      await answer(auth, test.id, position, true);
    }
    await submit(auth, test.id);
    const body = (await report(await parent.auth(), child.id)).body;
    expect(body.topicsMastered).toEqual([{ topicId: TOPIC, title: expect.any(String) }]);
    expect(body.concerns).toEqual([]);
  });

  it('is for the student and their parent only, and checks the week', async () => {
    const { parent, children } = await family(t);
    const child = children[0]!;
    const stranger = await family(t);
    expect((await report(await stranger.parent.auth(), child.id)).status).toBe(404);
    expect((await report(await stranger.children[0]!.auth(), child.id)).status).toBe(404);
    const auth = await parent.auth();
    expect((await report(auth, child.id, '?weekStart=2026-11-11')).status).toBe(422);
    expect((await report(auth, child.id, '?weekStart=2026-11-30')).status).toBe(422);
    expect((await report(auth, child.id, '?weekStart=2026-11-02')).status).toBe(200);
    const admin = await user(t, ['admin']);
    // Staff have no object-level access to a child's report.
    expect((await report(await admin.auth(), child.id)).status).toBe(404);
  });
});
