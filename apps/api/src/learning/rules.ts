/**
 * The adaptivity rules (architecture §5.2–5.3, ADR-0006), as pure functions.
 *
 * Each rule is deterministic and explainable: the decision carries a reason
 * code that is logged and can be shown to a parent ("sent to Fractions
 * because it was not mastered"). They sit behind the `GapRouter`,
 * `ReviewScheduler` and path interfaces in learning.service.ts, so a
 * statistical model can replace them later without touching callers.
 */
import type { AppConfig } from '@mathpath/config';
import type { MasteryState } from '@mathpath/db';

type LearningRules = AppConfig['learning'];
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PrerequisiteState {
  topicId: string;
  state: MasteryState;
  /** Latest mastery estimate (0–1), null when never tested. */
  mastery: number | null;
  masteredAt: Date | null;
}

export type GapDecision =
  | { action: 'retry_practice'; topicId: string; reason: 'no_weak_prerequisite' }
  | { action: 'take_break'; topicId: string; reason: 'max_depth' | 'max_per_day' }
  | {
      action: 'prerequisite_review';
      topicId: string;
      reason: 'not_mastered' | 'low_mastery' | 'stale' | 'needs_review';
      depth: number;
    };

/** Why a prerequisite counts as weak, or null when it is fine. */
export function weakness(
  p: PrerequisiteState,
  rules: LearningRules,
  now: Date,
): 'not_mastered' | 'low_mastery' | 'stale' | 'needs_review' | null {
  if (p.state === 'needs_review') return 'needs_review';
  if (p.state !== 'mastered') return 'not_mastered';
  if (p.mastery !== null && p.mastery < rules.masteryThreshold) return 'low_mastery';
  const staleAfter = rules.gapRouting.staleAfterDays * DAY_MS;
  if (!p.masteredAt || now.getTime() - p.masteredAt.getTime() > staleAfter) return 'stale';
  return null;
}

/**
 * After a failed mastery test: send the learner to their weakest required
 * prerequisite, unless the depth or daily detour limits are reached, in
 * which case they rest and the parent is told; with no weak prerequisite
 * they practise the topic again.
 * @param currentDepth - How deep in a detour chain this topic already is (0 = on the main path).
 */
export function routeGap(input: {
  topicId: string;
  prerequisites: readonly PrerequisiteState[];
  currentDepth: number;
  detoursToday: number;
  rules: LearningRules;
  now: Date;
}): GapDecision {
  const { rules, now } = input;
  const weak = input.prerequisites
    .map((p) => ({ p, why: weakness(p, rules, now) }))
    .filter((w): w is { p: PrerequisiteState; why: NonNullable<typeof w.why> } => w.why !== null)
    // Weakest first: never tested counts as 0; ties keep the graph order.
    .sort((a, b) => (a.p.mastery ?? 0) - (b.p.mastery ?? 0));
  if (weak.length === 0) {
    return { action: 'retry_practice', topicId: input.topicId, reason: 'no_weak_prerequisite' };
  }
  const depth = input.currentDepth + 1;
  if (depth > rules.gapRouting.maxDepth) {
    return { action: 'take_break', topicId: input.topicId, reason: 'max_depth' };
  }
  if (input.detoursToday >= rules.gapRouting.maxDetoursPerDay) {
    return { action: 'take_break', topicId: input.topicId, reason: 'max_per_day' };
  }
  const first = weak[0]!;
  return { action: 'prerequisite_review', topicId: first.p.topicId, reason: first.why, depth };
}

export interface ReviewState {
  intervalDays: number | null;
  ease: number | null;
  reviewCount: number;
}

export interface ReviewPlan {
  intervalDays: number;
  ease: number;
  reviewCount: number;
  nextReviewAt: Date;
}

/** The first review after a topic is mastered. */
export function firstReview(rules: LearningRules, now: Date): ReviewPlan {
  const intervalDays = rules.reviewIntervalsDays[0]!;
  return {
    intervalDays,
    ease: rules.review.initialEase,
    reviewCount: 0,
    nextReviewAt: new Date(now.getTime() + intervalDays * DAY_MS),
  };
}

