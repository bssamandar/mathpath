/**
 * Read side of the catalogue: tracks, course trees and lessons, published
 * content only (docs/architecture.md: `catalogue` module).
 *
 * Texts are returned in the reader's locale, so the client never downloads
 * all translations. What a learner may open is decided here: a free topic is
 * open to everyone signed in, any other topic needs an entitlement (402).
 */
import type { AppConfig } from '@mathpath/config';
import type { Database, LocalisedText } from '@mathpath/db';
import type { Kysely } from 'kysely';
import { ProblemException } from '../common/problem';
import { type LessonStep, lessonStep, pickText } from './documents';

/** Answers "may this user open this paid topic?". Billing provides the real one (step 6.5). */
export abstract class Entitlements {
  abstract hasAccess(userId: string, topicId: string): Promise<boolean>;
  /** True while the learner has a paid plan; free users get the daily exercise limit. */
  abstract hasSubscription(userId: string): Promise<boolean>;
}

/** Until billing exists, nobody has a paid entitlement; free topics stay open. */
export class NoEntitlements extends Entitlements {
  hasAccess(): Promise<boolean> {
    return Promise.resolve(false);
  }
  hasSubscription(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

export interface TrackView {
  id: string;
  slug: string;
  title: string;
  courses: { id: string; slug: string; title: string; grade: number | null }[];
}

export interface CourseTreeView {
  id: string;
  title: string;
  chapters: {
    id: string;
    title: string;
    topics: { id: string; title: string; isFree: boolean; locked: boolean }[];
  }[];
}

/** One step as the player receives it. */
export interface LessonStepView {
  index: number;
  type: LessonStep['type'];
  completed: boolean;
  mediaId?: string;
  activity?: string;
  config?: Record<string, unknown>;
  prompt?: string;
}

export interface LessonView {
  topicId: string;
  versionId: string;
  title: string;
  steps: LessonStepView[];
}

const courseNotFound = () =>
  new ProblemException(404, 'COURSE_NOT_FOUND', 'This course does not exist.');
const topicNotFound = () =>
  new ProblemException(404, 'TOPIC_NOT_FOUND', 'This topic does not exist.');

export class CatalogueService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly entitlements: Entitlements,
    private readonly rules: AppConfig['content'],
  ) {}

  /** Active tracks with their published courses. */
  async tracks(locale: string): Promise<TrackView[]> {
    const tracks = await this.db
      .selectFrom('tracks')
      .select(['id', 'slug', 'title'])
      .where('is_active', '=', true)
      .orderBy('sort')
      .orderBy('slug')
      .execute();
    const courses = await this.db
      .selectFrom('courses')
      .select(['id', 'track_id', 'slug', 'title', 'grade'])
      .where('status', '=', 'published')
      .orderBy('sort')
      .orderBy('slug')
      .execute();
    return tracks.map((track) => ({
      id: track.id,
      slug: track.slug,
      title: this.text(track.title, locale),
      courses: courses
        .filter((c) => c.track_id === track.id)
        .map((c) => ({
          id: c.id,
          slug: c.slug,
          title: this.text(c.title, locale),
          grade: c.grade,
        })),
    }));
  }

  /**
   * Chapters and topics of a published course. Only topics with a published
   * version appear; `locked` tells the client to show the upgrade hint.
   */
  async courseTree(
    courseId: string,
    locale: string,
    userId: string | null,
  ): Promise<CourseTreeView> {
    const course = await this.db
      .selectFrom('courses')
      .select(['id', 'title'])
      .where('id', '=', courseId)
      .where('status', '=', 'published')
      .executeTakeFirst();
    if (!course) throw courseNotFound();

    const chapters = await this.db
      .selectFrom('chapters')
      .select(['id', 'title'])
      .where('course_id', '=', courseId)
      .where('status', '=', 'published')
      .orderBy('sort')
      .orderBy('slug')
      .execute();
    const topics =
      chapters.length === 0
        ? []
        : await this.db
            .selectFrom('topics as t')
            .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
            .select(['t.id', 't.chapter_id', 't.is_free', 'v.title'])
            .where(
              't.chapter_id',
              'in',
              chapters.map((c) => c.id),
            )
            .orderBy('t.sort')
            .orderBy('t.slug')
            .execute();

    const access = new Map<string, boolean>();
    for (const topic of topics) {
      access.set(
        topic.id,
        topic.is_free || (userId !== null && (await this.entitlements.hasAccess(userId, topic.id))),
      );
    }
    return {
      id: course.id,
      title: this.text(course.title, locale),
      chapters: chapters.map((chapter) => ({
        id: chapter.id,
        title: this.text(chapter.title, locale),
        topics: topics
          .filter((t) => t.chapter_id === chapter.id)
          .map((t) => ({
            id: t.id,
            title: this.text(t.title, locale),
            isFree: t.is_free,
            locked: !access.get(t.id),
          })),
      })),
    };
  }

  /**
   * The published lesson of a topic, in the reader's locale.
   * @throws ProblemException 404 when unpublished, 402 PAYMENT_REQUIRED without access.
   */
  async lesson(topicId: string, locale: string, userId: string): Promise<LessonView> {
    const topic = await this.openTopic(topicId, userId);
    const steps = lessonStep.array().parse(topic.steps);
    return {
      topicId: topic.id,
      versionId: topic.version_id,
      title: this.text(topic.title, locale),
      // Progress tracking arrives with the learning module (step 6.4).
      steps: steps.map((step, index) => this.stepView(step, index, locale)),
    };
  }

  /**
   * A published topic the learner may open, with its title in every locale.
   * @throws ProblemException 404 when unpublished, 402 PAYMENT_REQUIRED without access.
   */
  async openTopic(topicId: string, userId: string) {
    const topic = await this.db
      .selectFrom('topics as t')
      .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
      .innerJoin('chapters as ch', 'ch.id', 't.chapter_id')
      .innerJoin('courses as c', 'c.id', 'ch.course_id')
      .select(['t.id', 't.is_free', 'v.id as version_id', 'v.title', 'v.steps'])
      .where('t.id', '=', topicId)
      .where('ch.status', '=', 'published')
      .where('c.status', '=', 'published')
      .executeTakeFirst();
    if (!topic) throw topicNotFound();
    if (!topic.is_free && !(await this.entitlements.hasAccess(userId, topicId))) {
      throw new ProblemException(402, 'PAYMENT_REQUIRED', 'This topic is part of a paid plan.');
    }
    return topic;
  }

  private stepView(step: LessonStep, index: number, locale: string): LessonStepView {
    const base = { index, type: step.type, completed: false };
    switch (step.type) {
      case 'video':
        return { ...base, mediaId: step.mediaId };
      case 'activity':
        return {
          ...base,
          activity: step.activity,
          config: step.config,
          prompt: this.text(step.prompt, locale),
        };
      case 'practice':
        return { ...base, prompt: this.text(step.prompt, locale) };
      default:
        return base;
    }
  }

  private text(text: LocalisedText, locale: string): string {
    return pickText(text, locale, this.rules.defaultLocale);
  }
}
