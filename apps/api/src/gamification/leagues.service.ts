/**
 * Weekly leagues (PRD §8; UX S8; security plan C-26). A learner joins this
 * week's league with their first XP of the week, in a group of about 30
 * learners of the same tier and grade band. Only children whose parent gave
 * the "leaderboard" consent take part, and others see them by nickname only.
 * The worker closes each week (`closeFinishedLeagues` in @mathpath/db).
 */
import {
  type Database,
  gradeBand,
  type LeagueOutcome,
  type LeagueRules,
  leagueWeekEnd,
  leagueWeekOf,
  leagueZones,
  newId,
} from '@mathpath/db';
import { type ExpressionBuilder, type Kysely, sql, type Transaction } from 'kysely';
import type { Clock } from '../common/clock';

export interface LeagueStanding {
  rank: number;
  nickname: string;
  avatarCode: string | null;
  weeklyXp: number;
  isMe: boolean;
}

export interface LeagueView {
  /** `off`: no leaderboard consent; `not_joined`: no XP yet this week. */
  status: 'active' | 'not_joined' | 'off';
  weekStart: string;
  endsAt: string;
  tier: number;
  tiers: number;
  zones: { up: number; down: number };
  standings: LeagueStanding[];
  /** How last week ended, when the learner took part. */
  lastWeek: { tier: number; rank: number; outcome: LeagueOutcome } | null;
}

/** Children with a live parent consent that includes the leaderboard. */
const hasLeaderboardConsent = (eb: ExpressionBuilder<Database, 'student_profiles'>) =>
  eb.exists(
    eb
      .selectFrom('parent_child_links as l')
      .innerJoin('consents as c', 'c.id', 'l.consent_id')
      .whereRef('l.child_id', '=', 'student_profiles.user_id')
      .where('c.revoked_at', 'is', null)
      .where(sql<boolean>`'leaderboard' = ANY(c.scopes)`),
  );

