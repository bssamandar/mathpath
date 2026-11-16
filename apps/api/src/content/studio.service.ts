/**
 * Authoring workflow for lesson content (docs/architecture.md, UX F9; C-18).
 *
 *   draft ──submit──▶ in_review ──approve──▶ approved ──publish──▶ published
 *     ▲                   │                                           │
 *     └──changes_requested┘                         (next publish) archived
 *
 * Rules:
 * - One open version per topic (also a database index), copied from the latest.
 * - Saving needs the ETag from the last read, so two editors cannot overwrite
 *   each other unseen (412 on a stale save).
 * - A reviewer may not review their own version (four-eyes rule, C-18).
 * - Publishing archives the previous published version; the database refuses
 *   any later change to either (migration 2026111601).
 */
import type { AppConfig } from '@mathpath/config';
import {
  type Database,
  type LocalisedText,
  newId,
  type Role,
  type TopicVersionsTable,
  type VersionStatus,
} from '@mathpath/db';
import type { Kysely, Selectable } from 'kysely';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import {
  contentHash,
  incompleteFields,
  type LessonStep,
  lessonStep,
  type TopicVersionInput,
} from './documents';

export interface StudioActor {
  userId: string;
  roles: readonly Role[];
}

/** `ContentVersionSummary` in docs/api/openapi.yaml. */
export interface VersionSummary {
  id: string;
  versionNo: number;
  status: VersionStatus;
  authorId: string;
  updatedAt: string;
  publishedAt: string | null;
}

/** `TopicVersion`: the summary, the editable content and the review history. */
export interface VersionView extends VersionSummary {
  topicId: string;
  etag: string;
  title: LocalisedText;
  summary: LocalisedText;
  steps: LessonStep[];
  questionPool: Record<string, unknown>;
  reviews: { reviewerId: string; decision: string; comments: unknown[]; createdAt: string }[];
}

type VersionRow = Selectable<TopicVersionsTable>;

const EDITABLE: readonly VersionStatus[] = ['draft', 'changes_requested'];

const notFound = () =>
  new ProblemException(404, 'VERSION_NOT_FOUND', 'This version does not exist.');
const wrongState = (status: VersionStatus, action: string) =>
  new ProblemException(409, 'VERSION_STATE_CONFLICT', `A ${status} version cannot be ${action}.`);

