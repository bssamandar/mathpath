/**
 * Weekly leagues (step 6.6b): joining with the first XP of the week, groups
 * by tier and grade band, nicknames only, the leaderboard consent, and the
 * weekly close.
 */
import { closeFinishedLeagues, leagueWeekOf, newId } from '@mathpath/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUSINESS_RULES } from '../src/config/tokens';
import { GamificationService } from '../src/gamification/gamification.service';
import type { AppConfig } from '@mathpath/config';
import { user } from './billing.helpers';
import { browser, createTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());
const WEEK = 7 * 24 * 60 * 60 * 1000;

interface Child {
  id: string;
  auth: () => Promise<string>;
  consentId: string;
}

async function child(
  options: {
    grade?: number;
    nickname?: string;
    approved?: boolean;
    lastName?: string;
    leaderboard?: boolean;
  } = {},
): Promise<Child> {
  const parent = await user(t, ['parent']);
  const kid = await user(t, ['student']);
  if (options.lastName) {
    await t.db
      .updateTable('users')
      .set({ last_name: options.lastName })
      .where('id', '=', kid.id)
      .execute();
  }
  await t.db
    .insertInto('student_profiles')
    .values({
      user_id: kid.id,
      nickname: options.nickname ?? `kid-${kid.id.slice(-4)}`,
      nickname_status: options.approved === false ? 'pending' : 'approved',
      grade: options.grade ?? 5,
      birth_year: null,
      avatar_code: 'fox',
      pin_hash: 'not-used',
      daily_time_limit_min: null,
    })
    .execute();
  const consentId = newId();
  await t.db
    .insertInto('consents')
    .values({
      id: consentId,
      parent_id: parent.id,
      child_id: kid.id,
      policy_version: 'test',
      scopes: options.leaderboard === false ? ['learning'] : ['learning', 'leaderboard'],
      method: 'otp_confirmed',
    })
    .execute();
  await t.db
    .insertInto('parent_child_links')
    .values({ parent_id: parent.id, child_id: kid.id, consent_id: consentId })
    .execute();
  return { ...kid, consentId };
}

/** Earns XP the way the assessment module does: `n` first-try right answers. */
async function earn(userId: string, n = 1) {
  const gamification = t.app.get(GamificationService);
  for (let i = 0; i < n; i++) {
    await t.db.transaction().execute((trx) =>
      gamification.practiceAnswered(trx, {
        userId,
        itemId: newId(),
        correct: true,
        firstTry: true,
      }),
    );
  }
}

async function league(auth: string) {
  const res = await http().get('/api/v1/leagues/current').set('Authorization', auth).expect(200);
  return res.body as {
    status: 'active' | 'not_joined' | 'off';
    weekStart: string;
    endsAt: string;
    tier: number;
    tiers: number;
    zones: { up: number; down: number };
    standings: {
      rank: number;
      nickname: string;
      avatarCode: string | null;
      weeklyXp: number;
      isMe: boolean;
    }[];
    lastWeek: { tier: number; rank: number; outcome: string } | null;
  };
}

