/**
 * Gamification (architecture §4 `gamification`; PRD §8; security plan C-26).
 *
 * XP is awarded only from server results: a practice answer right on the
 * first try, a passed mastery test (once per topic) and a passed review.
 * Assessment calls this module inside the transaction that saves the result,
 * so an answer that was not saved can never pay XP and a saved one cannot lose
 * it. The ledger's unique key on (user, reason, source) makes every award
 * idempotent, and a daily cap on practice and review XP stops farming easy items.
 */
import { type Database, newId, type XpReason } from '@mathpath/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { tashkentDay } from '../assessment/policy';
import type { Clock } from '../common/clock';
import type { LeaguesService } from './leagues.service';
import { advanceStreak, BADGES, type GamificationRules, levelFor, visibleStreak } from './rules';

type QuestMetric = GamificationRules['quests'][number]['metric'];

export interface GamificationSummary {
  xpTotal: number;
  level: number;
  levelProgress: number;
  /** XP still to earn today before the daily cap. */
  xpLeftToday: number;
  streak: { current: number; longest: number; freezesLeft: number; activeToday: boolean };
  badges: { code: string; awardedAt: string }[];
  quests: { code: string; progress: number; target: number; completed: boolean }[];
}

/** What one learning event earned, for the answer or result screen. */
export interface XpEarned {
  xp: number;
  badges: string[];
  /** With the target, so the screen can name "Earn 50 XP" without asking again. */
  questsCompleted: { code: string; target: number }[];
}

const NOTHING: XpEarned = { xp: 0, badges: [], questsCompleted: [] };

/** A `date` column as `YYYY-MM-DD`: drivers would otherwise turn it into a local-time Date. */
const lastActiveDay = sql<string | null>`last_active_day::text`.as('last_active_day');