export class StudioService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly rules: AppConfig['content'],
  ) {}

  /** Version history of a topic, newest first. */
  async listVersions(topicId: string): Promise<VersionSummary[]> {
    await this.assertTopic(topicId);
    const rows = await this.db
      .selectFrom('topic_versions')
      .selectAll()
      .where('topic_id', '=', topicId)
      .orderBy('version_no', 'desc')
      .execute();
    return rows.map(summary);
  }

  /**
   * Starts a new draft, copied from the latest version so an edit starts from
   * what learners see now.
   * @throws ProblemException 409 DRAFT_EXISTS when an open version exists.
   */
  async createDraft(actor: StudioActor, topicId: string): Promise<VersionView> {
    await this.assertTopic(topicId);
    const id = newId();
    await this.db.transaction().execute(async (trx) => {
      // Lock the topic so two "new draft" clicks cannot race on version_no.
      await trx.selectFrom('topics').select('id').where('id', '=', topicId).forUpdate().execute();
      const latest = await trx
        .selectFrom('topic_versions')
        .selectAll()
        .where('topic_id', '=', topicId)
        .orderBy('version_no', 'desc')
        .executeTakeFirst();
      if (latest && !['published', 'archived'].includes(latest.status)) {
        throw new ProblemException(409, 'DRAFT_EXISTS', 'This topic already has an open version.', {
          errors: [{ field: 'versionId', message: latest.id }],
        });
      }
      const content = {
        title: latest?.title ?? {},
        summary: latest?.summary ?? {},
        steps: latest?.steps ?? [],
        question_pool: latest?.question_pool ?? {},
      };
      await trx
        .insertInto('topic_versions')
        .values({
          id,
          topic_id: topicId,
          version_no: (latest?.version_no ?? 0) + 1,
          title: JSON.stringify(content.title),
          summary: JSON.stringify(content.summary),
          steps: JSON.stringify(content.steps),
          question_pool: JSON.stringify(content.question_pool),
          author_id: actor.userId,
          content_hash: contentHash(content),
        })
        .execute();
      await this.audit.record(
        {
          action: 'content.draft_create',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'topic_version',
          targetId: id,
          metadata: { topicId, basedOn: latest?.id ?? null },
        },
        trx,
      );
    });
    return this.getVersion(id);
  }

  async getVersion(versionId: string): Promise<VersionView> {
    const row = await this.find(versionId);
    const reviews = await this.db
      .selectFrom('content_reviews')
      .select(['reviewer_id', 'decision', 'comments', 'created_at'])
      .where('entity_type', '=', 'topic_version')
      .where('entity_id', '=', versionId)
      .orderBy('created_at', 'desc')
      .execute();
    return {
      ...summary(row),
      topicId: row.topic_id,
      etag: etagOf(row),
      title: row.title,
      summary: row.summary,
      steps: row.steps as LessonStep[],
      questionPool: row.question_pool,
      reviews: reviews.map((r) => ({
        reviewerId: r.reviewer_id,
        decision: r.decision,
        comments: r.comments,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /**
   * Saves a draft. A version sent back for changes becomes a draft again.
   * @throws ProblemException 409 when not editable, 412 when `ifMatch` is stale.
   */
  async saveDraft(
    actor: StudioActor,
    versionId: string,
    ifMatch: string | undefined,
    input: TopicVersionInput,
  ): Promise<VersionView> {
    await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('topic_versions')
        .selectAll()
        .where('id', '=', versionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw notFound();
      if (!EDITABLE.includes(row.status)) throw wrongState(row.status, 'edited');
      // updated_at is set by a trigger to the transaction time, so every save changes the ETag.
      if (ifMatch !== etagOf(row)) {
        throw new ProblemException(
          412,
          'VERSION_CHANGED',
          'Someone else saved this version. Reload it to see their changes.',
        );
      }
      const content = {
        title: input.title,
        summary: input.summary,
        steps: input.steps,
        question_pool: input.questionPool,
      };
      await trx
        .updateTable('topic_versions')
        .set({
          status: 'draft',
          title: JSON.stringify(content.title),
          summary: JSON.stringify(content.summary),
          steps: JSON.stringify(content.steps),
          question_pool: JSON.stringify(content.question_pool),
          content_hash: contentHash(content),
        })
        .where('id', '=', versionId)
        .execute();
      await this.audit.record(
        {
          action: 'content.draft_save',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'topic_version',
          targetId: versionId,
        },
        trx,
      );
    });
    return this.getVersion(versionId);
  }

  /**
   * Sends a draft to review once it is complete in the required locales.
   * @throws ProblemException 422 CONTENT_INCOMPLETE with the missing fields.
   */
  async submit(actor: StudioActor, versionId: string): Promise<VersionSummary> {
    const row = await this.find(versionId);
    if (!EDITABLE.includes(row.status)) throw wrongState(row.status, 'submitted');
    // Steps were validated when saved; parsing again guards rows written by seeds.
    const steps = lessonStep.array().parse(row.steps);
    const errors = incompleteFields(
      { title: row.title, summary: row.summary, steps },
      this.rules.requiredContentLocales,
    );
    if (errors.length > 0) {
      throw new ProblemException(422, 'CONTENT_INCOMPLETE', 'Some required texts are missing.', {
        errors,
      });
    }
    return this.transition(actor, row, 'in_review', 'content.submit');
  }

  /**
   * Records a review decision.
   * @throws ProblemException 403 FOUR_EYES when the reviewer wrote the version.
   */
  async review(
    actor: StudioActor,
    versionId: string,
    decision: 'approved' | 'changes_requested',
    comments: { anchor?: string | undefined; text: string }[],
  ): Promise<VersionSummary> {
    const row = await this.find(versionId);
    if (row.status !== 'in_review') throw wrongState(row.status, 'reviewed');
    if (row.author_id === actor.userId) {
      throw new ProblemException(403, 'FOUR_EYES', 'You cannot review a version you wrote.');
    }
    return this.transition(actor, row, decision, `content.review_${decision}`, async (trx) => {
      await trx
        .insertInto('content_reviews')
        .values({
          id: newId(),
          entity_type: 'topic_version',
          entity_id: versionId,
          reviewer_id: actor.userId,
          decision,
          comments: JSON.stringify(comments),
        })
        .execute();
    });
  }

  /** Publishes an approved version; the previous published one is archived. */
  async publish(actor: StudioActor, versionId: string): Promise<VersionSummary> {
    const row = await this.find(versionId);
    if (row.status !== 'approved') throw wrongState(row.status, 'published');
    const now = this.clock.now();
    return this.transition(
      actor,
      row,
      'published',
      'content.publish',
      async (trx) => {
        const topic = await trx
          .selectFrom('topics')
          .select('published_version_id')
          .where('id', '=', row.topic_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (topic.published_version_id) {
          await trx
            .updateTable('topic_versions')
            .set({ status: 'archived' })
            .where('id', '=', topic.published_version_id)
            .execute();
        }
        await trx
          .updateTable('topics')
          .set({ published_version_id: versionId })
          .where('id', '=', row.topic_id)
          .execute();
      },
      now,
    );
  }

  /**
   * Moves a version to `to` only if it is still in the state it was read in,
   * so two reviewers clicking at once cannot both act; then runs `then` in
   * the same transaction.
   */
  private async transition(
    actor: StudioActor,
    row: VersionRow,
    to: VersionStatus,
    action: string,
    then?: (trx: Kysely<Database>) => Promise<void>,
    publishedAt?: Date,
  ): Promise<VersionSummary> {
    await this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable('topic_versions')
        .set({ status: to, ...(publishedAt ? { published_at: publishedAt } : {}) })
        .where('id', '=', row.id)
        .where('status', '=', row.status)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw wrongState(row.status, 'changed now');
      await then?.(trx);
      await this.audit.record(
        {
          action,
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'topic_version',
          targetId: row.id,
          metadata: {
            topicId: row.topic_id,
            versionNo: row.version_no,
            contentHash: row.content_hash,
          },
        },
        trx,
      );
    });
    return summary(await this.find(row.id));
  }

  private async find(versionId: string): Promise<VersionRow> {
    const row = await this.db
      .selectFrom('topic_versions')
      .selectAll()
      .where('id', '=', versionId)
      .executeTakeFirst();
    if (!row) throw notFound();
    return row;
  }

  private async assertTopic(topicId: string): Promise<void> {
    const topic = await this.db
      .selectFrom('topics')
      .select('id')
      .where('id', '=', topicId)
      .executeTakeFirst();
    if (!topic) throw new ProblemException(404, 'TOPIC_NOT_FOUND', 'This topic does not exist.');
  }
}

function summary(row: VersionRow): VersionSummary {
  return {
    id: row.id,
    versionNo: row.version_no,
    status: row.status,
    authorId: row.author_id,
    updatedAt: row.updated_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

/** Changes on every save: the content hash and the save time together. */
function etagOf(row: VersionRow): string {
  return `"${row.content_hash.slice(0, 16)}-${row.updated_at.getTime()}"`;
}
