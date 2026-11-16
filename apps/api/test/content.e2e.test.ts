import { DEMO_IDS, newId, type Role, seedDemoContent } from '@mathpath/db';
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

/** A user with the given roles and a bearer token; staff sessions have passed 2FA. */
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

/** A published track and course with one chapter and two topics (one free). */
async function catalogue() {
  const [track, course, chapter, free, paid] = [newId(), newId(), newId(), newId(), newId()];
  await t.db
    .insertInto('tracks')
    .values({ id: track, slug: 'school', title: { 'uz-Latn': 'Maktab', ru: 'Школа' } })
    .execute();
  await t.db
    .insertInto('courses')
    .values({
      id: course,
      track_id: track,
      slug: 'grade-5',
      grade: 5,
      title: { 'uz-Latn': '5-sinf', ru: '5 класс' },
      status: 'published',
    })
    .execute();
  await t.db
    .insertInto('chapters')
    .values({
      id: chapter,
      course_id: course,
      slug: 'fractions',
      title: { 'uz-Latn': 'Kasrlar', ru: 'Дроби' },
      status: 'published',
    })
    .execute();
  await t.db
    .insertInto('topics')
    .values([
      { id: free, chapter_id: chapter, slug: 'what-is-a-fraction', sort: 1, is_free: true },
      { id: paid, chapter_id: chapter, slug: 'adding-fractions', sort: 2 },
    ])
    .execute();
  return { track, course, chapter, free, paid };
}

const lesson = {
  title: { 'uz-Latn': 'Kasr nima?', ru: 'Что такое дробь?' },
  summary: {},
  steps: [
    {
      type: 'activity',
      activity: 'fraction_model',
      config: { parts: 4 },
      prompt: { 'uz-Latn': 'Uchdan birini bo‘yang', ru: 'Закрасьте одну треть' },
    },
    { type: 'practice', minCorrect: 5 },
    { type: 'mastery_test' },
  ],
};

/** Runs a topic through draft → review → publish and returns the version ID. */
async function publish(topicId: string, author: { auth: string }, reviewer: { auth: string }) {
  const draft = await http()
    .post(`/api/v1/studio/topics/${topicId}/versions`)
    .set('Authorization', author.auth)
    .expect(201);
  const saved = await http()
    .put(`/api/v1/studio/topic-versions/${draft.body.id}`)
    .set('Authorization', author.auth)
    .set('If-Match', draft.headers.etag as string)
    .send(lesson)
    .expect(200);
  expect(saved.body.status).toBe('draft');
  await http()
    .post(`/api/v1/studio/versions/${draft.body.id}/submit`)
    .set('Authorization', author.auth)
    .expect(200);
  await http()
    .post(`/api/v1/studio/versions/${draft.body.id}/review`)
    .set('Authorization', reviewer.auth)
    .send({ decision: 'approved' })
    .expect(200);
  const published = await http()
    .post(`/api/v1/studio/versions/${draft.body.id}/publish`)
    .set('Authorization', reviewer.auth)
    .expect(200);
  expect(published.body).toMatchObject({ status: 'published', versionNo: 1 });
  expect(published.body.publishedAt).not.toBeNull();
  return draft.body.id as string;
}