export class GamificationService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly rules: GamificationRules,
    private readonly leagues: LeaguesService,
  ) {}

  /**
   * A practice answer was marked. Learning today keeps the streak; a right
   * answer on the first try earns XP and counts towards the quest.
   */
  async practiceAnswered(
    trx: Transaction<Database>,
    event: { userId: string; itemId: string; correct: boolean; firstTry: boolean },
  ): Promise<XpEarned> {
    const earned = {
      ...NOTHING,
      badges: [] as string[],
      questsCompleted: [] as XpEarned['questsCompleted'],
    };
    await this.touch(trx, event.userId);
    if (event.correct && event.firstTry) {
      await this.award(
        trx,
        event.userId,
        'first_try_correct',
        'attempt_item',
        event.itemId,
        this.rules.xp.firstTryCorrect,
        earned,
      );
      await this.progress(trx, event.userId, 'first_try_correct', 1, earned);
    }
    earned.badges.push(...(await this.checkBadges(trx, event.userId)));
    return earned;
  }

  /**
   * A practice set or test was submitted. A passed mastery test pays once per
   * topic; a passed review pays once per review attempt.
   */
  async attemptSubmitted(
    trx: Transaction<Database>,
    event: {
      userId: string;
      attemptId: string;
      topicId: string | null;
      type: string;
      passed: boolean | null;
    },
  ): Promise<XpEarned> {
    const earned = {
      ...NOTHING,
      badges: [] as string[],
      questsCompleted: [] as XpEarned['questsCompleted'],
    };
    await this.touch(trx, event.userId);
    if (event.passed && event.type === 'mastery' && event.topicId) {
      await this.award(
        trx,
        event.userId,
        'mastery_passed',
        'topic',
        event.topicId,
        this.rules.xp.masteryPassed,
        earned,
      );
    }
    if (event.passed && event.type === 'review') {
      await this.award(
        trx,
        event.userId,
        'review_passed',
        'attempt',
        event.attemptId,
        this.rules.xp.reviewPassed,
        earned,
      );
    }
    await this.progress(trx, event.userId, 'sets_finished', 1, earned);
    earned.badges.push(...(await this.checkBadges(trx, event.userId)));
    return earned;
  }

  /** GET /me/gamification. */
  async summary(userId: string): Promise<GamificationSummary> {
    const today = tashkentDay(this.clock.now());
    const [stats, badges, quests, todayXp] = await Promise.all([
      this.db
        .selectFrom('user_stats')
        .select(['xp_total', 'current_streak', 'longest_streak', 'streak_freezes', lastActiveDay])
        .where('user_id', '=', userId)
        .executeTakeFirst(),
      this.db
        .selectFrom('user_badges')
        .select(['badge_code', 'awarded_at'])
        .where('user_id', '=', userId)
        .orderBy('awarded_at')
        .execute(),
      this.db
        .selectFrom('user_quests')
        .select(['code', 'progress', 'target', 'completed_at'])
        .where('user_id', '=', userId)
        .where('day', '=', today)
        .execute(),
      this.xpOn(this.db, userId, today),
    ]);
    const xpTotal = stats?.xp_total ?? 0;
    const { level, progress } = levelFor(xpTotal, this.rules.levels);
    const state = {
      current: stats?.current_streak ?? 0,
      longest: stats?.longest_streak ?? 0,
      freezes: stats?.streak_freezes ?? 0,
      lastActiveDay: stats?.last_active_day ?? null,
    };
    const byCode = new Map(quests.map((q) => [q.code, q]));
    return {
      xpTotal,
      level,
      levelProgress: Math.round(progress * 100) / 100,
      xpLeftToday: Math.max(0, this.rules.xp.dailyCap - todayXp),
      streak: {
        current: visibleStreak(state, today),
        longest: state.longest,
        freezesLeft: state.freezes,
        activeToday: state.lastActiveDay === today,
      },
      badges: badges.map((b) => ({ code: b.badge_code, awardedAt: b.awarded_at.toISOString() })),
      quests: this.rules.quests.map((q) => {
        const row = byCode.get(q.code);
        return {
          code: q.code,
          progress: Math.min(row?.progress ?? 0, q.target),
          target: q.target,
          completed: Boolean(row?.completed_at),
        };
      }),
    };
  }

  // ──────────────────────────── Helpers ─────────────────────────────

  /**
   * Pays XP once for a source and adds it to `earned`. Practice and review XP stay within what is
   * left of today's cap; a mastery test (once per topic) and a quest (three a
   * day) cannot be farmed, so they always pay, and a capped day never costs a
   * learner their mastery badge.
   * @returns The XP actually paid (0 for a repeat or at the cap).
   */
  private async award(
    trx: Transaction<Database>,
    userId: string,
    reason: XpReason,
    sourceType: string,
    sourceId: string,
    base: number,
    earned: XpEarned,
  ): Promise<number> {
    const today = tashkentDay(this.clock.now());
    const capped = reason === 'first_try_correct' || reason === 'review_passed';
    const amount = capped
      ? Math.min(base, this.rules.xp.dailyCap - (await this.xpOn(trx, userId, today)))
      : base;
    if (amount <= 0) return 0;
    const inserted = await trx
      .insertInto('xp_ledger')
      .values({
        id: newId(),
        user_id: userId,
        amount,
        reason,
        source_type: sourceType,
        source_id: sourceId,
        day: today,
        created_at: this.clock.now(),
      })
      .onConflict((oc) => oc.columns(['user_id', 'reason', 'source_type', 'source_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return 0;
    const stats = await trx
      .updateTable('user_stats')
      .set((eb) => ({ xp_total: eb('xp_total', '+', amount), updated_at: this.clock.now() }))
      .where('user_id', '=', userId)
      .returning('xp_total')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('user_stats')
      .set({ level: levelFor(stats.xp_total, this.rules.levels).level })
      .where('user_id', '=', userId)
      .execute();
    earned.xp += amount;
    await this.leagues.addXp(trx, userId, amount);
    // Quest XP does not count towards the XP quest, or quests would feed themselves.
    if (reason !== 'quest_completed') await this.progress(trx, userId, 'xp', amount, earned);
    return amount;
  }

  /** XP paid on a Tashkent day, for the cap. */
  private async xpOn(db: Kysely<Database>, userId: string, day: string): Promise<number> {
    const row = await db
      .selectFrom('xp_ledger')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount'), eb.lit(0)).as('xp'))
      .where('user_id', '=', userId)
      .where('day', '=', day)
      .executeTakeFirstOrThrow();
    return Number(row.xp);
  }

  /** Learning today: creates the stats row if needed and moves the streak on. */
  private async touch(trx: Transaction<Database>, userId: string): Promise<void> {
    const today = tashkentDay(this.clock.now());
    await trx
      .insertInto('user_stats')
      .values({ user_id: userId, updated_at: this.clock.now() })
      .onConflict((oc) => oc.column('user_id').doNothing())
      .execute();
    const stats = await trx
      .selectFrom('user_stats')
      .select(['current_streak', 'longest_streak', 'streak_freezes', lastActiveDay])
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const last = stats.last_active_day;
    if (last === today) return;
    const next = advanceStreak(
      {
        current: stats.current_streak,
        longest: stats.longest_streak,
        freezes: stats.streak_freezes,
        lastActiveDay: last,
      },
      today,
      this.rules.streak,
    );
    await trx
      .updateTable('user_stats')
      .set({
        current_streak: next.current,
        longest_streak: next.longest,
        streak_freezes: next.freezes,
        last_active_day: next.lastActiveDay,
        updated_at: this.clock.now(),
      })
      .where('user_id', '=', userId)
      .execute();
  }

  /** Moves today's quests with this metric on; a quest finished now pays its XP. */
  private async progress(
    trx: Transaction<Database>,
    userId: string,
    metric: QuestMetric,
    by: number,
    earned: XpEarned,
  ): Promise<void> {
    const today = tashkentDay(this.clock.now());
    for (const quest of this.rules.quests.filter((q) => q.metric === metric)) {
      await trx
        .insertInto('user_quests')
        .values({ user_id: userId, day: today, code: quest.code, target: quest.target })
        .onConflict((oc) => oc.columns(['user_id', 'day', 'code']).doNothing())
        .execute();
      const row = await trx
        .selectFrom('user_quests')
        .select(['progress', 'completed_at'])
        .where('user_id', '=', userId)
        .where('day', '=', today)
        .where('code', '=', quest.code)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.completed_at) continue;
      const progress = Math.min(quest.target, row.progress + by);
      const done = progress >= quest.target;
      await trx
        .updateTable('user_quests')
        .set({ progress, completed_at: done ? this.clock.now() : null })
        .where('user_id', '=', userId)
        .where('day', '=', today)
        .where('code', '=', quest.code)
        .execute();
      if (done) {
        earned.questsCompleted.push({ code: quest.code, target: quest.target });
        await this.award(
          trx,
          userId,
          'quest_completed',
          'quest',
          `${today}:${quest.code}`,
          this.rules.xp.questCompleted,
          earned,
        );
      }
    }
  }

  /** Awards every badge whose rule now holds. @returns The codes awarded now. */
  private async checkBadges(trx: Transaction<Database>, userId: string): Promise<string[]> {
    const [stats, counts, have] = await Promise.all([
      trx
        .selectFrom('user_stats')
        .select(['xp_total', 'longest_streak'])
        .where('user_id', '=', userId)
        .executeTakeFirst(),
      trx
        .selectFrom('xp_ledger')
        .select(['reason', (eb) => eb.fn.countAll<string>().as('n')])
        .where('user_id', '=', userId)
        .groupBy('reason')
        .execute(),
      trx.selectFrom('user_badges').select('badge_code').where('user_id', '=', userId).execute(),
    ]);
    const count = (reason: XpReason) => Number(counts.find((c) => c.reason === reason)?.n ?? 0);
    const facts = {
      firstTryCorrect: count('first_try_correct'),
      masteries: count('mastery_passed'),
      questsCompleted: count('quest_completed'),
      longestStreak: stats?.longest_streak ?? 0,
      level: levelFor(stats?.xp_total ?? 0, this.rules.levels).level,
    };
    const owned = new Set(have.map((b) => b.badge_code));
    const fresh = BADGES.filter((b) => !owned.has(b.code) && b.earned(facts)).map((b) => b.code);
    if (fresh.length > 0) {
      await trx
        .insertInto('user_badges')
        .values(
          fresh.map((code) => ({
            user_id: userId,
            badge_code: code,
            awarded_at: this.clock.now(),
          })),
        )
        .onConflict((oc) => oc.columns(['user_id', 'badge_code']).doNothing())
        .execute();
    }
    return fresh;
  }
}
