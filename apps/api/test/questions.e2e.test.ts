import { DEMO_IDS, newId, type Role, seedDemoContent } from '@mathpath/db';
import { validateTemplate } from '@mathpath/questions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/audit/audit.service';
import { SessionService } from '../src/identity/session.service';
import { browser, createTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const http = () => browser(t.app.getHttpServer());
const client = {
  ipPrefix: null,
  userAgentSummary: null,
  requestId: null,
  automationSuspected: false,
};

async function userWith(roles: Role[]): Promise<{ id: string; auth: string }> {
  const id = newId();
  await t.db.insertInto('users').values({ id, first_name: 'Malika' }).execute();
  await t.db
    .insertInto('user_roles')
    .values(roles.map((role) => ({ user_id: id, role })))
    .execute();
  const sessions = t.app.get(SessionService);
  const started = await sessions.start(id, client, 'password');
  const session = roles.some((r) => r !== 'student' && r !== 'parent')
    ? await sessions.elevate(started.sessionId)
    : started;
  return { id, auth: `Bearer ${session.accessToken}` };
}

async function topic() {
  const [track, course, chapter, id] = [newId(), newId(), newId(), newId()];
  await t.db
    .insertInto('tracks')
    .values({ id: track, slug: 'school', title: { 'uz-Latn': 'Maktab' } })
    .execute();
  await t.db
    .insertInto('courses')
    .values({
      id: course,
      track_id: track,
      slug: 'grade-5',
      grade: 5,
      title: { 'uz-Latn': '5-sinf' },
    })
    .execute();
  await t.db
    .insertInto('chapters')
    .values({ id: chapter, course_id: course, slug: 'fractions', title: { 'uz-Latn': 'Kasrlar' } })
    .execute();
  await t.db.insertInto('topics').values({ id, chapter_id: chapter, slug: 'adding' }).execute();
  return id;
}

const question = {
  type: 'numeric',
  difficulty: 2,
  skills: ['fraction_addition'],
  externalRef: 'ADD-1',
  body: {
    variables: { d: { int: [2, 9] }, a: { int: [1, 'd-1'] }, b: { int: [1, 'd-1'] } },
    constraints: ['a + b != d'],
    stem: {
      'uz-Latn': 'Hisoblang: $\\frac{{a}}{{d}} + \\frac{{b}}{{d}}$',
      ru: 'Вычислите: $\\frac{{a}}{{d}} + \\frac{{b}}{{d}}$',
    },
    answer: { kind: 'fraction', expr: '(a+b)/d', accept: ['equivalent', 'mixed_number'] },
  },
};

describe('question authoring', () => {
  it('runs a template through draft, review and publish', async () => {
    const topicId = await topic();
    const author = await userWith(['author']);
    const reviewer = await userWith(['reviewer']);

    const created = await http()
      .post(`/api/v1/studio/topics/${topicId}/question-templates`)
      .set('Authorization', author.auth)
      .send(question)
      .expect(201);
    expect(created.body).toMatchObject({
      versionNo: 1,
      status: 'draft',
      type: 'numeric',
      externalRef: 'ADD-1',
    });
    expect(created.headers.etag).toBe(created.body.etag);

    const list = await http()
      .get(`/api/v1/studio/topics/${topicId}/question-templates`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        id: created.body.templateId,
        latest: expect.objectContaining({ difficulty: 2 }),
      }),
    ]);

    // Saving needs the current ETag.
    await http()
      .put(`/api/v1/studio/question-template-versions/${created.body.id}`)
      .set('Authorization', author.auth)
      .set('If-Match', '"stale"')
      .send(question)
      .expect(412);
    const saved = await http()
      .put(`/api/v1/studio/question-template-versions/${created.body.id}`)
      .set('Authorization', author.auth)
      .set('If-Match', created.body.etag)
      .send({ ...question, difficulty: 3 })
      .expect(200);
    expect(saved.body.difficulty).toBe(3);

    await http()
      .post(`/api/v1/studio/versions/${created.body.id}/submit`)
      .set('Authorization', author.auth)
      .expect(200);
    // Four eyes applies to questions too.
    const own = await http()
      .post(`/api/v1/studio/versions/${created.body.id}/review`)
      .set('Authorization', (await userWith(['reviewer'])).auth)
      .send({ decision: 'approved' })
      .expect(200);
    expect(own.body.status).toBe('approved');
    const published = await http()
      .post(`/api/v1/studio/versions/${created.body.id}/publish`)
      .set('Authorization', reviewer.auth)
      .expect(200);
    expect(published.body.status).toBe('published');

    // A second version archives the first on publish.
    const next = await http()
      .post(`/api/v1/studio/question-templates/${created.body.templateId}/versions`)
      .set('Authorization', author.auth)
      .expect(201);
    expect(next.body).toMatchObject({ versionNo: 2, difficulty: 3 });
    await http()
      .post(`/api/v1/studio/question-templates/${created.body.templateId}/versions`)
      .set('Authorization', author.auth)
      .expect(409);
    await http()
      .post(`/api/v1/studio/versions/${next.body.id}/submit`)
      .set('Authorization', author.auth)
      .expect(200);
    await http()
      .post(`/api/v1/studio/versions/${next.body.id}/review`)
      .set('Authorization', reviewer.auth)
      .send({
        decision: 'changes_requested',
        comments: [{ anchor: '/body/stem', text: 'Ruschasini tekshiring' }],
      })
      .expect(200);
    const back = await http()
      .get(`/api/v1/studio/question-template-versions/${next.body.id}`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(back.body.reviews[0]).toMatchObject({ decision: 'changes_requested' });

    const versions = await http()
      .get(`/api/v1/studio/question-templates/${created.body.templateId}/versions`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(versions.body.items.map((v: { status: string }) => v.status)).toEqual([
      'changes_requested',
      'published',
    ]);

    const audit = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('target_type', '=', 'question_template_version')
      .execute();
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'content.question_create',
        'content.submit',
        'content.publish',
        'content.review_changes_requested',
      ]),
    );
    expect((await verifyAuditChain(t.db)).ok).toBe(true);
  });

  it('refuses review of a template that does not generate items or lacks a locale', async () => {
    const topicId = await topic();
    const author = await userWith(['author']);
    const broken = await http()
      .post(`/api/v1/studio/topics/${topicId}/question-templates`)
      .set('Authorization', author.auth)
      .send({ ...question, body: { ...question.body, constraints: ['a > 100'] } })
      .expect(201);
    const refused = await http()
      .post(`/api/v1/studio/versions/${broken.body.id}/submit`)
      .set('Authorization', author.auth)
      .expect(422);
    expect(refused.body).toMatchObject({
      code: 'CONTENT_INCOMPLETE',
      errors: [{ field: 'constraints' }],
    });

    const noRussian = await http()
      .post(`/api/v1/studio/topics/${topicId}/question-templates`)
      .set('Authorization', author.auth)
      .send({ ...question, body: { ...question.body, stem: { 'uz-Latn': 'Hisoblang {a}' } } })
      .expect(201);
    const missing = await http()
      .post(`/api/v1/studio/versions/${noRussian.body.id}/submit`)
      .set('Authorization', author.auth)
      .expect(422);
    expect(missing.body.errors).toEqual([{ field: 'body/stem', message: 'missing ru text' }]);
  });

  it('validates the body shape on save', async () => {
    const topicId = await topic();
    const author = await userWith(['author']);
    const res = await http()
      .post(`/api/v1/studio/topics/${topicId}/question-templates`)
      .set('Authorization', author.auth)
      .send({ ...question, type: 'essay', body: { stem: {}, answer: { kind: 'magic' } } })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    await http()
      .post(`/api/v1/studio/topics/${newId()}/question-templates`)
      .set('Authorization', author.auth)
      .send(question)
      .expect(404);
    await http()
      .get(`/api/v1/studio/question-templates/${newId()}/versions`)
      .set('Authorization', author.auth)
      .expect(404);
  });

  it('previews samples with answers, and reports problems as warnings', async () => {
    const author = await userWith(['author']);
    const ok = await http()
      .post('/api/v1/studio/question-templates/preview')
      .set('Authorization', author.auth)
      .send({ type: 'numeric', body: question.body, samples: 3 })
      .expect(200);
    expect(ok.body.samples).toHaveLength(3);
    expect(ok.body.samples[0]).toMatchObject({
      instance: { input: 'fraction' },
      answer: { kind: 'fraction' },
    });
    expect(ok.body.warnings).toEqual([]);

    const bad = await http()
      .post('/api/v1/studio/question-templates/preview')
      .set('Authorization', author.auth)
      .send({
        type: 'numeric',
        body: { ...question.body, answer: { kind: 'fraction', expr: 'zz' } },
      })
      .expect(200);
    expect(bad.body).toEqual({
      samples: [],
      warnings: [expect.objectContaining({ field: 'answer/expr' })],
    });

    const shape = await http()
      .post('/api/v1/studio/question-templates/preview')
      .set('Authorization', author.auth)
      .send({ type: 'numeric', body: { stem: 1 } })
      .expect(200);
    expect(shape.body.samples).toEqual([]);
    expect(shape.body.warnings.length).toBeGreaterThan(0);

    const partial = await http()
      .post('/api/v1/studio/question-templates/preview')
      .set('Authorization', author.auth)
      .send({ type: 'numeric', body: { ...question.body, stem: { 'uz-Latn': '{a}' } } })
      .expect(200);
    expect(partial.body.warnings).toEqual([{ field: 'body/stem', message: 'missing ru text' }]);
  });

  it('keeps question bodies away from learners', async () => {
    const student = await userWith(['student']);
    await http()
      .get(`/api/v1/studio/question-template-versions/${newId()}`)
      .set('Authorization', student.auth)
      .expect(403);
    await http()
      .post('/api/v1/studio/question-templates/preview')
      .set('Authorization', student.auth)
      .send({ type: 'numeric', body: question.body })
      .expect(403);
  });

  it('seeds demo questions that all pass the engine', async () => {
    await seedDemoContent(t.db);
    const rows = await t.db
      .selectFrom('question_template_versions as v')
      .innerJoin('question_templates as q', 'q.id', 'v.template_id')
      .select(['v.type', 'v.body', 'v.status', 'q.topic_id', 'q.published_version_id', 'v.id'])
      .execute();
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      expect(
        validateTemplate(row.type as 'numeric', row.body).problems,
        JSON.stringify(row.body),
      ).toEqual([]);
      expect(row.status).toBe('published');
      expect(row.published_version_id).toBe(row.id);
    }
    expect(new Set(rows.map((r) => r.topic_id))).toEqual(new Set(DEMO_IDS.topics));
  });
});
