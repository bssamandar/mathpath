/**
 * Gamification (step 6.6a): XP only from server results, once per source,
 * within the daily cap; levels, streaks, badges and daily quests.
 */
import { randomUUID } from 'node:crypto';
import { DEMO_IDS, newId, seedDemoContent } from '@mathpath/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tashkentDay } from '../src/assessment/policy';
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
const TOPIC = DEMO_IDS.topics[0]!;
const DAY = 24 * 60 * 60 * 1000;

interface Me {
  id: string;
  auth: () => Promise<string>;
}

async function learner(role: 'student' | 'parent' = 'student'): Promise<Me> {
  const id = newId();
  await t.db.insertInto('users').values({ id, first_name: 'Aziz' }).execute();
  await t.db.insertInto('user_roles').values({ user_id: id, role }).execute();
  // A fresh session each time: tests move the clock past the access token's life.
  const auth = async () => {
    const session = await t.app
      .get(SessionService)
      .start(
        id,
        { ipPrefix: null, userAgentSummary: null, requestId: null, automationSuspected: false },
        'password',
      );
    return `Bearer ${session.accessToken}`;
  };
  return { id, auth };
}

async function start(auth: string, type: string) {
  const res = await http()
    .post('/api/v1/attempts')
    .set('Authorization', auth)
    .send({ type, topicId: TOPIC });
  if (res.status !== 201) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; itemCount: number };
}

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

const right = async (attemptId: string, position: number) => {
  const key = await keyOf(attemptId, position);
  return key.kind === 'choice' ? { choiceIds: key.correct } : { value: key.value };
};
const wrong = async (attemptId: string, position: number) =>
  (await keyOf(attemptId, position)).kind === 'choice' ? { choiceIds: ['h'] } : { value: '999999' };

async function answer(
  auth: string,
  attemptId: string,
  position: number,
  response: object,
  key?: string,
) {
  let req = http()
    .post(`/api/v1/attempts/${attemptId}/items/${position}/answer`)
    .set('Authorization', auth);
  if (key) req = req.set('Idempotency-Key', key);
  const res = await req.send({ response });
  expect(res.status).toBe(200);
  return res.body as {
    correct: boolean | null;
    reward?: { xp: number; badges: string[]; questsCompleted: { code: string; target: number }[] };
  };
}

async function submit(auth: string, attemptId: string) {
  const res = await http()
    .post(`/api/v1/attempts/${attemptId}/submit`)
    .set('Authorization', auth)
    .expect(200);
  return res.body as {
    passed: boolean | null;
    reward: { xp: number; badges: string[]; questsCompleted: { code: string; target: number }[] };
  };
}

async function summary(auth: string) {
  const res = await http().get('/api/v1/me/gamification').set('Authorization', auth).expect(200);
  return res.body as {
    xpTotal: number;
    level: number;
    levelProgress: number;
    xpLeftToday: number;
    streak: { current: number; longest: number; freezesLeft: number; activeToday: boolean };
    badges: { code: string; awardedAt: string }[];
    quests: { code: string; progress: number; target: number; completed: boolean }[];
  };
}

/** One practice answer right on the first try, in a fresh set that is then finished. */
async function oneRight(me: Me) {
  const auth = await me.auth();
  const attempt = await start(auth, 'practice');
  await answer(auth, attempt.id, 1, await right(attempt.id, 1));
  await submit(auth, attempt.id);
}

