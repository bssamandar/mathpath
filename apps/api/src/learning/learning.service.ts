/**
 * Learning state and adaptivity (docs/architecture.md §4 `learning`, §5.2–5.3;
 * ADR-0006): topic progress, gap routing after a failed mastery test, spaced
 * review, the learning path and progress reports.
 *
 * The decisions themselves are pure functions in rules.ts. This service loads
 * their inputs, stores the outcome, and logs every decision as a learning
 * event, which explains it to parents later and becomes training data for a
 * statistical model.
 */
import type { AppConfig } from '@mathpath/config';
import { type Database, type MasteryState, newId } from '@mathpath/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import type { CatalogueService } from '../content/catalogue.service';
import { lessonStep, pickText } from '../content/documents';
import { assertParentOf } from '../family/policies';
import { tashkentDay } from '../assessment/policy';
import {
  buildPath,
  firstReview,
  nextReview,
  type PathReason,
  type PrerequisiteState,
  routeGap,
} from './rules';

type Db = Kysely<Database> | Transaction<Database>;

export type RecommendationAction =
  | 'continue'
  | 'retry_practice'
  | 'prerequisite_review'
  | 'take_break';

/** Stored with the attempt and returned in AttemptResult.recommendation. */
export interface Recommendation {
  action: RecommendationAction;
  /** The topic the action is about (the prerequisite for a review, the next topic to continue). */
  topicId: string | null;
  /** Why, as a stable code (rules.ts), for the screen and the parent report. */
  reason?: string;
}

export interface SubmittedAttempt {
  attemptId: string;
  userId: string;
  topicId: string;
  type: string;
  score: number;
  maxScore: number;
  passed: boolean | null;
}

/** What kind of review a learner may start on a topic, if any. */
export type ReviewKind = 'gap_check' | 'spaced';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ITEM_SECONDS = 300;

