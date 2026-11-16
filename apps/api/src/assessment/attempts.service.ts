/**
 * Practice sets and mastery tests (docs/api/openapi.yaml, tag Assessment; UX F4, S5, S6).
 *
 * Every item is generated here from a published question template with a
 * fresh random seed, and marked here: the answer key, hints and solution stay
 * on the server until the feedback policy releases them (C-16). Practice
 * marks each answer at once (hint after the first mistake, worked solution
 * after the second); a mastery test only records answers and marks them all
 * when the learner submits.
 */
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '@mathpath/config';
import { type AssessmentType, type Database, newId } from '@mathpath/db';
import {
  type AnswerKey,
  check,
  decimalsOf,
  formatValue,
  generate,
  type ItemFeedback,
  type Presented,
  Rational,
  type Response,
  seededRandom,
  templateBody,
  TemplateError,
} from '@mathpath/questions';
import { Logger } from '@nestjs/common';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import type { CatalogueService, Entitlements } from '../content/catalogue.service';
import { pickText } from '../content/documents';
import { planItems, practiceStep, tashkentDay } from './policy';

/** Kinds of attempt this step can run. The others arrive with adaptivity and exams. */
export const AVAILABLE_TYPES = ['practice', 'mastery'] as const;
type AvailableType = (typeof AVAILABLE_TYPES)[number];

export interface AttemptView {
  id: string;
  type: AssessmentType;
  topicId: string | null;
  status: string;
  itemCount: number;
  answeredCount: number;
  startedAt: string;
  deadlineAt: string | null;
  adaptive: boolean;
}

/** The learner's answer, as the API receives it (AnswerResponse). */
export type AnswerInput = { choiceIds: string[] } | { value: string };

export interface Feedback {
  accepted: boolean;
  correct: boolean | null;
  /** Why the answer was not right, when it is about its form ("simplify the fraction"). */
  reason?: 'unreadable' | 'not_simplified' | 'form' | 'wrong';
  triesLeft?: number;
  hint?: string | null;
  solution?: string | null;
  /** The right answer, once the item is finished without a right answer. */
  correctAnswer?: string | null;
}

export interface QuestionInstanceView {
  position: number;
  type: string;
  stem: string;
  inputHint: 'number' | 'fraction' | 'single' | 'multiple';
  choices?: { id: string; label: string }[];
  previousResponse?: AnswerInput;
  /** Practice only: the item's state and the last feedback, for a learner who comes back. */
  closed?: boolean;
  lastFeedback?: Feedback;
}

export interface AttemptResultView {
  attemptId: string;
  type: AssessmentType;
  score: number;
  maxScore: number;
  passed: boolean | null;
  byTopic: { topicId: string; title: string; correct: number; total: number }[];
  review: {
    position: number;
    correct: boolean;
    stem: string;
    correctAnswer: string;
    solution: string | null;
  }[];
  recommendation: { action: 'continue' | 'retry_practice'; topicId: string | null };
}

export interface TopicAssessmentStatus {
  topicId: string;
  questionCount: number;
  practice: { correct: number; required: number; openAttemptId: string | null };
  mastery: {
    unlocked: boolean;
    openAttemptId: string | null;
    best: { score: number; maxScore: number; passed: boolean; submittedAt: string } | null;
  };
  /** Practice answers left today on the free plan; null without a limit. */
  dailyExercisesLeft: number | null;
}

const closedAttempt = () =>
  new ProblemException(409, 'ATTEMPT_CLOSED', 'This attempt is already finished.');
const attemptNotFound = () => new ProblemException(404, 'NOT_FOUND', 'Attempt not found.');

export class AttemptsService {
  private readonly logger = new Logger('Attempts');

  constructor(
    private readonly db: Kysely<Database>,
    private readonly catalogue: CatalogueService,
    private readonly entitlements: Entitlements,
    private readonly clock: Clock,
    private readonly rules: AppConfig,
  ) {}