describe('XP for practice', () => {
  it('pays a first-try right answer once, and nothing after a mistake', async () => {
    const me = await learner();
    const auth = await me.auth();
    expect(await summary(auth)).toMatchObject({
      xpTotal: 0,
      level: 1,
      xpLeftToday: 400,
      streak: { current: 0, activeToday: false },
      badges: [],
    });

    const attempt = await start(auth, 'practice');
    const key = randomUUID();
    const first = await answer(auth, attempt.id, 1, await right(attempt.id, 1), key);
    expect(first.reward).toEqual({ xp: 10, badges: ['first_correct'], questsCompleted: [] });
    // A retried request gets the same answer and pays nothing more.
    const replay = await answer(auth, attempt.id, 1, await right(attempt.id, 1), key);
    expect(replay.reward).toEqual(first.reward);

    // Wrong, then right: learning still counts for the streak, but no XP.
    const miss = await answer(auth, attempt.id, 2, await wrong(attempt.id, 2));
    expect(miss.reward).toEqual({ xp: 0, badges: [], questsCompleted: [] });
    const late = await answer(auth, attempt.id, 2, await right(attempt.id, 2));
    expect(late).toMatchObject({ correct: true, reward: { xp: 0 } });

    const after = await summary(auth);
    expect(after).toMatchObject({
      xpTotal: 10,
      xpLeftToday: 390,
      streak: { current: 1, longest: 1, activeToday: true },
      badges: [{ code: 'first_correct' }],
    });
    expect(after.quests).toEqual([
      { code: 'correct_5', progress: 1, target: 5, completed: false },
      { code: 'xp_50', progress: 10, target: 50, completed: false },
      { code: 'finish_set', progress: 0, target: 1, completed: false },
    ]);
    const ledger = await t.db.selectFrom('xp_ledger').selectAll().execute();
    expect(ledger).toHaveLength(1);
  });

  it('completes daily quests, pays them once, and shows the reward on the result', async () => {
    const me = await learner();
    const auth = await me.auth();
    const attempt = await start(auth, 'practice');
    const rewards = [];
    for (let position = 1; position <= 5; position++) {
      rewards.push(
        (await answer(auth, attempt.id, position, await right(attempt.id, position))).reward,
      );
    }
    // The fifth right answer finishes both "5 right" and "50 XP": 10 + 30 + 30.
    expect(rewards[4]).toEqual({
      xp: 70,
      badges: [],
      questsCompleted: [
        { code: 'xp_50', target: 50 },
        { code: 'correct_5', target: 5 },
      ],
    });

    const result = await submit(auth, attempt.id);
    expect(result.reward).toEqual({
      xp: 30,
      badges: [],
      questsCompleted: [{ code: 'finish_set', target: 1 }],
    });
    // Submitting again shows the same reward and pays nothing more.
    expect((await submit(auth, attempt.id)).reward).toEqual(result.reward);

    const s = await summary(auth);
    expect(s.xpTotal).toBe(50 + 60 + 30);
    expect(s.quests.every((q) => q.completed)).toBe(true);
    // Quest XP does not count towards the daily XP quest, or quests would feed themselves.
    const xpQuest = await t.db
      .selectFrom('user_quests')
      .select('progress')
      .where('user_id', '=', me.id)
      .where('code', '=', 'xp_50')
      .executeTakeFirstOrThrow();
    expect(xpQuest.progress).toBe(50);

    // Tomorrow brings new quests.
    t.clock.advance(DAY);
    expect((await summary(await me.auth())).quests.every((q) => q.progress === 0)).toBe(true);
  });

  it('stops practice XP at the daily cap and starts again the next Tashkent day', async () => {
    const me = await learner();
    await t.db
      .insertInto('xp_ledger')
      .values({
        id: newId(),
        user_id: me.id,
        amount: 395,
        reason: 'admin_adjustment',
        source_type: 'test',
        source_id: 'cap',
        day: tashkentDay(t.clock.now()),
        created_at: t.clock.now(),
      })
      .execute();
    await t.db.insertInto('user_stats').values({ user_id: me.id, xp_total: 395 }).execute();

    const auth = await me.auth();
    const attempt = await start(auth, 'practice');
    expect((await answer(auth, attempt.id, 1, await right(attempt.id, 1))).reward?.xp).toBe(5);
    expect((await answer(auth, attempt.id, 2, await right(attempt.id, 2))).reward?.xp).toBe(0);
    expect((await summary(auth)).xpLeftToday).toBe(0);

    t.clock.advance(DAY);
    const next = await me.auth();
    expect((await answer(next, attempt.id, 3, await right(attempt.id, 3))).reward?.xp).toBe(10);
  });
});

describe('XP for tests', () => {
  async function passMastery(auth: string) {
    const practice = await start(auth, 'practice');
    for (let position = 1; position <= 6; position++) {
      await answer(auth, practice.id, position, await right(practice.id, position));
    }
    const test = await start(auth, 'mastery');
    for (let position = 1; position <= test.itemCount; position++) {
      await answer(auth, test.id, position, await right(test.id, position));
    }
    return submit(auth, test.id);
  }

  it('pays a passed mastery test once per topic, even past the daily cap', async () => {
    const me = await learner();
    const auth = await me.auth();
    const first = await passMastery(auth);
    expect(first.passed).toBe(true);
    expect(first.reward.xp).toBe(50 + 30); // mastery + "finish a set"
    expect(first.reward.badges).toContain('mastery_1');

    // Fill today's cap, then pass the same topic again: no second mastery XP.
    await t.db
      .insertInto('xp_ledger')
      .values({
        id: newId(),
        user_id: me.id,
        amount: 400,
        reason: 'admin_adjustment',
        source_type: 'test',
        source_id: 'cap',
        day: tashkentDay(t.clock.now()),
        created_at: t.clock.now(),
      })
      .execute();
    const test = await start(auth, 'mastery');
    for (let position = 1; position <= test.itemCount; position++) {
      await answer(auth, test.id, position, await right(test.id, position));
    }
    expect((await submit(auth, test.id)).reward.xp).toBe(0);
    const masteries = await t.db
      .selectFrom('xp_ledger')
      .select('amount')
      .where('user_id', '=', me.id)
      .where('reason', '=', 'mastery_passed')
      .execute();
    expect(masteries).toEqual([{ amount: 50 }]);
  });
});

describe('streaks', () => {
  it('grows by day, is kept by an earned freeze, and resets after a longer gap', async () => {
    const me = await learner();
    for (let day = 0; day < 7; day++) {
      await oneRight(me);
      t.clock.advance(DAY);
    }
    const week = await summary(await me.auth());
    expect(week.streak).toMatchObject({
      current: 7,
      longest: 7,
      freezesLeft: 1,
      activeToday: false,
    });
    expect(week.badges.map((b) => b.code)).toEqual(
      expect.arrayContaining(['first_correct', 'streak_3', 'streak_7']),
    );

    // One missed day uses the freeze.
    t.clock.advance(DAY);
    await oneRight(me);
    expect((await summary(await me.auth())).streak).toMatchObject({ current: 8, freezesLeft: 0 });

    // Two missed days with no freeze left: the visible streak drops to 0, then starts again.
    t.clock.advance(3 * DAY);
    expect((await summary(await me.auth())).streak.current).toBe(0);
    await oneRight(me);
    expect((await summary(await me.auth())).streak).toMatchObject({ current: 1, longest: 8 });
  });
});

describe('access', () => {
  it('is for learners only and needs a session', async () => {
    await http().get('/api/v1/me/gamification').expect(401);
    const parent = await learner('parent');
    await http()
      .get('/api/v1/me/gamification')
      .set('Authorization', await parent.auth())
      .expect(403);
  });
});