describe('weekly leagues', () => {
  it('joins with the first XP and ranks by weekly XP, showing nicknames only', async () => {
    const aziza = await child({ nickname: 'Yulduz', lastName: 'Karimova' });
    const bekzod = await child({ approved: false, lastName: 'Rahimov' });
    await child({ leaderboard: false }).then((c) => earn(c.id, 3));

    const before = await league(await aziza.auth());
    expect(before).toMatchObject({ status: 'not_joined', tier: 1, tiers: 5, standings: [] });
    expect(before.weekStart).toBe(leagueWeekOf(t.clock.now()));

    await earn(aziza.id, 2);
    await earn(bekzod.id, 3);
    const view = await league(await aziza.auth());
    expect(view.status).toBe('active');
    expect(new Date(view.endsAt).getTime()).toBeGreaterThan(t.clock.now().getTime());
    // A moderated nickname, or the first name and last initial; never a full name.
    expect(view.standings).toEqual([
      { rank: 1, nickname: 'Aziza R.', avatarCode: 'fox', weeklyXp: 30, isMe: false },
      { rank: 2, nickname: 'Yulduz', avatarCode: 'fox', weeklyXp: 20, isMe: true },
    ]);
    const text = JSON.stringify(view);
    expect(text).not.toContain('Karimova');
    expect(text).not.toContain('Rahimov');
    expect(text).not.toMatch(/"(first|last)_?[nN]ame"/);
    // Two learners: one place goes up, nobody goes down from tier 1.
    expect(view.zones).toEqual({ up: 1, down: 0 });
  });

  it('keeps grade bands apart and opens a new group when one is full', async () => {
    const rules = t.app.get<AppConfig>(BUSINESS_RULES).gamification.leagues;
    const young = await child({ grade: 3 });
    await earn(young.id);
    const others: Child[] = [];
    for (let i = 0; i <= rules.size; i++) {
      const c = await child({ grade: 6 });
      others.push(c);
      await earn(c.id);
    }
    expect((await league(await young.auth())).standings).toHaveLength(1);
    expect((await league(await others[0]!.auth())).standings).toHaveLength(rules.size);
    expect((await league(await others.at(-1)!.auth())).standings).toHaveLength(1);
    const groups = await t.db
      .selectFrom('leagues')
      .select(['band', 'cohort'])
      .orderBy('band')
      .orderBy('cohort')
      .execute();
    expect(groups).toEqual([
      { band: 0, cohort: 1 },
      { band: 1, cohort: 1 },
      { band: 1, cohort: 2 },
    ]);
  });

  it('switches off at once when the parent withdraws the consent', async () => {
    const stays = await child();
    const leaves = await child();
    await earn(stays.id);
    await earn(leaves.id, 2);
    expect((await league(await stays.auth())).standings).toHaveLength(2);

    await t.db
      .updateTable('consents')
      .set({ revoked_at: t.clock.now() })
      .where('id', '=', leaves.consentId)
      .execute();
    expect((await league(await stays.auth())).standings.map((s) => s.isMe)).toEqual([true]);
    const off = await league(await leaves.auth());
    expect(off).toMatchObject({ status: 'off', standings: [], lastWeek: null });
    await earn(leaves.id);
    const xp = await t.db
      .selectFrom('league_members')
      .select('weekly_xp')
      .where('user_id', '=', leaves.id)
      .executeTakeFirstOrThrow();
    expect(xp.weekly_xp).toBe(20);
  });

  it('closes the week, moves the winner up and starts a fresh league', async () => {
    const rules = t.app.get<AppConfig>(BUSINESS_RULES).gamification.leagues;
    const winner = await child();
    const second = await child();
    await earn(winner.id, 3);
    await earn(second.id, 1);

    t.clock.advance(WEEK);
    expect(await closeFinishedLeagues(t.db, rules, t.clock.now())).toBe(1);

    const next = await league(await winner.auth());
    expect(next).toMatchObject({
      status: 'not_joined',
      tier: 2,
      lastWeek: { tier: 1, rank: 1, outcome: 'promoted' },
    });
    expect((await league(await second.auth())).lastWeek).toEqual({
      tier: 1,
      rank: 2,
      outcome: 'stayed',
    });

    // The winner's first XP this week puts them in a tier-2 league.
    await earn(winner.id);
    expect(await league(await winner.auth())).toMatchObject({
      status: 'active',
      tier: 2,
      zones: { up: 1, down: 0 },
      standings: [{ rank: 1, weeklyXp: 10, isMe: true }],
    });
  });

  it('is for learners only', async () => {
    await http().get('/api/v1/leagues/current').expect(401);
    const parent = await user(t, ['parent']);
    await http()
      .get('/api/v1/leagues/current')
      .set('Authorization', await parent.auth())
      .expect(403);
  });
});
