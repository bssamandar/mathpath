import { type Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from './ids';
import { migrateDown, migrateToLatest, migrateToNothing, migrations } from './migrator';
import type { Database, TableName } from './schema';
import { createTestDb } from './testing';

let db: Kysely<Database>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

async function tableNames(): Promise<string[]> {
  const result = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely_%'
  `.execute(db);
  return result.rows.map((r) => r.table_name).sort();
}

const expectedTables: TableName[] = [
  'audit_log',
  'blocked_prefixes',
  'chapters',
  'consents',
  'content_reviews',
  'courses',
  'devices',
  'family_codes',
  'idempotency_keys',
  'mfa_factors',
  'mfa_recovery_codes',
  'otp_challenges',
  'outbox_events',
  'parent_child_links',
  'processed_events',
  'refresh_tokens',
  'risk_events',
  'risk_reviews',
  'sessions',
  'student_profiles',
  'topic_mappings',
  'topic_prerequisites',
  'topic_versions',
  'topics',
  'tracks',
  'user_roles',
  'users',
];

async function insertUser(
  overrides: Partial<{ phone_e164: string | null; deleted_at: Date }> = {},
) {
  const id = newId();
  await db
    .insertInto('users')
    .values({ id, first_name: 'Dilnoza', phone_e164: '+998901234567', ...overrides })
    .execute();
  return id;
}

describe('migrations', () => {
  it('creates every table declared in schema.ts (no drift)', async () => {
    expect(await tableNames()).toEqual([...expectedTables].sort());
  });

  it('runs up → down → up cleanly (rollback works)', async () => {
    const down = await migrateToNothing(db as Kysely<unknown>);
    expect(down).toHaveLength(Object.keys(migrations).length);
    expect(await tableNames()).toEqual([]);

    const up = await migrateToLatest(db as Kysely<unknown>);
    expect(up).toEqual(Object.keys(migrations).map((name) => `Up ${name}`));
    expect(await tableNames()).toHaveLength(expectedTables.length);
  });

  it('migrateDown reverts only the latest migration', async () => {
    const names = Object.keys(migrations);
    const reverted = await migrateDown(db as Kysely<unknown>);
    expect(reverted).toEqual([`Down ${names[names.length - 1]}`]);
  });
});

describe('identity constraints', () => {
  it('allows only one live account per phone number', async () => {
    await insertUser();
    await expect(insertUser()).rejects.toThrow(/users_phone_live_uq/);
  });

  it('frees a phone number once the old account is deleted', async () => {
    await insertUser({ deleted_at: new Date() });
    await expect(insertUser()).resolves.toBeTypeOf('string');
  });

  it('rejects phone numbers that are not E.164', async () => {
    await expect(insertUser({ phone_e164: '901234567' })).rejects.toThrow(/check/i);
  });

  it('stores the terms version and acceptance time together or not at all', async () => {
    const id = await insertUser();
    await expect(
      db.updateTable('users').set({ terms_version: '2026-11' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/users_terms_pair_ck/);
    await db
      .updateTable('users')
      .set({ terms_version: '2026-11', terms_accepted_at: new Date() })
      .where('id', '=', id)
      .execute();
  });

  it('lets children exist without a phone number (data minimisation)', async () => {
    await expect(insertUser({ phone_e164: null })).resolves.toBeTypeOf('string');
  });

  it('keeps updated_at current on update', async () => {
    const id = await insertUser();
    const before = await db
      .selectFrom('users')
      .select('updated_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await db.updateTable('users').set({ first_name: 'Aziza' }).where('id', '=', id).execute();
    const after = await db
      .selectFrom('users')
      .select('updated_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('rejects nicknames with characters outside the allow-list (XSS defence, C-13)', async () => {
    const id = await insertUser({ phone_e164: null });
    await expect(
      db
        .insertInto('student_profiles')
        .values({ user_id: id, nickname: '<script>', grade: 5, pin_hash: 'x' })
        .execute(),
    ).rejects.toThrow(/check/i);
  });

  it('refuses to link a user as their own parent', async () => {
    const id = await insertUser();
    const consentId = newId();
    await db
      .insertInto('consents')
      .values({
        id: consentId,
        parent_id: id,
        child_id: id,
        policy_version: 'v1',
        scopes: ['learning'],
        method: 'otp_confirmed',
      })
      .execute();
    await expect(
      db
        .insertInto('parent_child_links')
        .values({ parent_id: id, child_id: id, consent_id: consentId })
        .execute(),
    ).rejects.toThrow(/check/i);
  });
});

describe('audit_log', () => {
  it('is append-only: updates and deletes are refused (C-33)', async () => {
    const id = newId();
    await db
      .insertInto('audit_log')
      .values({ id, action: 'user.login', hash: Buffer.from('h') })
      .execute();
    await expect(
      db.updateTable('audit_log').set({ action: 'tampered' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('audit_log').where('id', '=', id).execute()).rejects.toThrow(
      /append-only/,
    );
  });
});

/** A track, course, chapter and topic, returning the topic ID. */
async function insertTopic(): Promise<string> {
  const [track, course, chapter, topic] = [newId(), newId(), newId(), newId()];
  await db
    .insertInto('tracks')
    .values({ id: track, slug: 'school', title: { en: 'School' } })
    .execute();
  await db
    .insertInto('courses')
    .values({ id: course, track_id: track, slug: 'grade-5', grade: 5, title: { en: 'Grade 5' } })
    .execute();
  await db
    .insertInto('chapters')
    .values({ id: chapter, course_id: course, slug: 'fractions', title: { en: 'Fractions' } })
    .execute();
  await db
    .insertInto('topics')
    .values({ id: topic, chapter_id: chapter, slug: 'adding-fractions' })
    .execute();
  return topic;
}

async function insertVersion(topicId: string, versionNo: number, authorId: string) {
  const id = newId();
  await db
    .insertInto('topic_versions')
    .values({
      id,
      topic_id: topicId,
      version_no: versionNo,
      title: { en: 'Adding fractions' },
      author_id: authorId,
      content_hash: 'h',
    })
    .execute();
  return id;
}

describe('content constraints', () => {
  it('freezes a published topic version except for archiving it', async () => {
    const topic = await insertTopic();
    const author = await insertUser();
    const id = await insertVersion(topic, 1, author);
    await db
      .updateTable('topic_versions')
      .set({ status: 'published', published_at: new Date() })
      .where('id', '=', id)
      .execute();
    await expect(
      db
        .updateTable('topic_versions')
        .set({ steps: '[]', title: { en: 'Changed' } })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/immutable/);
    await expect(db.deleteFrom('topic_versions').where('id', '=', id).execute()).rejects.toThrow(
      /cannot be deleted/,
    );
    await db
      .updateTable('topic_versions')
      .set({ status: 'archived' })
      .where('id', '=', id)
      .execute();
    await expect(
      db.updateTable('topic_versions').set({ status: 'published' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/immutable/);
  });

  it('allows only one open draft per topic', async () => {
    const topic = await insertTopic();
    const author = await insertUser();
    await insertVersion(topic, 1, author);
    await expect(insertVersion(topic, 2, author)).rejects.toThrow(/one_open_draft/);
  });

  it('refuses a topic as its own prerequisite', async () => {
    const topic = await insertTopic();
    await expect(
      db
        .insertInto('topic_prerequisites')
        .values({ topic_id: topic, prerequisite_id: topic })
        .execute(),
    ).rejects.toThrow(/check/i);
  });

  it('accepts only localised objects for titles', async () => {
    await expect(
      db.insertInto('tracks').values({ id: newId(), slug: 'school', title: '"plain"' }).execute(),
    ).rejects.toThrow(/check/i);
  });
});

describe('newId', () => {
  it('returns time-ordered UUIDv7 values', () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
