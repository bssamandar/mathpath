/**
 * Authoring question templates (schema doc §3.4, §4.2; step 6.4).
 *
 * Same workflow and rules as lesson versions (studio.service.ts): one open
 * version per template, ETag on save, four-eyes review, publish archives the
 * previous version and the database freezes both. On top of that, a template
 * must generate valid items before it can go to review: the engine runs it
 * with many seeds and reports the first broken field.
 */
import type { AppConfig } from '@mathpath/config';
import {
  type Database,
  newId,
  type QuestionTemplateVersionsTable,
  type VersionStatus,
} from '@mathpath/db';
import {
  generate,
  type LocalisedText,
  QUESTION_TYPES,
  type QuestionType,
  templateBody,
  TemplateError,
  validateTemplate,
} from '@mathpath/questions';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import { contentHash } from './documents';
import type { StudioActor, VersionSummary } from './studio.service';

/** `QuestionTemplateInput` in docs/api/openapi.yaml. */
export const questionTemplateInput = z
  .object({
    type: z.enum(QUESTION_TYPES),
    difficulty: z.number().int().min(1).max(5),
    skills: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/))
      .max(10)
      .default([]),
    externalRef: z.string().trim().max(64).optional(),
    body: templateBody,
  })
  .strict();
export type QuestionTemplateInput = z.infer<typeof questionTemplateInput>;

/** `QuestionTemplateVersion`: the summary plus the editable content and reviews. */
export interface QuestionVersionView extends VersionSummary {
  templateId: string;
  topicId: string;
  etag: string;
  type: QuestionType;
  difficulty: number;
  skills: string[];
  externalRef: string | null;
  body: Record<string, unknown>;
  reviews: { reviewerId: string; decision: string; comments: unknown[]; createdAt: string }[];
}

/** One row of `GET /studio/topics/{topicId}/question-templates`. */
export interface QuestionTemplateSummary {
  id: string;
  externalRef: string | null;
  publishedVersionId: string | null;
  latest: VersionSummary & { type: QuestionType; difficulty: number; stem: LocalisedText };
}

type Row = Selectable<QuestionTemplateVersionsTable>;

const EDITABLE: readonly VersionStatus[] = ['draft', 'changes_requested'];
const notFound = () =>
  new ProblemException(404, 'VERSION_NOT_FOUND', 'This version does not exist.');
const wrongState = (status: VersionStatus, action: string) =>
  new ProblemException(409, 'VERSION_STATE_CONFLICT', `A ${status} version cannot be ${action}.`);

