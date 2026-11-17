import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from './ids';
import {
  closeFinishedLeagues,
  gradeBand,
  type LeagueRules,
  leagueOutcome,
  leagueWeekEnd,
  leagueWeekOf,
  leagueZones,
} from './leagues';
import type { Database } from './schema';
import { createTestDb } from './testing';

const RULES: LeagueRules = {
  size: 30,
  promoteTop: 5,
  demoteBottom: 5,
  tiers: 5,
  gradeBands: [4, 7, 11],
};

describe('league weeks', () => {
  it('runs Monday to Sunday in Tashkent time', () => {
    // Sunday 18:59 UTC is Sunday 23:59 in Tashkent; 19:00 UTC is Monday.
    expect(leagueWeekOf(new Date('2026-11-22T18:59:00Z'))).toBe('2026-11-16');
    expect(leagueWeekOf(new Date('2026-11-22T19:00:00Z'))).toBe('2026-11-23');
    expect(leagueWeekOf(new Date('2026-11-16T00:00:00Z'))).toBe('2026-11-16');
    expect(leagueWeekEnd('2026-11-16').toISOString()).toBe('2026-11-22T19:00:00.000Z');
  });

  it('puts grades in bands', () => {
    expect([1, 4, 5, 7, 8, 11].map((g) => gradeBand(g, RULES.gradeBands))).toEqual([
      0, 0, 1, 1, 2, 2,
    ]);
  });
});

describe('league zones', () => {
  it('shrinks with a small league so not everyone moves', () => {
    expect(leagueZones(30, RULES)).toEqual({ up: 5, down: 5 });
    expect(leagueZones(12, RULES)).toEqual({ up: 2, down: 2 });
    expect(leagueZones(3, RULES)).toEqual({ up: 1, down: 0 });
    expect(leagueZones(1, RULES)).toEqual({ up: 1, down: 0 });
  });

  it('never promotes from the top tier or demotes from tier 1', () => {
    expect(leagueOutcome(1, 30, 100, 2, RULES)).toBe('promoted');
    expect(leagueOutcome(1, 30, 100, 5, RULES)).toBe('stayed');
    expect(leagueOutcome(30, 30, 10, 2, RULES)).toBe('demoted');
    expect(leagueOutcome(30, 30, 10, 1, RULES)).toBe('stayed');
    expect(leagueOutcome(15, 30, 50, 2, RULES)).toBe('stayed');
  });
});

describe('closing a week', () => {
  let db: Kysely<Database>;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.destroy();
  });

  async function learner(tier: number) {
    const id = newId();
    await db.insertInto('users').values({ id, first_name: 'A' }).execute();
    await db.insertInto('user_stats').values({ user_id: id, league_tier: tier }).execute();
    return id;
  }

  it('ranks members, moves tiers once, and leaves the current week open', async () => {
    const league = newId();
    await db
      .insertInto('leagues')
      .values({ id: league, week_start: '2026-11-16', tier: 2, band: 1, cohort: 1 })
      .execute();
    const current = newId();
    await db
      .insertInto('leagues')
      .values({ id: current, week_start: '2026-11-23', tier: 1, band: 1, cohort: 1 })
      .execute();
    // Twelve members: two go up and two go down.
    const users: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = await learner(2);
      users.push(id);
      await db
        .insertInto('league_members')
        .values({
          league_id: league,
          user_id: id,
          week_start: '2026-11-16',
          weekly_xp: 200 - i * 10,
          joined_at: new Date(Date.UTC(2026, 10, 16, 6, i)),
        })
        .execute();
    }

    const now = new Date('2026-11-22T19:05:00Z');
    expect(await closeFinishedLeagues(db, RULES, now)).toBe(1);
    expect(await closeFinishedLeagues(db, RULES, now)).toBe(0);

    const rows = await db
      .selectFrom('league_members as m')
      .innerJoin('user_stats as s', 's.user_id', 'm.user_id')
      .select(['m.user_id', 'm.final_rank', 'm.outcome', 's.league_tier'])
      .where('m.league_id', '=', league)
      .orderBy('m.final_rank')
      .execute();
    expect(rows.map((r) => r.user_id)).toEqual(users);
    expect(rows.map((r) => r.outcome)).toEqual([
      'promoted',
      'promoted',
      ...Array(8).fill('stayed'),
      'demoted',
      'demoted',
    ]);
    expect(rows.map((r) => r.league_tier)).toEqual([3, 3, ...Array(8).fill(2), 1, 1]);
    const open = await db.selectFrom('leagues').select(['id', 'closed_at']).execute();
    expect(open.find((l) => l.id === current)?.closed_at).toBeNull();
  });
});