  /**
   * Starts a practice set or mastery test on a topic, or returns the one the
   * learner left open (`resumed`), so a double tap or a reload never deals a
   * second set of questions.
   * @throws ProblemException 402/404 for the topic, 409 NO_QUESTIONS or
   *   MASTERY_LOCKED, 422 ASSESSMENT_UNAVAILABLE, 429 DAILY_LIMIT_REACHED.
   */
  async start(
    userId: string,
    input: { type: AssessmentType; topicId?: string },
    idempotencyKey: string | null,
  ): Promise<{ attempt: AttemptView; resumed: boolean }> {
    if (!(AVAILABLE_TYPES as readonly string[]).includes(input.type) || !input.topicId) {
      throw new ProblemException(
        422,
        'ASSESSMENT_UNAVAILABLE',
        'Only topic practice and mastery tests are available yet.',
      );
    }
    const type = input.type as AvailableType;
    const topicId = input.topicId;

    if (idempotencyKey) {
      const earlier = await this.db
        .selectFrom('attempts')
        .select('id')
        .where('user_id', '=', userId)
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (earlier) return { attempt: await this.view(userId, earlier.id), resumed: true };
    }
    await this.catalogue.openTopic(topicId, userId);

    const assessmentId = await this.assessmentFor(type, topicId);
    const open = await this.openAttempt(userId, assessmentId);
    if (open) return { attempt: await this.view(userId, open), resumed: true };

    const templates = await this.publishedTemplates(topicId);
    if (templates.length === 0) {
      throw new ProblemException(409, 'NO_QUESTIONS', 'This topic has no questions yet.');
    }
    if (type === 'mastery') {
      const correct = await this.practiceCorrect(userId, topicId);
      if (correct < this.rules.learning.practice.minCorrectBeforeMasteryTest) {
        throw new ProblemException(
          409,
          'MASTERY_LOCKED',
          'Practise a little more before the mastery test.',
        );
      }
    } else if ((await this.exercisesLeft(userId)) === 0) {
      throw dailyLimit();
    }

    const count =
      type === 'practice'
        ? this.rules.learning.practice.itemsPerSet
        : this.rules.learning.masteryTest.items;
    const random = seededRandom(randomBytes(16).toString('hex'));
    const items = this.generateItems(planItems(templates, count, random.shuffle), templates);
    if (items.length === 0) {
      throw new ProblemException(409, 'NO_QUESTIONS', 'This topic has no questions yet.');
    }

    const attemptId = newId();
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('attempts')
          .values({
            id: attemptId,
            user_id: userId,
            assessment_id: assessmentId,
            topic_id: topicId,
            idempotency_key: idempotencyKey,
          })
          .execute();
        await trx
          .insertInto('attempt_items')
          .values(
            items.map((item, i) => ({
              id: newId(),
              attempt_id: attemptId,
              position: i + 1,
              template_version_id: item.versionId,
              seed: item.seed,
              params: JSON.stringify(item.generated.params),
              presented: JSON.stringify(item.generated.presented),
              answer_key: JSON.stringify(item.generated.answerKey),
              feedback: JSON.stringify(item.generated.feedback),
            })),
          )
          .execute();
      });
    } catch (error) {
      // Two starts at once: the one-open-attempt index lets only one win.
      const winner = await this.openAttempt(userId, assessmentId);
      if (winner) return { attempt: await this.view(userId, winner), resumed: true };
      throw error;
    }
    return { attempt: await this.view(userId, attemptId), resumed: false };
  }

  /** @throws ProblemException 404 for someone else's attempt. */
  async view(userId: string, attemptId: string): Promise<AttemptView> {
    const attempt = await this.db
      .selectFrom('attempts as a')
      .innerJoin('assessments as s', 's.id', 'a.assessment_id')
      .select((eb) => [
        'a.id',
        's.type',
        'a.topic_id',
        'a.status',
        'a.started_at',
        'a.deadline_at',
        eb
          .selectFrom('attempt_items as i')
          .whereRef('i.attempt_id', '=', 'a.id')
          .select((e) => e.fn.countAll<string>().as('n'))
          .as('item_count'),
        eb
          .selectFrom('attempt_items as i')
          .whereRef('i.attempt_id', '=', 'a.id')
          .where('i.response', 'is not', null)
          .select((e) => e.fn.countAll<string>().as('n'))
          .as('answered_count'),
      ])
      .where('a.id', '=', attemptId)
      .where('a.user_id', '=', userId)
      .executeTakeFirst();
    if (!attempt) throw attemptNotFound();
    return {
      id: attempt.id,
      type: attempt.type,
      topicId: attempt.topic_id,
      status: attempt.status,
      itemCount: Number(attempt.item_count ?? 0),
      answeredCount: Number(attempt.answered_count ?? 0),
      startedAt: attempt.started_at.toISOString(),
      deadlineAt: attempt.deadline_at?.toISOString() ?? null,
      adaptive: false,
    };
  }

  /** One question as the learner sees it. The first view starts the server's answer timer. */
  async item(
    userId: string,
    attemptId: string,
    position: number,
    locale: string,
  ): Promise<QuestionInstanceView> {
    const { attempt, item } = await this.loadItem(userId, attemptId, position);
    if (!item.served_at && attempt.status === 'in_progress') {
      await this.db
        .updateTable('attempt_items')
        .set({ served_at: this.clock.now() })
        .where('id', '=', item.id)
        .execute();
    }
    const presented = item.presented as unknown as Presented;
    const view: QuestionInstanceView = {
      position: item.position,
      type: item.type,
      stem: this.text(presented.stem, locale),
      inputHint: presented.input,
    };
    if (presented.choices) {
      view.choices = presented.choices.map((c) => ({ id: c.id, label: this.text(c.text, locale) }));
    }
    if (item.response) view.previousResponse = toInput(item.response as Response);
    if (attempt.type === 'practice') {
      view.closed = item.is_correct !== null;
      if (item.last_result) {
        view.lastFeedback = this.localise(item.last_result as StoredFeedback, locale, item);
      }
    }
    return view;
  }

  /**
   * Records an answer. Practice marks it and returns the hint or solution the
   * policy allows; a test only accepts it. A retried request with the same
   * Idempotency-Key gets the first result and is not counted twice.
   * @throws ProblemException 409 ATTEMPT_CLOSED / ITEM_CLOSED, 410 when expired,
   *   429 DAILY_LIMIT_REACHED.
   */
  async answer(
    userId: string,
    attemptId: string,
    position: number,
    input: AnswerInput,
    idempotencyKey: string | null,
    locale: string,
  ): Promise<Feedback> {
    return this.db.transaction().execute(async (trx) => {
      const { attempt, item } = await this.loadItem(userId, attemptId, position, trx);
      if (idempotencyKey && item.last_request_key === idempotencyKey && item.last_result) {
        return this.localise(item.last_result as StoredFeedback, locale, item);
      }
      await this.assertOpen(attempt, trx);
      const response = toResponse(input);
      const now = this.clock.now();

      if (attempt.type !== 'practice') {
        const stored: StoredFeedback = { accepted: true, correct: null };
        await trx
          .updateTable('attempt_items')
          .set({
            response: JSON.stringify(response),
            tries: item.tries + 1,
            served_at: item.served_at ?? now,
            answered_at: now,
            last_request_key: idempotencyKey,
            last_result: JSON.stringify(stored),
          })
          .where('id', '=', item.id)
          .execute();
        return this.localise(stored, locale);
      }

      if (item.is_correct !== null) {
        throw new ProblemException(409, 'ITEM_CLOSED', 'This question is already finished.');
      }
      const mark = check(item.answer_key as unknown as AnswerKey, response);
      // A typo such as "3,,5" is not a try: the learner is asked to fix it.
      if (mark.reason === 'unreadable') {
        return { accepted: false, correct: null, reason: 'unreadable' };
      }
      if (item.tries === 0) await this.countExercise(userId, trx);

      const tries = item.tries + 1;
      const feedback = item.feedback as unknown as ItemFeedback;
      const step = practiceStep(
        mark.correct,
        tries,
        feedback.hints.length,
        this.rules.learning.practice,
      );
      const stored: StoredFeedback = {
        accepted: true,
        correct: mark.correct,
        ...(mark.reason ? { reason: mark.reason } : {}),
        triesLeft: step.triesLeft,
        hintIndex: step.hintIndex,
        showSolution: step.showSolution,
      };
      await trx
        .updateTable('attempt_items')
        .set({
          response: JSON.stringify(response),
          tries,
          hints_shown: step.hintIndex === null ? item.hints_shown : item.hints_shown + 1,
          is_correct: step.closed ? mark.correct : null,
          score: step.closed ? (mark.correct ? 1 : 0) : null,
          served_at: item.served_at ?? now,
          answered_at: now,
          last_request_key: idempotencyKey,
          last_result: JSON.stringify(stored),
        })
        .where('id', '=', item.id)
        .execute();
      return this.localise(stored, locale, item);
    });
  }

  /**
   * Finishes an attempt and marks a test. Submitting again returns the same result.
   * @throws ProblemException 409 ATTEMPT_CLOSED for an expired attempt.
   */
  async submit(userId: string, attemptId: string, locale: string): Promise<AttemptResultView> {
    await this.db.transaction().execute(async (trx) => {
      const attempt = await this.attemptRow(userId, attemptId, trx, true);
      if (attempt.status === 'submitted') return;
      await this.assertOpen(attempt, trx);
      const items = await trx
        .selectFrom('attempt_items')
        .select(['id', 'answer_key', 'response', 'is_correct'])
        .where('attempt_id', '=', attemptId)
        .execute();
      let score = 0;
      for (const item of items) {
        let correct = item.is_correct === true;
        if (attempt.type !== 'practice') {
          correct =
            item.response !== null &&
            check(item.answer_key as unknown as AnswerKey, item.response as Response).correct;
          await trx
            .updateTable('attempt_items')
            .set({ is_correct: correct, score: correct ? 1 : 0 })
            .where('id', '=', item.id)
            .execute();
        }
        if (correct) score += 1;
      }
      const passed =
        attempt.type === 'practice'
          ? null
          : items.length > 0 && score / items.length >= this.rules.learning.masteryThreshold;
      await trx
        .updateTable('attempts')
        .set({
          status: 'submitted',
          submitted_at: this.clock.now(),
          score,
          max_score: items.length,
          passed,
        })
        .where('id', '=', attemptId)
        .execute();
    });
    return this.result(userId, attemptId, locale);
  }

  /** What the lesson player needs to show the practice and mastery steps. */
  async topicStatus(userId: string, topicId: string): Promise<TopicAssessmentStatus> {
    await this.catalogue.openTopic(topicId, userId);
    const [templates, correct, open, best, left] = await Promise.all([
      this.publishedTemplates(topicId),
      this.practiceCorrect(userId, topicId),
      this.db
        .selectFrom('attempts as a')
        .innerJoin('assessments as s', 's.id', 'a.assessment_id')
        .select(['a.id', 's.type'])
        .where('a.user_id', '=', userId)
        .where('a.topic_id', '=', topicId)
        .where('a.status', '=', 'in_progress')
        .execute(),
      this.db
        .selectFrom('attempts as a')
        .innerJoin('assessments as s', 's.id', 'a.assessment_id')
        .select(['a.score', 'a.max_score', 'a.passed', 'a.submitted_at'])
        .where('a.user_id', '=', userId)
        .where('a.topic_id', '=', topicId)
        .where('s.type', '=', 'mastery')
        .where('a.status', '=', 'submitted')
        .orderBy('a.passed', 'desc')
        .orderBy(sql`a.score / nullif(a.max_score, 0)`, 'desc')
        .orderBy('a.submitted_at', 'desc')
        .executeTakeFirst(),
      this.exercisesLeft(userId),
    ]);
    const required = this.rules.learning.practice.minCorrectBeforeMasteryTest;
    return {
      topicId,
      questionCount: templates.length,
      practice: {
        correct,
        required,
        openAttemptId: open.find((a) => a.type === 'practice')?.id ?? null,
      },
      mastery: {
        unlocked: templates.length > 0 && correct >= required,
        openAttemptId: open.find((a) => a.type === 'mastery')?.id ?? null,
        best: best
          ? {
              score: Number(best.score),
              maxScore: Number(best.max_score),
              passed: best.passed === true,
              submittedAt: best.submitted_at!.toISOString(),
            }
          : null,
      },
      dailyExercisesLeft: left,
    };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async result(
    userId: string,
    attemptId: string,
    locale: string,
  ): Promise<AttemptResultView> {
    const attempt = await this.attemptRow(userId, attemptId, this.db);
    const items = await this.db
      .selectFrom('attempt_items')
      .select(['position', 'is_correct', 'presented', 'feedback', 'answer_key'])
      .where('attempt_id', '=', attemptId)
      .orderBy('position')
      .execute();
    const correct = items.filter((i) => i.is_correct === true).length;
    let byTopic: AttemptResultView['byTopic'] = [];
    if (attempt.topic_id) {
      const topic = await this.db
        .selectFrom('topics as t')
        .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
        .select('v.title')
        .where('t.id', '=', attempt.topic_id)
        .executeTakeFirst();
      byTopic = [
        {
          topicId: attempt.topic_id,
          title: topic ? this.text(topic.title, locale) : '',
          correct,
          total: items.length,
        },
      ];
    }
    return {
      attemptId,
      type: attempt.type,
      score: Number(attempt.score ?? correct),
      maxScore: Number(attempt.max_score ?? items.length),
      passed: attempt.passed,
      byTopic,
      review: items.map((i) => {
        const solution = (i.feedback as unknown as ItemFeedback).solution;
        return {
          position: i.position,
          correct: i.is_correct === true,
          stem: this.text((i.presented as unknown as Presented).stem, locale),
          correctAnswer: this.answerText(i, locale),
          solution: solution ? this.text(solution, locale) : null,
        };
      }),
      // The gap router (step 6.4c) replaces this simple rule.
      recommendation: {
        action:
          attempt.type === 'mastery' && attempt.passed === false ? 'retry_practice' : 'continue',
        topicId: attempt.topic_id,
      },
    };
  }

  private async attemptRow(
    userId: string,
    attemptId: string,
    db: Kysely<Database> | Transaction<Database>,
    forUpdate = false,
  ) {
    let query = db
      .selectFrom('attempts as a')
      .innerJoin('assessments as s', 's.id', 'a.assessment_id')
      .select([
        'a.id',
        's.type',
        'a.topic_id',
        'a.status',
        'a.deadline_at',
        'a.score',
        'a.max_score',
        'a.passed',
      ])
      .where('a.id', '=', attemptId)
      .where('a.user_id', '=', userId);
    if (forUpdate) query = query.forUpdate('a');
    const attempt = await query.executeTakeFirst();
    if (!attempt) throw attemptNotFound();
    return attempt;
  }

  private async loadItem(
    userId: string,
    attemptId: string,
    position: number,
    db: Kysely<Database> | Transaction<Database> = this.db,
  ) {
    const attempt = await this.attemptRow(userId, attemptId, db, db !== this.db);
    let query = db
      .selectFrom('attempt_items as i')
      .innerJoin('question_template_versions as v', 'v.id', 'i.template_version_id')
      .selectAll('i')
      .select('v.type')
      .where('i.attempt_id', '=', attemptId)
      .where('i.position', '=', position);
    if (db !== this.db) query = query.forUpdate('i');
    const item = await query.executeTakeFirst();
    if (!item) throw new ProblemException(404, 'NOT_FOUND', 'Question not found.');
    return { attempt, item };
  }

  /** Expires a timed attempt whose deadline passed. @throws 409 or 410. */
  private async assertOpen(
    attempt: { id: string; status: string; deadline_at: Date | null },
    trx: Transaction<Database>,
  ): Promise<void> {
    if (attempt.status === 'expired') {
      throw new ProblemException(410, 'ATTEMPT_EXPIRED', 'The time for this attempt is over.');
    }
    if (attempt.status !== 'in_progress') throw closedAttempt();
    if (attempt.deadline_at && attempt.deadline_at <= this.clock.now()) {
      await trx
        .updateTable('attempts')
        .set({ status: 'expired' })
        .where('id', '=', attempt.id)
        .execute();
      throw new ProblemException(410, 'ATTEMPT_EXPIRED', 'The time for this attempt is over.');
    }
  }

  /** The assessment row for a topic and type, created on first use. */
  private async assessmentFor(type: AvailableType, topicId: string): Promise<string> {
    await this.db
      .insertInto('assessments')
      .values({ id: newId(), type, scope_type: 'topic', scope_id: topicId })
      .onConflict((oc) => oc.columns(['type', 'scope_type', 'scope_id', 'version_no']).doNothing())
      .execute();
    const row = await this.db
      .selectFrom('assessments')
      .select('id')
      .where('type', '=', type)
      .where('scope_type', '=', 'topic')
      .where('scope_id', '=', topicId)
      .where('version_no', '=', 1)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  private async openAttempt(userId: string, assessmentId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('attempts')
      .select('id')
      .where('user_id', '=', userId)
      .where('assessment_id', '=', assessmentId)
      .where('status', '=', 'in_progress')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  private async publishedTemplates(topicId: string) {
    return this.db
      .selectFrom('question_templates as q')
      .innerJoin('question_template_versions as v', 'v.id', 'q.published_version_id')
      .select(['v.id as versionId', 'v.difficulty', 'v.type', 'v.body'])
      .where('q.topic_id', '=', topicId)
      .where('v.status', '=', 'published')
      .orderBy('v.id')
      .execute();
  }

  private generateItems(
    plan: { versionId: string }[],
    templates: Awaited<ReturnType<AttemptsService['publishedTemplates']>>,
  ) {
    const byId = new Map(templates.map((t) => [t.versionId, t]));
    const items = [];
    for (const { versionId } of plan) {
      const template = byId.get(versionId)!;
      const seed = randomBytes(12).toString('hex');
      try {
        const body = templateBody.parse(template.body);
        items.push({ versionId, seed, generated: generate(template.type as never, body, seed) });
      } catch (error) {
        // Published templates passed sampling, so this is rare: skip the item, keep the set.
        if (!(error instanceof TemplateError)) throw error;
        this.logger.warn(`template version ${versionId} failed to generate: ${String(error)}`);
      }
    }
    return items;
  }

  /** Practice questions answered correctly on this topic, over all sets. */
  private async practiceCorrect(userId: string, topicId: string): Promise<number> {
    const row = await this.db
      .selectFrom('attempt_items as i')
      .innerJoin('attempts as a', 'a.id', 'i.attempt_id')
      .innerJoin('assessments as s', 's.id', 'a.assessment_id')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('a.user_id', '=', userId)
      .where('a.topic_id', '=', topicId)
      .where('s.type', '=', 'practice')
      .where('i.is_correct', '=', true)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /** Practice answers left today on the free plan, or null for subscribers. */
  private async exercisesLeft(userId: string): Promise<number | null> {
    if (await this.entitlements.hasSubscription(userId)) return null;
    const limit = this.rules.limits.freeTier.dailyExercises;
    const row = await this.db
      .selectFrom('daily_usage')
      .select('exercises_count')
      .where('user_id', '=', userId)
      .where('day', '=', tashkentDay(this.clock.now()))
      .executeTakeFirst();
    return Math.max(0, limit - (row?.exercises_count ?? 0));
  }

  /**
   * Counts one practice exercise against the free daily limit, atomically:
   * the increment only happens while the count is under the limit.
   */
  private async countExercise(userId: string, trx: Transaction<Database>): Promise<void> {
    if (await this.entitlements.hasSubscription(userId)) return;
    const limit = this.rules.limits.freeTier.dailyExercises;
    const counted = await trx
      .insertInto('daily_usage')
      .values({ user_id: userId, day: tashkentDay(this.clock.now()), exercises_count: 1 })
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'day'])
          .doUpdateSet({ exercises_count: sql`daily_usage.exercises_count + 1` })
          .where('daily_usage.exercises_count', '<', limit),
      )
      .returning('exercises_count')
      .executeTakeFirst();
    if (!counted) throw dailyLimit();
  }

  private localise(stored: StoredFeedback, locale: string, item?: ItemContext): Feedback {
    const { hintIndex, showSolution, ...rest } = stored;
    const out: Feedback = { ...rest };
    if (stored.correct === null) return out;
    const feedback = item?.feedback as ItemFeedback | undefined;
    out.hint = null;
    out.solution = null;
    if (item && showSolution) out.correctAnswer = this.answerText(item, locale);
    if (feedback && hintIndex !== undefined && hintIndex !== null) {
      const hint = feedback.hints[hintIndex];
      out.hint = hint ? this.text(hint, locale) : null;
    }
    if (feedback && showSolution && feedback.solution) {
      out.solution = this.text(feedback.solution, locale);
    }
    return out;
  }

  /** The right answer as a learner reads it: a fraction in LaTeX, `2,5`, or the option text. */
  private answerText(item: ItemContext, locale: string): string {
    const key = item.answer_key as AnswerKey;
    if (key.kind === 'choice') {
      const choices = (item.presented as Presented).choices ?? [];
      return choices
        .filter((c) => key.correct.includes(c.id))
        .map((c) => this.text(c.text, locale))
        .join('; ');
    }
    const value = Rational.parse(key.value)!;
    if (key.kind === 'number' && (key.decimals !== undefined || value.isTerminating())) {
      return value.toDecimal(key.decimals ?? decimalsOf(value)).replace('.', ',');
    }
    return `$${formatValue(value, true)}$`;
  }

  private text(text: Record<string, string | undefined>, locale: string): string {
    return pickText(text, locale, this.rules.content.defaultLocale);
  }
}

/** The stored parts of an item that feedback is rendered from. */
interface ItemContext {
  presented: unknown;
  answer_key: unknown;
  feedback: unknown;
}

/** Feedback as stored with the item: hint and solution by reference, rendered per request. */
interface StoredFeedback {
  accepted: boolean;
  correct: boolean | null;
  reason?: Feedback['reason'];
  triesLeft?: number;
  hintIndex?: number | null;
  showSolution?: boolean;
}

// 402, as the contract's PaymentRequired response: a paid plan lifts the limit.
const dailyLimit = () =>
  new ProblemException(
    402,
    'DAILY_LIMIT_REACHED',
    'The free plan includes a limited number of practice questions a day.',
  );

function toResponse(input: AnswerInput): Response {
  return 'choiceIds' in input ? { choices: input.choiceIds } : { value: input.value };
}

function toInput(response: Response): AnswerInput {
  return 'choices' in response ? { choiceIds: response.choices } : { value: response.value };
}