export class QuestionStudioService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly rules: AppConfig['content'],
  ) {}

  /** True when the ID is a question template version (for the shared review routes). */
  async owns(versionId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('question_template_versions')
      .select('id')
      .where('id', '=', versionId)
      .executeTakeFirst();
    return Boolean(row);
  }

  /** Templates of a topic with their newest version, oldest template first. */
  async listTemplates(topicId: string): Promise<QuestionTemplateSummary[]> {
    await this.assertTopic(topicId);
    const rows = await this.db
      .selectFrom('question_templates as t')
      .innerJoin(
        (eb) =>
          eb
            .selectFrom('question_template_versions')
            .selectAll()
            .distinctOn('template_id')
            .orderBy('template_id')
            .orderBy('version_no', 'desc')
            .as('v'),
        (join) => join.onRef('v.template_id', '=', 't.id'),
      )
      .select([
        't.id as template_id',
        't.external_ref',
        't.published_version_id',
        'v.id',
        'v.version_no',
        'v.status',
        'v.author_id',
        'v.updated_at',
        'v.published_at',
        'v.type',
        'v.difficulty',
        'v.body',
      ])
      .where('t.topic_id', '=', topicId)
      .orderBy('t.created_at')
      .orderBy('t.id')
      .execute();
    return rows.map((r) => ({
      id: r.template_id,
      externalRef: r.external_ref,
      publishedVersionId: r.published_version_id,
      latest: {
        id: r.id,
        versionNo: r.version_no,
        status: r.status,
        authorId: r.author_id,
        updatedAt: r.updated_at.toISOString(),
        publishedAt: r.published_at?.toISOString() ?? null,
        type: r.type as QuestionType,
        difficulty: r.difficulty,
        stem: ((r.body as { stem?: LocalisedText }).stem ?? {}) as LocalisedText,
      },
    }));
  }

  /** Creates a template with its first draft. */
  async createTemplate(
    actor: StudioActor,
    topicId: string,
    input: QuestionTemplateInput,
  ): Promise<QuestionVersionView> {
    await this.assertTopic(topicId);
    const templateId = newId();
    const versionId = newId();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('question_templates')
        .values({
          id: templateId,
          topic_id: topicId,
          external_ref: input.externalRef ?? null,
          created_by: actor.userId,
        })
        .execute();
      await trx
        .insertInto('question_template_versions')
        .values({
          id: versionId,
          template_id: templateId,
          version_no: 1,
          author_id: actor.userId,
          ...columns(input),
        })
        .execute();
      await this.audit.record(
        {
          action: 'content.question_create',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'question_template_version',
          targetId: versionId,
          metadata: { topicId, templateId },
        },
        trx,
      );
    });
    return this.getVersion(versionId);
  }

  async listVersions(templateId: string): Promise<VersionSummary[]> {
    await this.assertTemplate(templateId);
    const rows = await this.db
      .selectFrom('question_template_versions')
      .selectAll()
      .where('template_id', '=', templateId)
      .orderBy('version_no', 'desc')
      .execute();
    return rows.map(summary);
  }

  /**
   * Starts a new draft copied from the latest version.
   * @throws ProblemException 409 DRAFT_EXISTS when an open version exists.
   */
  async createDraft(actor: StudioActor, templateId: string): Promise<QuestionVersionView> {
    await this.assertTemplate(templateId);
    const id = newId();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('question_templates')
        .select('id')
        .where('id', '=', templateId)
        .forUpdate()
        .execute();
      const latest = await trx
        .selectFrom('question_template_versions')
        .selectAll()
        .where('template_id', '=', templateId)
        .orderBy('version_no', 'desc')
        .executeTakeFirstOrThrow();
      if (!['published', 'archived'].includes(latest.status)) {
        throw new ProblemException(
          409,
          'DRAFT_EXISTS',
          'This question already has an open version.',
          {
            errors: [{ field: 'versionId', message: latest.id }],
          },
        );
      }
      await trx
        .insertInto('question_template_versions')
        .values({
          id,
          template_id: templateId,
          version_no: latest.version_no + 1,
          type: latest.type,
          difficulty: latest.difficulty,
          skills: latest.skills,
          body: JSON.stringify(latest.body),
          author_id: actor.userId,
          content_hash: latest.content_hash,
        })
        .execute();
      await this.audit.record(
        {
          action: 'content.draft_create',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'question_template_version',
          targetId: id,
          metadata: { templateId, basedOn: latest.id },
        },
        trx,
      );
    });
    return this.getVersion(id);
  }

  async getVersion(versionId: string): Promise<QuestionVersionView> {
    const row = await this.find(versionId);
    const [template, reviews] = await Promise.all([
      this.db
        .selectFrom('question_templates')
        .select(['topic_id', 'external_ref'])
        .where('id', '=', row.template_id)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('content_reviews')
        .select(['reviewer_id', 'decision', 'comments', 'created_at'])
        .where('entity_type', '=', 'question_template_version')
        .where('entity_id', '=', versionId)
        .orderBy('created_at', 'desc')
        .execute(),
    ]);
    return {
      ...summary(row),
      templateId: row.template_id,
      topicId: template.topic_id,
      etag: etagOf(row),
      type: row.type as QuestionType,
      difficulty: row.difficulty,
      skills: row.skills,
      externalRef: template.external_ref,
      body: row.body,
      reviews: reviews.map((r) => ({
        reviewerId: r.reviewer_id,
        decision: r.decision,
        comments: r.comments,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /**
   * Saves a draft. The body must have the right shape; whether it generates
   * items is checked on submit (and in the preview), so work in progress saves.
   * @throws ProblemException 409 when not editable, 412 when `ifMatch` is stale.
   */
  async saveDraft(
    actor: StudioActor,
    versionId: string,
    ifMatch: string | undefined,
    input: QuestionTemplateInput,
  ): Promise<QuestionVersionView> {
    await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('question_template_versions')
        .selectAll()
        .where('id', '=', versionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw notFound();
      if (!EDITABLE.includes(row.status)) throw wrongState(row.status, 'edited');
      if (ifMatch !== etagOf(row)) {
        throw new ProblemException(
          412,
          'VERSION_CHANGED',
          'Someone else saved this version. Reload it to see their changes.',
        );
      }
      await trx
        .updateTable('question_template_versions')
        .set({ status: 'draft', ...columns(input) })
        .where('id', '=', versionId)
        .execute();
      if (input.externalRef !== undefined) {
        await trx
          .updateTable('question_templates')
          .set({ external_ref: input.externalRef || null })
          .where('id', '=', row.template_id)
          .execute();
      }
      await this.audit.record(
        {
          action: 'content.draft_save',
          actorId: actor.userId,
          actorRoles: actor.roles,
          targetType: 'question_template_version',
          targetId: versionId,
        },
        trx,
      );
    });
    return this.getVersion(versionId);
  }

  /**
   * Sends a draft to review once it generates items and has every required locale.
   * @throws ProblemException 422 CONTENT_INCOMPLETE with the problems by field.
   */
  async submit(actor: StudioActor, versionId: string): Promise<VersionSummary> {
    const row = await this.find(versionId);
    if (!EDITABLE.includes(row.status)) throw wrongState(row.status, 'submitted');
    const errors = this.problems(row.type as QuestionType, row.body);
    if (errors.length > 0) {
      throw new ProblemException(
        422,
        'CONTENT_INCOMPLETE',
        'This question is not ready for review.',
        { errors },
      );
    }
    return this.transition(actor, row, 'in_review', 'content.submit');
  }

  /** @throws ProblemException 403 FOUR_EYES when the reviewer wrote the version. */
  async review(
    actor: StudioActor,
    versionId: string,
    decision: 'approved' | 'changes_requested',
    comments: { anchor?: string | undefined; text: string }[],
  ): Promise<VersionSummary> {
    const row = await this.find(versionId);
    if (row.status !== 'in_review') throw wrongState(row.status, 'reviewed');
    const selfReview = row.author_id === actor.userId;
    if (selfReview && !(this.rules.adminSelfReview && actor.roles.includes('admin'))) {
      throw new ProblemException(403, 'FOUR_EYES', 'You cannot review a version you wrote.');
    }
    return this.transition(actor, row, decision, `content.review_${decision}`, {
      metadata: { selfReview },
      then: async (trx) => {
        await trx
          .insertInto('content_reviews')
          .values({
            id: newId(),
            entity_type: 'question_template_version',
            entity_id: versionId,
            reviewer_id: actor.userId,
            decision,
            comments: JSON.stringify(comments),
          })
          .execute();
      },
    });
  }

  /** Publishes an approved version; the previous published one is archived. */
  async publish(actor: StudioActor, versionId: string): Promise<VersionSummary> {
    const row = await this.find(versionId);
    if (row.status !== 'approved') throw wrongState(row.status, 'published');
    return this.transition(actor, row, 'published', 'content.publish', {
      publishedAt: this.clock.now(),
      then: async (trx) => {
        const template = await trx
          .selectFrom('question_templates')
          .select('published_version_id')
          .where('id', '=', row.template_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (template.published_version_id) {
          await trx
            .updateTable('question_template_versions')
            .set({ status: 'archived' })
            .where('id', '=', template.published_version_id)
            .execute();
        }
        await trx
          .updateTable('question_templates')
          .set({ published_version_id: versionId })
          .where('id', '=', row.template_id)
          .execute();
      },
    });
  }

  /**
   * Sample items with their answers, for the author (`POST /studio/question-templates/preview`).
   * Never fails on a broken template: problems come back as warnings.
   */
  preview(
    type: QuestionType,
    rawBody: unknown,
    samples: number,
  ): {
    samples: { params: Record<string, string>; instance: unknown; answer: unknown }[];
    warnings: { field: string; message: string }[];
  } {
    const parsed = templateBody.safeParse(rawBody);
    if (!parsed.success) {
      return { samples: [], warnings: validateTemplate(type, rawBody).problems };
    }
    const out: { params: Record<string, string>; instance: unknown; answer: unknown }[] = [];
    try {
      for (let i = 0; i < samples; i++) {
        const item = generate(type, parsed.data, `preview-${Date.now()}-${i}`);
        out.push({ params: item.params, instance: item.presented, answer: item.answerKey });
      }
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      return { samples: out, warnings: [{ field: error.field, message: error.message }] };
    }
    return { samples: out, warnings: this.localeProblems(parsed.data) };
  }

  /** Engine problems first; then missing translations in the required locales. */
  private problems(type: QuestionType, body: unknown): { field: string; message: string }[] {
    const result = validateTemplate(type, body);
    if (result.problems.length > 0 || !result.body) return result.problems;
    return this.localeProblems(result.body);
  }

  private localeProblems(body: z.infer<typeof templateBody>): { field: string; message: string }[] {
    const errors: { field: string; message: string }[] = [];
    const check = (field: string, text: LocalisedText | undefined) => {
      for (const locale of this.rules.requiredContentLocales) {
        if (!text?.[locale as keyof LocalisedText]?.trim())
          errors.push({ field, message: `missing ${locale} text` });
      }
    };
    check('body/stem', body.stem);
    body.hints.forEach((h, i) => check(`body/hints/${i}`, h));
    if (body.solution) check('body/solution', body.solution);
    if (body.answer.kind === 'choices')
      body.answer.options.forEach((o, i) => check(`body/answer/options/${i}/text`, o.text));
    return errors;
  }

  private async transition(
    actor: StudioActor,
    row: Row,
    to: VersionStatus,
    action: string,
    options: {
      then?: (trx: Kysely<Database>) => Promise<void>;
      publishedAt?: Date;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<VersionSummary> {
    const { then, publishedAt, metadata } = options;
    await this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable('question_template_versions')
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
          targetType: 'question_template_version',
          targetId: row.id,
          metadata: {
            templateId: row.template_id,
            versionNo: row.version_no,
            contentHash: row.content_hash,
            ...metadata,
          },
        },
        trx,
      );
    });
    return summary(await this.find(row.id));
  }

  private async find(versionId: string): Promise<Row> {
    const row = await this.db
      .selectFrom('question_template_versions')
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

  private async assertTemplate(templateId: string): Promise<void> {
    const t = await this.db
      .selectFrom('question_templates')
      .select('id')
      .where('id', '=', templateId)
      .executeTakeFirst();
    if (!t) throw new ProblemException(404, 'QUESTION_NOT_FOUND', 'This question does not exist.');
  }
}

function columns(input: QuestionTemplateInput) {
  const content = {
    type: input.type,
    difficulty: input.difficulty,
    skills: input.skills,
    body: input.body,
  };
  return {
    type: input.type,
    difficulty: input.difficulty,
    skills: input.skills,
    body: JSON.stringify(input.body),
    content_hash: contentHash(content),
  };
}

function summary(row: Row): VersionSummary {
  return {
    id: row.id,
    versionNo: row.version_no,
    status: row.status,
    authorId: row.author_id,
    updatedAt: row.updated_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

function etagOf(row: Row): string {
  return `"${row.content_hash.slice(0, 16)}-${row.updated_at.getTime()}"`;
}