export class LearningService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly catalogue: CatalogueService,
    private readonly clock: Clock,
    private readonly rules: AppConfig,
  ) {}

  // ─────────────────────────── after an attempt ───────────────────────────

  /**
   * Updates progress after a submitted attempt and decides what comes next.
   * Runs inside the submit transaction, so the result and the state change
   * are stored together.
   */
  async afterSubmit(trx: Transaction<Database>, a: SubmittedAttempt): Promise<Recommendation> {
    const now = this.clock.now();
    const ratio = a.maxScore > 0 ? a.score / a.maxScore : 0;
    const learning = this.rules.learning;
    const current = await this.progressRow(trx, a.userId, a.topicId);

    if (a.type === 'practice') {
      if (!current || current.state === 'not_started') {
        await this.saveProgress(trx, a.userId, a.topicId, { state: 'learning' });
      }
      return { action: 'continue', topicId: a.topicId };
    }

    if (a.type === 'mastery') {
      if (a.passed) {
        const plan = firstReview(learning, now);
        await this.saveProgress(trx, a.userId, a.topicId, {
          state: 'mastered',
          mastery: ratio,
          mastered_at: now,
          next_review_at: plan.nextReviewAt,
          review_interval_days: plan.intervalDays,
          ease: plan.ease,
          review_count: plan.reviewCount,
        });
        await this.closeDetoursTo(trx, a.userId, a.topicId, 'closed', now);
        await this.event(trx, a.userId, 'mastery_passed', a.topicId, {
          attemptId: a.attemptId,
          mastery: ratio,
          nextReviewAt: plan.nextReviewAt.toISOString(),
        });
        const next = await this.nextTopic(trx, a.userId, a.topicId);
        return { action: 'continue', topicId: next };
      }
      await this.saveProgress(trx, a.userId, a.topicId, {
        state: current?.state === 'mastered' ? 'needs_review' : 'learning',
        mastery: ratio,
      });
      await this.event(trx, a.userId, 'mastery_failed', a.topicId, {
        attemptId: a.attemptId,
        mastery: ratio,
      });
      return this.routeAfterFailure(trx, a.userId, a.topicId, a.attemptId, now);
    }

    if (a.type === 'review') {
      const passed = ratio >= learning.masteryThreshold;
      const detour = await this.openDetourTo(trx, a.userId, a.topicId);
      if (detour) {
        if (passed) {
          // The prerequisite is fresh again: back to the topic that sent us here.
          await this.closeDetour(trx, detour.id, 'refreshed', now);
          const plan = current?.next_review_at ? null : firstReview(learning, now);
          await this.saveProgress(trx, a.userId, a.topicId, {
            state: 'mastered',
            mastery: Math.max(ratio, Number(current?.mastery ?? 0)),
            mastered_at: now,
            ...(plan
              ? {
                  next_review_at: plan.nextReviewAt,
                  review_interval_days: plan.intervalDays,
                  ease: plan.ease,
                  review_count: 0,
                }
              : {}),
          });
          await this.event(trx, a.userId, 'gap_check_passed', a.topicId, {
            attemptId: a.attemptId,
            backTo: detour.from_topic_id,
          });
          return { action: 'continue', topicId: detour.from_topic_id, reason: 'gap_refreshed' };
        }
        // Not yet: the prerequisite goes on the path before the topic.
        await this.closeDetour(trx, detour.id, 'added_to_path', now);
        await this.saveProgress(trx, a.userId, a.topicId, {
          state: current?.state === 'mastered' ? 'needs_review' : 'learning',
          mastery: ratio,
        });
        await this.event(trx, a.userId, 'gap_check_failed', a.topicId, {
          attemptId: a.attemptId,
          addedBefore: detour.from_topic_id,
        });
        return { action: 'continue', topicId: a.topicId, reason: 'gap_added_to_path' };
      }

      const plan = nextReview(
        {
          intervalDays: current?.review_interval_days ?? null,
          ease: current?.ease === null || current?.ease === undefined ? null : Number(current.ease),
          reviewCount: current?.review_count ?? 0,
        },
        passed,
        learning,
        now,
      );
      await this.saveProgress(trx, a.userId, a.topicId, {
        state: passed ? 'mastered' : 'needs_review',
        mastery: ratio,
        next_review_at: plan.nextReviewAt,
        review_interval_days: plan.intervalDays,
        ease: plan.ease,
        review_count: plan.reviewCount,
      });
      await this.event(trx, a.userId, 'review_done', a.topicId, {
        attemptId: a.attemptId,
        passed,
        nextReviewAt: plan.nextReviewAt.toISOString(),
        intervalDays: plan.intervalDays,
      });
      return passed
        ? { action: 'continue', topicId: null, reason: 'review_passed' }
        : { action: 'retry_practice', topicId: a.topicId, reason: 'review_failed' };
    }
    return { action: 'continue', topicId: a.topicId };
  }

  /** The gap router's decision after a failed mastery test (architecture §5.2). */
  private async routeAfterFailure(
    trx: Transaction<Database>,
    userId: string,
    topicId: string,
    attemptId: string,
    now: Date,
  ): Promise<Recommendation> {
    const prerequisites = await this.prerequisiteStates(trx, userId, topicId);
    const inChain = await trx
      .selectFrom('learning_detours')
      .select((eb) => eb.fn.max('depth').as('depth'))
      .where('user_id', '=', userId)
      .where('to_topic_id', '=', topicId)
      .where('status', 'in', ['open', 'added_to_path'])
      .executeTakeFirst();
    const today = await trx
      .selectFrom('learning_detours')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .where('created_at', '>=', tashkentMidnight(now))
      .executeTakeFirst();
    const decision = routeGap({
      topicId,
      prerequisites,
      currentDepth: Number(inChain?.depth ?? 0),
      detoursToday: Number(today?.n ?? 0),
      rules: this.rules.learning,
      now,
    });

    if (decision.action === 'prerequisite_review') {
      // A newer detour from this topic replaces an unanswered older one.
      await trx
        .updateTable('learning_detours')
        .set({ status: 'closed', resolved_at: now })
        .where('user_id', '=', userId)
        .where('from_topic_id', '=', topicId)
        .where('status', '=', 'open')
        .execute();
      await trx
        .insertInto('learning_detours')
        .values({
          id: newId(),
          user_id: userId,
          from_topic_id: topicId,
          to_topic_id: decision.topicId,
          depth: decision.depth,
        })
        .execute();
    }
    await this.event(
      trx,
      userId,
      decision.action === 'take_break' ? 'gap_limit_reached' : 'gap_routed',
      topicId,
      { attemptId, ...decision },
    );
    return { action: decision.action, topicId: decision.topicId, reason: decision.reason };
  }

  /** Which review a learner may start on a topic: a gap check, a due or early spaced review, or none. */
  async reviewKind(userId: string, topicId: string): Promise<ReviewKind | null> {
    if (await this.openDetourTo(this.db, userId, topicId)) return 'gap_check';
    const progress = await this.progressRow(this.db, userId, topicId);
    return progress?.mastered_at ? 'spaced' : null;
  }

  // ─────────────────────────────── reads ───────────────────────────────

  /**
   * Object-level check for `progress:read` (C-10): the learner themself or a
   * linked parent. Teachers follow with classrooms. Others get 404.
   */
  async assertCanRead(viewerId: string, studentId: string): Promise<void> {
    if (viewerId === studentId) return;
    try {
      await assertParentOf(this.db, viewerId, studentId);
    } catch {
      throw new ProblemException(404, 'STUDENT_NOT_FOUND', 'Student not found.');
    }
  }

  /** The learning path for a course (architecture §5.3), computed from current progress. */
  async learningPath(studentId: string, courseId: string, locale: string) {
    const now = this.clock.now();
    const topics = await this.courseTopics(courseId);
    if (topics.length === 0) return { courseId, generatedAt: now.toISOString(), items: [] };
    const progress = await this.progressMap(
      studentId,
      topics.map((t) => t.id),
    );
    const edges = await this.requiredEdges(topics.map((t) => t.id));
    const gaps = await this.db
      .selectFrom('learning_detours as d')
      .innerJoin('topics as t', 't.id', 'd.to_topic_id')
      .leftJoin('topic_versions as v', 'v.id', 't.published_version_id')
      .select(['d.from_topic_id', 'd.to_topic_id', 'v.title'])
      .where('d.user_id', '=', studentId)
      .where('d.status', '=', 'added_to_path')
      .where(
        'd.from_topic_id',
        'in',
        topics.map((t) => t.id),
      )
      .orderBy('d.created_at')
      .execute();
    const gapProgress = await this.progressMap(
      studentId,
      gaps.map((g) => g.to_topic_id),
    );
    const view = (id: string) => {
      const p = progress.get(id) ?? gapProgress.get(id);
      return {
        topicId: id,
        state: (p?.state ?? 'not_started') as MasteryState,
        reviewDue: !!p?.next_review_at && p.next_review_at <= now,
      };
    };
    const titles = new Map<string, string>([
      ...topics.map((t) => [t.id, this.text(t.title, locale)] as [string, string]),
      ...gaps.map(
        (g) => [g.to_topic_id, g.title ? this.text(g.title, locale) : ''] as [string, string],
      ),
    ]);
    const items = buildPath(
      topics.map((t) => view(t.id)),
      edges,
      gaps.map((g) => ({ forTopicId: g.from_topic_id, prerequisite: view(g.to_topic_id) })),
    );
    return {
      courseId,
      generatedAt: now.toISOString(),
      items: items.map((i) => ({ ...i, title: titles.get(i.topicId) ?? '' })),
    };
  }

  /** Mastery by topic, time spent and weak topics for a course. */
  async progress(studentId: string, courseId: string, locale: string) {
    const topics = await this.courseTopics(courseId);
    const ids = topics.map((t) => t.id);
    const progress = await this.progressMap(studentId, ids);
    const threshold = this.rules.learning.masteryThreshold;
    const time = ids.length
      ? await this.db
          .selectFrom('attempt_items as i')
          .innerJoin('attempts as a', 'a.id', 'i.attempt_id')
          .select(
            sql<string>`coalesce(sum(least(extract(epoch from (i.answered_at - i.served_at)), ${MAX_ITEM_SECONDS})), 0)`.as(
              'seconds',
            ),
          )
          .where('a.user_id', '=', studentId)
          .where('a.topic_id', 'in', ids)
          .where('i.answered_at', 'is not', null)
          .where('i.served_at', 'is not', null)
          .executeTakeFirst()
      : { seconds: '0' };
    const rows = topics.map((t) => {
      const p = progress.get(t.id);
      return {
        topicId: t.id,
        title: this.text(t.title, locale),
        state: (p?.state ?? 'not_started') as MasteryState,
        mastery: p?.mastery === null || p?.mastery === undefined ? null : Number(p.mastery),
      };
    });
    return {
      courseId,
      timeSpentMin: Math.round(Number(time?.seconds ?? 0) / 60),
      topics: rows,
      weakTopics: rows
        .filter(
          (r) =>
            r.state === 'needs_review' ||
            (r.state === 'learning' && r.mastery !== null && r.mastery < threshold),
        )
        .map((r) => r.topicId),
      // Only for exam-prep courses, with the mock exams (later step).
      predictedScore: null,
    };
  }

  /** Topics due for review now, for the caller. */
  async dueReviews(userId: string, locale: string) {
    const rows = await this.db
      .selectFrom('topic_progress as p')
      .innerJoin('topics as t', 't.id', 'p.topic_id')
      .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
      .select(['p.topic_id', 'p.next_review_at', 'v.title'])
      .where('p.user_id', '=', userId)
      .where('p.next_review_at', '<=', this.clock.now())
      .orderBy('p.next_review_at')
      .limit(50)
      .execute();
    return {
      items: rows.map((r) => ({
        topicId: r.topic_id,
        title: this.text(r.title, locale),
        dueAt: r.next_review_at!.toISOString(),
      })),
    };
  }

  /**
   * Marks a video or activity step done. Practice and tests complete
   * through their attempts, so they are refused here (409).
   */
  async completeStep(userId: string, topicId: string, stepIndex: number): Promise<void> {
    const topic = await this.catalogue.openTopic(topicId, userId);
    const steps = lessonStep.array().parse(topic.steps);
    const step = steps[stepIndex];
    if (!step) throw new ProblemException(404, 'STEP_NOT_FOUND', 'Step not found.');
    if (step.type !== 'video' && step.type !== 'activity') {
      throw new ProblemException(
        409,
        'STEP_ASSESSED',
        'Practice and tests are completed by answering them.',
      );
    }
    await this.db.transaction().execute(async (trx) => {
      const current = await this.progressRow(trx, userId, topicId);
      const done = new Set(current?.steps_completed ?? []);
      if (done.has(stepIndex)) return;
      done.add(stepIndex);
      await this.saveProgress(trx, userId, topicId, {
        steps_completed: [...done].sort((a, b) => a - b),
        topic_version_id: topic.version_id,
        ...(current && current.state !== 'not_started' ? {} : { state: 'learning' as const }),
      });
    });
  }

  /** Steps completed and the mastery state, for the lesson and course screens. */
  async topicStates(userId: string, topicIds: readonly string[]) {
    return this.progressMap(userId, topicIds);
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private async progressRow(db: Db, userId: string, topicId: string) {
    return db
      .selectFrom('topic_progress')
      .selectAll()
      .where('user_id', '=', userId)
      .where('topic_id', '=', topicId)
      .executeTakeFirst();
  }

  private async progressMap(userId: string, topicIds: readonly string[]) {
    if (topicIds.length === 0) return new Map<string, never>();
    const rows = await this.db
      .selectFrom('topic_progress')
      .selectAll()
      .where('user_id', '=', userId)
      .where('topic_id', 'in', [...topicIds])
      .execute();
    return new Map(rows.map((r) => [r.topic_id, r]));
  }

  private async saveProgress(
    trx: Transaction<Database>,
    userId: string,
    topicId: string,
    values: {
      state?: MasteryState;
      mastery?: number;
      steps_completed?: number[];
      topic_version_id?: string;
      mastered_at?: Date;
      next_review_at?: Date;
      review_interval_days?: number;
      ease?: number;
      review_count?: number;
    },
  ): Promise<void> {
    const now = this.clock.now();
    const mastery =
      values.mastery === undefined ? undefined : Math.round(values.mastery * 1000) / 1000;
    const set = { ...values, ...(mastery === undefined ? {} : { mastery }), updated_at: now };
    await trx
      .insertInto('topic_progress')
      .values({ user_id: userId, topic_id: topicId, ...set })
      .onConflict((oc) => oc.columns(['user_id', 'topic_id']).doUpdateSet(set))
      .execute();
  }

  private async openDetourTo(db: Db, userId: string, topicId: string) {
    return db
      .selectFrom('learning_detours')
      .selectAll()
      .where('user_id', '=', userId)
      .where('to_topic_id', '=', topicId)
      .where('status', '=', 'open')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }

  private async closeDetour(
    trx: Transaction<Database>,
    id: string,
    status: 'refreshed' | 'added_to_path' | 'closed',
    now: Date,
  ) {
    await trx
      .updateTable('learning_detours')
      .set({ status, resolved_at: now })
      .where('id', '=', id)
      .execute();
  }

  /** A mastered topic ends the detours that led to it, and the ones that added it to the path. */
  private async closeDetoursTo(
    trx: Transaction<Database>,
    userId: string,
    topicId: string,
    status: 'closed',
    now: Date,
  ) {
    await trx
      .updateTable('learning_detours')
      .set({ status, resolved_at: sql`coalesce(resolved_at, ${now})` })
      .where('user_id', '=', userId)
      .where('to_topic_id', '=', topicId)
      .where('status', 'in', ['open', 'added_to_path'])
      .execute();
  }

  private async prerequisiteStates(
    db: Db,
    userId: string,
    topicId: string,
  ): Promise<PrerequisiteState[]> {
    const rows = await db
      .selectFrom('topic_prerequisites as e')
      .innerJoin('topics as t', 't.id', 'e.prerequisite_id')
      .leftJoin('topic_progress as p', (join) =>
        join.onRef('p.topic_id', '=', 'e.prerequisite_id').on('p.user_id', '=', userId),
      )
      .select(['e.prerequisite_id', 'p.state', 'p.mastery', 'p.mastered_at'])
      .where('e.topic_id', '=', topicId)
      .where('e.strength', '=', 'required')
      // Only prerequisites a learner can actually open.
      .where('t.published_version_id', 'is not', null)
      .orderBy('t.sort')
      .orderBy('t.slug')
      .execute();
    return rows.map((r) => ({
      topicId: r.prerequisite_id,
      state: (r.state ?? 'not_started') as MasteryState,
      mastery: r.mastery === null ? null : Number(r.mastery),
      masteredAt: r.mastered_at,
    }));
  }

  private async event(
    trx: Transaction<Database>,
    userId: string,
    type: string,
    topicId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await trx
      .insertInto('learning_events')
      .values({
        id: newId(),
        user_id: userId,
        type,
        topic_id: topicId,
        payload: JSON.stringify(payload),
      })
      .execute();
  }

  /** The next topic on the learner's path in the topic's course, after this one. */
  private async nextTopic(
    trx: Transaction<Database>,
    userId: string,
    topicId: string,
  ): Promise<string | null> {
    const course = await trx
      .selectFrom('topics as t')
      .innerJoin('chapters as c', 'c.id', 't.chapter_id')
      .select('c.course_id')
      .where('t.id', '=', topicId)
      .executeTakeFirst();
    if (!course) return null;
    const topics = await this.courseTopics(course.course_id, trx);
    const ids = topics.map((t) => t.id);
    const rows = ids.length
      ? await trx
          .selectFrom('topic_progress')
          .select(['topic_id', 'state'])
          .where('user_id', '=', userId)
          .where('topic_id', 'in', ids)
          .execute()
      : [];
    const state = new Map(rows.map((r) => [r.topic_id, r.state]));
    const path = buildPath(
      ids.map((id) => ({
        topicId: id,
        state: (state.get(id) ?? 'not_started') as MasteryState,
        reviewDue: false,
      })),
      await this.requiredEdges(ids, trx),
      [],
    );
    return path.find((p) => p.topicId !== topicId)?.topicId ?? null;
  }

  /** Published topics of a published course, in course order. @throws 404 */
  private async courseTopics(courseId: string, db: Db = this.db) {
    const course = await db
      .selectFrom('courses')
      .select('id')
      .where('id', '=', courseId)
      .where('status', '=', 'published')
      .executeTakeFirst();
    if (!course) throw new ProblemException(404, 'COURSE_NOT_FOUND', 'Course not found.');
    return db
      .selectFrom('topics as t')
      .innerJoin('chapters as c', 'c.id', 't.chapter_id')
      .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
      .select(['t.id', 'v.title'])
      .where('c.course_id', '=', courseId)
      .where('c.status', '=', 'published')
      .orderBy('c.sort')
      .orderBy('c.slug')
      .orderBy('t.sort')
      .orderBy('t.slug')
      .execute();
  }

  private async requiredEdges(ids: readonly string[], db: Db = this.db) {
    if (ids.length === 0) return [];
    const rows = await db
      .selectFrom('topic_prerequisites')
      .select(['topic_id', 'prerequisite_id'])
      .where('topic_id', 'in', [...ids])
      .where('strength', '=', 'required')
      .execute();
    return rows.map((r) => ({ topicId: r.topic_id, prerequisiteId: r.prerequisite_id }));
  }

  private text(text: Record<string, string | undefined>, locale: string): string {
    return pickText(text, locale, this.rules.content.defaultLocale);
  }
}

/** Midnight at the start of today in Tashkent, as an instant. */
export function tashkentMidnight(now: Date): Date {
  return new Date(Date.parse(`${tashkentDay(now)}T00:00:00+05:00`));
}

export type { PathReason };
export { DAY_MS };
