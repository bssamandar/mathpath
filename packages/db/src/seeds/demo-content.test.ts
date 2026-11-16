import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../schema';
import { createTestDb } from '../testing';
import { DEMO_IDS, seedDemoContent } from './demo-content';

let db: Kysely<Database>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

describe('seedDemoContent', () => {
  it('publishes three grade 5 fraction topics, the first one free', async () => {
    expect(await seedDemoContent(db)).toBe(3);
    const topics = await db
      .selectFrom('topics as t')
      .innerJoin('topic_versions as v', 'v.id', 't.published_version_id')
      .select(['t.slug', 't.is_free', 'v.status', 'v.title'])
      .orderBy('t.sort')
      .execute();
    expect(topics.map((t) => [t.slug, t.is_free, t.status])).toEqual([
      ['what-is-a-fraction', true, 'published'],
      ['comparing-fractions', false, 'published'],
      ['adding-like-fractions', false, 'published'],
    ]);
    // Every topic has Uzbek and Russian text (config/content.yaml).
    for (const topic of topics) expect(Object.keys(topic.title).sort()).toEqual(['ru', 'uz-Latn']);
  });

  it('is idempotent', async () => {
    await seedDemoContent(db);
    expect(await seedDemoContent(db)).toBe(0);
    const count = await db
      .selectFrom('topics')
      .select(db.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(3);
    const author = await db
      .selectFrom('users')
      .select('phone_e164')
      .where('id', '=', DEMO_IDS.author)
      .executeTakeFirstOrThrow();
    expect(author.phone_e164).toBeNull();
  });
});