describe('studio workflow (C-18)', () => {
  it('takes a lesson from draft to published and audits each step', async () => {
    const { free } = await catalogue();
    const author = await userWith(['author']);
    const reviewer = await userWith(['reviewer']);
    await publish(free, author, reviewer);

    const actions = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'like', 'content.%')
      .orderBy('created_at')
      .execute();
    expect(actions.map((a) => a.action)).toEqual([
      'content.draft_create',
      'content.draft_save',
      'content.submit',
      'content.review_approved',
      'content.publish',
    ]);
    expect(await verifyAuditChain(t.db)).toMatchObject({ ok: true });
  });

  it('does not let a reviewer review their own version', async () => {
    const { free } = await catalogue();
    const reviewer = await userWith(['reviewer']);
    const draft = await http()
      .post(`/api/v1/studio/topics/${free}/versions`)
      .set('Authorization', reviewer.auth)
      .expect(201);
    await http()
      .put(`/api/v1/studio/topic-versions/${draft.body.id}`)
      .set('Authorization', reviewer.auth)
      .set('If-Match', draft.headers.etag as string)
      .send(lesson)
      .expect(200);
    await http()
      .post(`/api/v1/studio/versions/${draft.body.id}/submit`)
      .set('Authorization', reviewer.auth)
      .expect(200);
    const res = await http()
      .post(`/api/v1/studio/versions/${draft.body.id}/review`)
      .set('Authorization', reviewer.auth)
      .send({ decision: 'approved' })
      .expect(403);
    expect(res.body.code).toBe('FOUR_EYES');
  });

  it('refuses a stale save (lost update) with 412', async () => {
    const { free } = await catalogue();
    const author = await userWith(['author']);
    const draft = await http()
      .post(`/api/v1/studio/topics/${free}/versions`)
      .set('Authorization', author.auth)
      .expect(201);
    const etag = draft.headers.etag as string;
    await http()
      .put(`/api/v1/studio/topic-versions/${draft.body.id}`)
      .set('Authorization', author.auth)
      .set('If-Match', etag)
      .send(lesson)
      .expect(200);
    const stale = await http()
      .put(`/api/v1/studio/topic-versions/${draft.body.id}`)
      .set('Authorization', author.auth)
      .set('If-Match', etag)
      .send({ ...lesson, title: { 'uz-Latn': 'Boshqa' } })
      .expect(412);
    expect(stale.body.code).toBe('VERSION_CHANGED');
  });

  it('will not send an incomplete lesson to review', async () => {
    const { free } = await catalogue();
    const author = await userWith(['author']);
    const draft = await http()
      .post(`/api/v1/studio/topics/${free}/versions`)
      .set('Authorization', author.auth)
      .expect(201);
    await http()
      .put(`/api/v1/studio/topic-versions/${draft.body.id}`)
      .set('Authorization', author.auth)
      .set('If-Match', draft.headers.etag as string)
      .send({ ...lesson, title: { 'uz-Latn': 'Kasr nima?' } })
      .expect(200);
    const res = await http()
      .post(`/api/v1/studio/versions/${draft.body.id}/submit`)
      .set('Authorization', author.auth)
      .expect(422);
    expect(res.body.code).toBe('CONTENT_INCOMPLETE');
    expect(res.body.errors).toContainEqual({ field: 'title', message: 'missing ru text' });
  });

  it('rejects malformed steps when saving', async () => {
    const { free } = await catalogue();
    const author = await userWith(['author']);
    const draft = await http()
      .post(`/api/v1/studio/topics/${free}/versions`)
      .set('Authorization', author.auth)
      .expect(201);
    await http()
      .put(`/api/v1/studio/topic-versions/${draft.body.id}`)
      .set('Authorization', author.auth)
      .set('If-Match', draft.headers.etag as string)
      .send({ ...lesson, steps: [{ type: 'activity', activity: 'run_script', config: {} }] })
      .expect(400);
  });

  it('allows one open draft per topic and copies the latest version into the next', async () => {
    const { free } = await catalogue();
    const author = await userWith(['author']);
    const reviewer = await userWith(['reviewer']);
    const first = await publish(free, author, reviewer);
    const second = await http()
      .post(`/api/v1/studio/topics/${free}/versions`)
      .set('Authorization', author.auth)
      .expect(201);
    expect(second.body).toMatchObject({ versionNo: 2, status: 'draft', title: lesson.title });
    const again = await http()
      .post(`/api/v1/studio/topics/${free}/versions`)
      .set('Authorization', author.auth)
      .expect(409);
    expect(again.body.code).toBe('DRAFT_EXISTS');

    // Publishing version 2 archives version 1, which stays unchanged.
    await http()
      .put(`/api/v1/studio/topic-versions/${second.body.id}`)
      .set('Authorization', author.auth)
      .set('If-Match', second.headers.etag as string)
      .send({
        ...lesson,
        title: { 'uz-Latn': 'Kasrlar bilan tanishuv', ru: 'Знакомство с дробями' },
      })
      .expect(200);
    for (const [path, auth, body] of [
      ['submit', author.auth, undefined],
      ['review', reviewer.auth, { decision: 'approved' }],
      ['publish', reviewer.auth, undefined],
    ] as const) {
      await http()
        .post(`/api/v1/studio/versions/${second.body.id}/${path}`)
        .set('Authorization', auth)
        .send(body)
        .expect(200);
    }
    const history = await http()
      .get(`/api/v1/studio/topics/${free}/versions`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(history.body.items.map((v: { status: string }) => v.status)).toEqual([
      'published',
      'archived',
    ]);
    const old = await http()
      .get(`/api/v1/studio/topic-versions/${first}`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(old.body.title).toEqual(lesson.title);
  });

  it('returns changes to the author with comments', async () => {
    const { free } = await catalogue();
    const author = await userWith(['author']);
    const reviewer = await userWith(['reviewer']);
    const draft = await http()
      .post(`/api/v1/studio/topics/${free}/versions`)
      .set('Authorization', author.auth)
      .expect(201);
    await http()
      .put(`/api/v1/studio/topic-versions/${draft.body.id}`)
      .set('Authorization', author.auth)
      .set('If-Match', draft.headers.etag as string)
      .send(lesson)
      .expect(200);
    await http()
      .post(`/api/v1/studio/versions/${draft.body.id}/submit`)
      .set('Authorization', author.auth)
      .expect(200);
    await http()
      .post(`/api/v1/studio/versions/${draft.body.id}/review`)
      .set('Authorization', reviewer.auth)
      .send({
        decision: 'changes_requested',
        comments: [{ anchor: '/steps/0/prompt', text: 'Rasm qo‘shing' }],
      })
      .expect(200);
    const version = await http()
      .get(`/api/v1/studio/topic-versions/${draft.body.id}`)
      .set('Authorization', author.auth)
      .expect(200);
    expect(version.body.status).toBe('changes_requested');
    expect(version.body.reviews[0]).toMatchObject({
      decision: 'changes_requested',
      comments: [{ anchor: '/steps/0/prompt', text: 'Rasm qo‘shing' }],
    });
    // A published-only action is refused in the wrong state.
    const res = await http()
      .post(`/api/v1/studio/versions/${draft.body.id}/publish`)
      .set('Authorization', reviewer.auth)
      .expect(409);
    expect(res.body.code).toBe('VERSION_STATE_CONFLICT');
  });

  it('keeps the studio closed to parents and to staff without 2FA', async () => {
    const { free } = await catalogue();
    const parent = await userWith(['parent']);
    await http()
      .post(`/api/v1/studio/topics/${free}/versions`)
      .set('Authorization', parent.auth)
      .expect(403);
    const id = newId();
    await t.db.insertInto('users').values({ id, first_name: 'Malika' }).execute();
    await t.db.insertInto('user_roles').values({ user_id: id, role: 'author' }).execute();
    const pending = await t.app.get(SessionService).start(id, client, 'password');
    const res = await http()
      .post(`/api/v1/studio/topics/${free}/versions`)
      .set('Authorization', `Bearer ${pending.accessToken}`)
      .expect(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
  });
});

describe('catalogue', () => {
  it('lists tracks and courses in the reader’s language', async () => {
    await catalogue();
    const uz = await http().get('/api/v1/tracks').expect(200);
    expect(uz.body.items[0]).toMatchObject({ slug: 'school', title: 'Maktab' });
    expect(uz.body.items[0].courses[0]).toMatchObject({ title: '5-sinf', grade: 5 });
    const ru = await http()
      .get('/api/v1/tracks')
      .set('Accept-Language', 'ru-RU,ru;q=0.9')
      .expect(200);
    expect(ru.body.items[0].title).toBe('Школа');
    const en = await http().get('/api/v1/tracks?locale=en').expect(200);
    // No English text yet: falls back to the default language, never empty.
    expect(en.body.items[0].title).toBe('Maktab');
  });

  it('shows only published topics in the course tree, with locks', async () => {
    const { course, free, paid } = await catalogue();
    const author = await userWith(['author']);
    const reviewer = await userWith(['reviewer']);
    await publish(free, author, reviewer);
    await publish(paid, author, reviewer);
    // A third topic with no published version stays hidden.
    const chapter = await t.db.selectFrom('chapters').select('id').executeTakeFirstOrThrow();
    await t.db
      .insertInto('topics')
      .values({ id: newId(), chapter_id: chapter.id, slug: 'draft-only' })
      .execute();

    const tree = await http().get(`/api/v1/courses/${course}?locale=ru`).expect(200);
    expect(tree.body.title).toBe('5 класс');
    expect(tree.body.chapters[0].topics).toEqual([
      { id: free, title: 'Что такое дробь?', isFree: true, locked: false },
      { id: paid, title: 'Что такое дробь?', isFree: false, locked: true },
    ]);
  });

  it('serves the lesson of a free topic and asks for a plan for a paid one', async () => {
    const { free, paid } = await catalogue();
    const author = await userWith(['author']);
    const reviewer = await userWith(['reviewer']);
    const versionId = await publish(free, author, reviewer);
    await publish(paid, author, reviewer);
    const student = await userWith(['student']);

    const res = await http()
      .get(`/api/v1/topics/${free}/lesson`)
      .set('Authorization', student.auth)
      .set('Accept-Language', 'uz')
      .expect(200);
    expect(res.body).toEqual({
      topicId: free,
      versionId,
      title: 'Kasr nima?',
      steps: [
        {
          index: 0,
          type: 'activity',
          completed: false,
          activity: 'fraction_model',
          config: { parts: 4 },
          prompt: 'Uchdan birini bo‘yang',
        },
        { index: 1, type: 'practice', completed: false, prompt: '' },
        { index: 2, type: 'mastery_test', completed: false },
      ],
    });

    const locked = await http()
      .get(`/api/v1/topics/${paid}/lesson`)
      .set('Authorization', student.auth)
      .expect(402);
    expect(locked.body.code).toBe('PAYMENT_REQUIRED');
    await http().get(`/api/v1/topics/${free}/lesson`).expect(401);
  });

  it('answers 404 for unknown and unpublished content', async () => {
    const { free } = await catalogue();
    const student = await userWith(['student']);
    await http()
      .get(`/api/v1/topics/${free}/lesson`)
      .set('Authorization', student.auth)
      .expect(404);
    await http().get(`/api/v1/courses/${newId()}`).expect(404);
    await http().get('/api/v1/courses/not-a-uuid').expect(400);
  });

  it('serves the seeded demo lessons, which pass the same step validation', async () => {
    await seedDemoContent(t.db);
    const student = await userWith(['student']);
    const res = await http()
      .get(`/api/v1/topics/${DEMO_IDS.topics[0]}/lesson?locale=ru`)
      .set('Authorization', student.auth)
      .expect(200);
    expect(res.body.title).toBe('Что такое дробь?');
    expect(res.body.steps).toHaveLength(4);
    const tree = await http().get(`/api/v1/courses/${DEMO_IDS.course}`).expect(200);
    expect(tree.body.chapters[0].topics.map((t: { locked: boolean }) => t.locked)).toEqual([
      false,
      true,
      true,
    ]);
  });
});
