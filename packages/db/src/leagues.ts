/**
 * Weekly league rules shared by the API (standings) and the worker (the
 * weekly close). A week runs Monday to Sunday in Tashkent time (UTC+5, no
 * daylight saving).
 */
import type { Kysely } from 'kysely';
import type { Database, LeagueOutcome } from './schema';

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LeagueRules {
  size: number;
  promoteTop: number;
  demoteBottom: number;
  tiers: number;
  gradeBands: number[];
}

/** Monday (`YYYY-MM-DD`) of the Tashkent week that holds this instant. */
export function leagueWeekOf(now: Date): string {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  return new Date(local.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/** When the week that starts on `weekStart` ends: next Monday 00:00 in Tashkent. */
export function leagueWeekEnd(weekStart: string): Date {
  return new Date(Date.parse(`${weekStart}T00:00:00Z`) + 7 * DAY_MS - TASHKENT_OFFSET_MS);
}

/** The grade band index for a grade: bands end at the listed grades. */
export function gradeBand(grade: number, bands: readonly number[]): number {
  const index = bands.findIndex((upper) => grade <= upper);
  return index === -1 ? bands.length - 1 : index;
}

/**
 * How many go up and down in a league of `members` learners. The zones
 * shrink with a small league, so three learners never all move down:
 * promotion rounds up and demotion rounds down.
 */
export function leagueZones(members: number, rules: LeagueRules): { up: number; down: number } {
  const share = Math.min(1, members / rules.size);
  return {
    up: Math.ceil(rules.promoteTop * share),
    down: Math.floor(rules.demoteBottom * share),
  };
}

/** The outcome for a rank (1 = first) in a league of `members` at `tier`. */
export function leagueOutcome(
  rank: number,
  members: number,
  weeklyXp: number,
  tier: number,
  rules: LeagueRules,
): LeagueOutcome {
  const { up, down } = leagueZones(members, rules);
  if (rank <= up && weeklyXp > 0 && tier < rules.tiers) return 'promoted';
  if (rank > members - down && rank > up && tier > 1) return 'demoted';
  return 'stayed';
}

/**
 * Closes every league of a finished week: writes each member's final rank
 * and outcome and moves their tier for next week. Safe to run again or from
 * two workers: each league is locked and skipped once closed.
 * @returns How many leagues were closed now.
 */
export async function closeFinishedLeagues(
  db: Kysely<Database>,
  rules: LeagueRules,
  now: Date,
): Promise<number> {
  const current = leagueWeekOf(now);
  const open = await db
    .selectFrom('leagues')
    .select('id')
    .where('closed_at', 'is', null)
    .where('week_start', '<', current)
    .orderBy('week_start')
    .execute();
  let closed = 0;
  for (const { id } of open) {
    const done = await db.transaction().execute(async (trx) => {
      const league = await trx
        .selectFrom('leagues')
        .select(['tier', 'closed_at'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (league.closed_at) return false;
      const members = await trx
        .selectFrom('league_members')
        .select(['user_id', 'weekly_xp'])
        .where('league_id', '=', id)
        .orderBy('weekly_xp', 'desc')
        .orderBy('joined_at')
        .orderBy('user_id')
        .execute();
      for (const [index, member] of members.entries()) {
        const rank = index + 1;
        const outcome = leagueOutcome(rank, members.length, member.weekly_xp, league.tier, rules);
        await trx
          .updateTable('league_members')
          .set({ final_rank: rank, outcome })
          .where('league_id', '=', id)
          .where('user_id', '=', member.user_id)
          .execute();
        const nextTier =
          outcome === 'promoted'
            ? league.tier + 1
            : outcome === 'demoted'
              ? league.tier - 1
              : league.tier;
        await trx
          .updateTable('user_stats')
          .set({ league_tier: nextTier })
          .where('user_id', '=', member.user_id)
          .execute();
      }
      await trx.updateTable('leagues').set({ closed_at: now }).where('id', '=', id).execute();
      return true;
    });
    if (done) closed += 1;
  }
  return closed;
}