/**
 * SM-2 style scheduling. A passed review moves to the next configured
 * interval, then grows by the ease; a failed one starts again from the
 * first interval and lowers the ease (never below 1.3).
 */
export function nextReview(
  state: ReviewState,
  passed: boolean,
  rules: LearningRules,
  now: Date,
): ReviewPlan {
  const intervals = rules.reviewIntervalsDays;
  const ease = state.ease ?? rules.review.initialEase;
  if (!passed) {
    const first = intervals[0]!;
    return {
      intervalDays: first,
      ease: Math.max(1.3, round2(ease - 0.2)),
      reviewCount: 0,
      nextReviewAt: new Date(now.getTime() + first * DAY_MS),
    };
  }
  const count = state.reviewCount + 1;
  const intervalDays =
    count < intervals.length
      ? intervals[count]!
      : Math.min(365, Math.round((state.intervalDays ?? intervals.at(-1)!) * ease));
  return {
    intervalDays,
    ease,
    reviewCount: count,
    nextReviewAt: new Date(now.getTime() + intervalDays * DAY_MS),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PathTopic {
  topicId: string;
  state: MasteryState;
  reviewDue: boolean;
}

export type PathReason = 'next_in_course' | 'prerequisite_gap' | 'review_due';

/**
 * The learning path (architecture §5.3): due reviews first, then the
 * course's topics in an order that puts every prerequisite before the topic
 * that needs it (course order breaks ties), without mastered topics.
 * Prerequisites a detour added are placed just before the topic they help.
 * @param topics - The course's topics in course order.
 * @param edges - Required prerequisite edges among these topics.
 * @param gaps - Detours that added a prerequisite to the path: `[forTopic, prerequisite]`.
 */
export function buildPath(
  topics: readonly PathTopic[],
  edges: readonly { topicId: string; prerequisiteId: string }[],
  gaps: readonly { forTopicId: string; prerequisite: PathTopic }[],
): { topicId: string; reason: PathReason; state: MasteryState }[] {
  const order = topologicalOrder(
    topics.map((t) => t.topicId),
    edges,
  );
  const byId = new Map(topics.map((t) => [t.topicId, t]));
  const out: { topicId: string; reason: PathReason; state: MasteryState }[] = [];
  const seen = new Set<string>();
  const push = (t: PathTopic, reason: PathReason) => {
    if (seen.has(t.topicId)) return;
    seen.add(t.topicId);
    out.push({ topicId: t.topicId, reason, state: t.state });
  };
  for (const t of topics) if (t.reviewDue) push(t, 'review_due');
  for (const g of gaps) if (g.prerequisite.reviewDue) push(g.prerequisite, 'review_due');
  for (const id of order) {
    const topic = byId.get(id)!;
    if (topic.state === 'mastered') continue;
    for (const g of gaps) {
      if (g.forTopicId === id && g.prerequisite.state !== 'mastered') {
        push(g.prerequisite, 'prerequisite_gap');
      }
    }
    push(topic, 'next_in_course');
  }
  return out;
}

/**
 * Kahn's algorithm, always taking the earliest ready topic in course order.
 * Edges to topics outside the list are ignored; a cycle (which the database
 * refuses) would leave the remaining topics in course order at the end.
 */
export function topologicalOrder(
  ids: readonly string[],
  edges: readonly { topicId: string; prerequisiteId: string }[],
): string[] {
  const index = new Map(ids.map((id, i) => [id, i]));
  const waiting = new Map(ids.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>();
  for (const e of edges) {
    if (!index.has(e.topicId) || !index.has(e.prerequisiteId)) continue;
    waiting.set(e.topicId, waiting.get(e.topicId)! + 1);
    dependents.set(e.prerequisiteId, [...(dependents.get(e.prerequisiteId) ?? []), e.topicId]);
  }
  const done: string[] = [];
  const placed = new Set<string>();
  while (done.length < ids.length) {
    const next = ids.find((id) => !placed.has(id) && waiting.get(id) === 0);
    if (next === undefined) break;
    placed.add(next);
    done.push(next);
    for (const d of dependents.get(next) ?? []) waiting.set(d, waiting.get(d)! - 1);
  }
  return [...done, ...ids.filter((id) => !placed.has(id))];
}