export class LeaguesService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly rules: LeagueRules,
  ) {}

  /** Adds XP to this week's league, joining one first when needed. */
  async addXp(trx: Transaction<Database>, userId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    const profile = await this.eligible(trx, userId);
    if (!profile) return;
    const week = leagueWeekOf(this.clock.now());
    const added = await trx
      .updateTable('league_members')
      .set((eb) => ({ weekly_xp: eb('weekly_xp', '+', amount) }))
      .where('user_id', '=', userId)
      .where('week_start', '=', week)
      .returning('league_id')
      .executeTakeFirst();
    if (added) return;
    const stats = await trx
      .selectFrom('user_stats')
      .select('league_tier')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const tier = Math.min(stats?.league_tier ?? 1, this.rules.tiers);
    const leagueId = await this.leagueWithRoom(
      trx,
      week,
      tier,
      gradeBand(profile.grade, this.rules.gradeBands),
    );
    await trx
      .insertInto('league_members')
      .values({
        league_id: leagueId,
        user_id: userId,
        week_start: week,
        weekly_xp: amount,
        joined_at: this.clock.now(),
      })
      .execute();
  }

  /** GET /leagues/current. */
  async current(userId: string): Promise<LeagueView> {
    const now = this.clock.now();
    const week = leagueWeekOf(now);
    const [profile, stats, membership, last] = await Promise.all([
      this.eligible(this.db, userId),
      this.db
        .selectFrom('user_stats')
        .select('league_tier')
        .where('user_id', '=', userId)
        .executeTakeFirst(),
      this.db
        .selectFrom('league_members as m')
        .innerJoin('leagues as l', 'l.id', 'm.league_id')
        .select(['l.id', 'l.tier'])
        .where('m.user_id', '=', userId)
        .where('m.week_start', '=', week)
        .executeTakeFirst(),
      this.db
        .selectFrom('league_members as m')
        .innerJoin('leagues as l', 'l.id', 'm.league_id')
        .select(['l.tier', 'm.final_rank', 'm.outcome'])
        .where('m.user_id', '=', userId)
        .where('m.week_start', '<', week)
        .where('m.outcome', 'is not', null)
        .orderBy('m.week_start', 'desc')
        .executeTakeFirst(),
    ]);
    const base = {
      weekStart: week,
      endsAt: leagueWeekEnd(week).toISOString(),
      tier: membership?.tier ?? Math.min(stats?.league_tier ?? 1, this.rules.tiers),
      tiers: this.rules.tiers,
      lastWeek:
        last?.final_rank && last.outcome
          ? { tier: last.tier, rank: last.final_rank, outcome: last.outcome }
          : null,
    };
    if (!profile)
      return { ...base, status: 'off', zones: { up: 0, down: 0 }, standings: [], lastWeek: null };
    if (!membership) {
      return { ...base, status: 'not_joined', zones: { up: 0, down: 0 }, standings: [] };
    }
    const rows = await this.db
      .selectFrom('league_members as m')
      .innerJoin('student_profiles', 'student_profiles.user_id', 'm.user_id')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select([
        'm.user_id',
        'm.weekly_xp',
        'student_profiles.nickname',
        'student_profiles.nickname_status',
        'student_profiles.avatar_code',
        'u.first_name',
        'u.last_name',
      ])
      .where('m.league_id', '=', membership.id)
      // A child whose parent withdrew the consent disappears at once.
      .where(hasLeaderboardConsent)
      .orderBy('m.weekly_xp', 'desc')
      .orderBy('m.joined_at')
      .orderBy('m.user_id')
      .execute();
    return {
      ...base,
      status: 'active',
      zones: tierZones(leagueZones(rows.length, this.rules), base.tier, this.rules.tiers),
      standings: rows.map((row, index) => ({
        rank: index + 1,
        nickname: displayName(row),
        avatarCode: row.avatar_code,
        weeklyXp: row.weekly_xp,
        isMe: row.user_id === userId,
      })),
    };
  }

  /** The learner's grade when they may take part in leagues; null otherwise. */
  private async eligible(db: Kysely<Database>, userId: string) {
    return db
      .selectFrom('student_profiles')
      .select('grade')
      .where('user_id', '=', userId)
      .where(hasLeaderboardConsent)
      .executeTakeFirst();
  }

  /** The first league of the week, tier and band with a free place, or a new one. */
  private async leagueWithRoom(
    trx: Transaction<Database>,
    week: string,
    tier: number,
    band: number,
  ): Promise<string> {
    const leagues = await trx
      .selectFrom('leagues as l')
      .select((eb) => [
        'l.id',
        'l.cohort',
        eb
          .selectFrom('league_members as m')
          .whereRef('m.league_id', '=', 'l.id')
          .select(eb.fn.countAll<string>().as('n'))
          .as('members'),
      ])
      .where('l.week_start', '=', week)
      .where('l.tier', '=', tier)
      .where('l.band', '=', band)
      .orderBy('l.cohort')
      .execute();
    // Two learners joining at the same instant may make a league one larger
    // than `size`; that is harmless, so no lock is taken here.
    const free = leagues.find((l) => Number(l.members) < this.rules.size);
    if (free) return free.id;
    const cohort = (leagues.at(-1)?.cohort ?? 0) + 1;
    const id = newId();
    const created = await trx
      .insertInto('leagues')
      .values({ id, week_start: week, tier, band, cohort, created_at: this.clock.now() })
      .onConflict((oc) => oc.columns(['week_start', 'tier', 'band', 'cohort']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (created) return created.id;
    // Someone made the same cohort a moment ago: join it.
    const existing = await trx
      .selectFrom('leagues')
      .select('id')
      .where('week_start', '=', week)
      .where('tier', '=', tier)
      .where('band', '=', band)
      .where('cohort', '=', cohort)
      .executeTakeFirstOrThrow();
    return existing.id;
  }
}

/** No promotion zone in the top tier and no demotion zone in tier 1. */
function tierZones(zones: { up: number; down: number }, tier: number, tiers: number) {
  return { up: tier < tiers ? zones.up : 0, down: tier > 1 ? zones.down : 0 };
}

/**
 * What other children see: the nickname once a moderator approved it,
 * otherwise the first name and the last initial (PRD §8). Never a full name.
 */
function displayName(row: {
  nickname: string;
  nickname_status: string;
  first_name: string;
  last_name: string | null;
}): string {
  if (row.nickname_status === 'approved') return row.nickname;
  const initial = row.last_name?.trim().charAt(0);
  return initial ? `${row.first_name} ${initial}.` : row.first_name;
}
