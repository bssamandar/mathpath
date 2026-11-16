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
  'media_assets',
  'media_keys',
  'mfa_factors',
  'mfa_recovery_codes',
  'otp_challenges',
  'outbox_events',
  'parent_child_links',
  'processed_events',
  'question_template_versions',
  'assessments',
  'attempts',
  'attempt_items',
  'daily_usage',
  'topic_progress',
  'learning_detours',
  'learning_events',
  'orders',
  'payments',
  'payment_callbacks',
  'promo_codes',
  'promo_redemptions',
  'trials',
  'subscriptions',
  'subscription_members',
  'question_templates',
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

describe('question templates', () => {
  async function insertTemplate() {
    const topic = await insertTopic();
    const author = await insertUser();
    const template = newId();
    await db
      .insertInto('question_templates')
      .values({ id: template, topic_id: topic, created_by: author })
      .execute();
    const insert = (versionNo: number) => {
      const id = newId();
      return db
        .insertInto('question_template_versions')
        .values({
          id,
          template_id: template,
          version_no: versionNo,
          type: 'numeric',
          difficulty: 2,
          body: { stem: {} },
          author_id: author,
          content_hash: 'h',
        })
        .execute()
        .then(() => id);
    };
    return { insert };
  }

  it('freezes a published version and allows one open draft', async () => {
    const { insert } = await insertTemplate();
    const id = await insert(1);
    await expect(insert(2)).rejects.toThrow(/one_open_draft/);
    await db
      .updateTable('question_template_versions')
      .set({ status: 'published', published_at: new Date() })
      .where('id', '=', id)
      .execute();
    await expect(
      db
        .updateTable('question_template_versions')
        .set({ difficulty: 5 })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.deleteFrom('question_template_versions').where('id', '=', id).execute(),
    ).rejects.toThrow(/cannot be deleted/);
    await db
      .updateTable('question_template_versions')
      .set({ status: 'archived' })
      .where('id', '=', id)
      .execute();
    await expect(
      db
        .updateTable('question_template_versions')
        .set({ status: 'published' })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/immutable/);
  });

  it('checks type, difficulty and the body shape', async () => {
    const { insert } = await insertTemplate();
    const id = await insert(1);
    for (const bad of [{ type: 'essay' }, { difficulty: 6 }, { body: '[]' }]) {
      await expect(
        db
          .updateTable('question_template_versions')
          .set(bad as never)
          .where('id', '=', id)
          .execute(),
      ).rejects.toThrow(/check/i);
    }
  });
});

describe('assessment constraints', () => {
  async function start(userId: string) {
    const assessment = newId();
    await db
      .insertInto('assessments')
      .values({ id: assessment, type: 'practice', scope_type: 'topic', scope_id: newId() })
      .execute();
    const open = () =>
      db
        .insertInto('attempts')
        .values({ id: newId(), user_id: userId, assessment_id: assessment, topic_id: null })
        .execute();
    return { assessment, open };
  }

  it('allows one open attempt per learner and assessment', async () => {
    const user = await insertUser();
    const { open } = await start(user);
    await open();
    await expect(open()).rejects.toThrow(/attempts_one_open/);
  });

  it('ties submitted_at to the submitted status', async () => {
    const user = await insertUser();
    const { assessment } = await start(user);
    await expect(
      db
        .insertInto('attempts')
        .values({
          id: newId(),
          user_id: user,
          assessment_id: assessment,
          topic_id: null,
          status: 'submitted',
        })
        .execute(),
    ).rejects.toThrow(/check/i);
  });

  it('rejects an unknown assessment type', async () => {
    await expect(
      db
        .insertInto('assessments')
        .values({
          id: newId(),
          type: 'quiz' as 'practice',
          scope_type: 'topic',
          scope_id: newId(),
        })
        .execute(),
    ).rejects.toThrow(/check/i);
  });
});

describe('knowledge graph', () => {
  it('refuses a prerequisite edge that closes a cycle', async () => {
    const a = await insertTopic();
    const { chapter_id } = await db
      .selectFrom('topics')
      .select('chapter_id')
      .where('id', '=', a)
      .executeTakeFirstOrThrow();
    const [b, c] = [newId(), newId()];
    await db
      .insertInto('topics')
      .values([
        { id: b, chapter_id, slug: 'topic-b' },
        { id: c, chapter_id, slug: 'topic-c' },
      ])
      .execute();
    const edge = (topic: string, prerequisite: string) =>
      db
        .insertInto('topic_prerequisites')
        .values({ topic_id: topic, prerequisite_id: prerequisite })
        .execute();
    await edge(b, a); // b needs a
    await edge(c, b); // c needs b
    await expect(edge(a, c)).rejects.toThrow(/cycle/);
    await expect(edge(a, b)).rejects.toThrow(/cycle/);
    await edge(c, a); // a shortcut is fine
  });
});

describe('billing constraints', () => {
  async function insertOrder() {
    const id = newId();
    await db
      .insertInto('orders')
      .values({
        id,
        owner_id: await insertUser({ phone_e164: null }),
        plan_code: 'individual_monthly',
        plan_interval: 'month',
        student_ids: [newId()],
        amount_tiyin: 9_900_000,
        provider: 'payme',
        idempotency_key: newId(),
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .execute();
    return id;
  }
  const insertPayment = async (orderId: string, txn = newId()) => {
    const id = newId();
    await db
      .insertInto('payments')
      .values({
        id,
        order_id: orderId,
        provider: 'payme',
        provider_txn_id: txn,
        amount_tiyin: 9_900_000,
      })
      .execute();
    return id;
  };
  const setStatus = (id: string, status: 'pending' | 'paid' | 'cancelled' | 'refunded') =>
    db
      .updateTable('payments')
      .set({
        status,
        paid_at: status === 'paid' ? new Date() : undefined,
        cancelled_at: status === 'cancelled' || status === 'refunded' ? new Date() : undefined,
      })
      .where('id', '=', id)
      .execute();

  it('allows only forward payment states', async () => {
    const payment = await insertPayment(await insertOrder());
    await setStatus(payment, 'paid');
    await expect(setStatus(payment, 'pending')).rejects.toThrow(/cannot go from paid to pending/);
    await setStatus(payment, 'refunded');
    await expect(setStatus(payment, 'paid')).rejects.toThrow(/cannot go from refunded/);
  });

  it('keeps one live payment per order and one row per provider transaction', async () => {
    const order = await insertOrder();
    const txn = newId();
    const first = await insertPayment(order, txn);
    await expect(insertPayment(order)).rejects.toThrow(/payments_one_live_per_order/);
    await expect(insertPayment(await insertOrder(), txn)).rejects.toThrow(/provider_txn_id/);
    await setStatus(first, 'cancelled');
    await insertPayment(order); // a new attempt after a cancelled one
  });

  it('numbers every payment for providers that want an integer ID', async () => {
    const order = await insertOrder();
    const first = await insertPayment(order);
    await setStatus(first, 'cancelled');
    const second = await insertPayment(order);
    const refs = await db
      .selectFrom('payments')
      .select(['id', 'merchant_ref'])
      .where('id', 'in', [first, second])
      .execute();
    const byId = new Map(refs.map((r) => [r.id, Number(r.merchant_ref)]));
    expect(byId.get(second)!).toBeGreaterThan(byId.get(first)!);
  });

  it('stores money as whole tiyin and refuses non-positive amounts', async () => {
    const order = await insertOrder();
    const row = await db
      .selectFrom('orders')
      .select('amount_tiyin')
      .where('id', '=', order)
      .executeTakeFirstOrThrow();
    expect(Number(row.amount_tiyin)).toBe(9_900_000);
    await expect(
      db.updateTable('orders').set({ amount_tiyin: 0 }).where('id', '=', order).execute(),
    ).rejects.toThrow(/check/);
  });
});

describe('promo code and trial constraints', () => {
  const promo = async (values: Record<string, unknown>) =>
    db
      .insertInto('promo_codes')
      .values({
        id: newId(),
        code: 'SPRING25',
        discount_type: 'percent',
        value: 25,
        valid_from: new Date('2026-01-01'),
        valid_to: new Date('2027-01-01'),
        created_by: await insertUser({ phone_e164: null }),
        ...values,
      } as never)
      .execute();

  it('keeps codes upper-case and unique, and percentages at most 100', async () => {
    await promo({});
    await expect(promo({})).rejects.toThrow(/promo_codes_code_key/);
    await expect(promo({ code: 'lower' })).rejects.toThrow(/check/);
    await expect(promo({ code: 'BIG', value: 101 })).rejects.toThrow(/check/);
    await expect(
      promo({ code: 'FIXED101', discount_type: 'fixed', value: 101 }),
    ).resolves.toBeDefined();
    await expect(promo({ code: 'BACKWARDS', valid_to: new Date('2025-01-01') })).rejects.toThrow(
      /check/,
    );
  });

  it('allows one trial per account', async () => {
    const owner = await insertUser({ phone_e164: null });
    const sub = newId();
    await db
      .insertInto('subscriptions')
      .values({
        id: sub,
        owner_id: owner,
        plan_code: 'trial',
        status: 'trialing',
        seats: 1,
        price_tiyin: 0,
        current_period_start: new Date('2026-11-01'),
        current_period_end: new Date('2026-11-08'),
      })
      .execute();
    const trial = () =>
      db
        .insertInto('trials')
        .values({
          id: newId(),
          owner_id: owner,
          subscription_id: sub,
          started_at: new Date('2026-11-01'),
          ends_at: new Date('2026-11-08'),
        })
        .execute();
    await trial();
    await expect(trial()).rejects.toThrow(/trials_owner_id_key/);
  });
});

describe('media constraints', () => {
  let uploader: string | undefined;
  beforeEach(() => {
    uploader = undefined;
  });

  async function insertMedia(values: Record<string, unknown>) {
    const id = newId();
    uploader ??= await insertUser();
    await db
      .insertInto('media_assets')
      .values({
        id,
        kind: 'video',
        content_type: 'video/mp4',
        size_bytes: 1000,
        source_key: `sources/${id}`,
        uploaded_by: uploader,
        ...values,
      })
      .execute();
    return id;
  }

  it('stores sizes above 2 GiB - 1 (bigint)', async () => {
    const id = await insertMedia({ size_bytes: 2 ** 31 });
    const row = await db
      .selectFrom('media_assets')
      .select('size_bytes')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(Number(row.size_bytes)).toBe(2 ** 31);
  });

  it('needs a parent video and a locale for subtitles, and only for subtitles', async () => {
    const video = await insertMedia({});
    await expect(insertMedia({ kind: 'subtitle', content_type: 'text/vtt' })).rejects.toThrow(
      /check/i,
    );
    await insertMedia({
      kind: 'subtitle',
      content_type: 'text/vtt',
      parent_id: video,
      locale: 'ru',
    });
    await expect(insertMedia({ kind: 'image', parent_id: video })).rejects.toThrow(/check/i);
  });

  it('refuses a ready video without a manifest and a duration', async () => {
    const video = await insertMedia({});
    await expect(
      db.updateTable('media_assets').set({ status: 'ready' }).where('id', '=', video).execute(),
    ).rejects.toThrow(/check/i);
    await db
      .updateTable('media_assets')
      .set({ status: 'ready', hls_manifest_key: `hls/${video}/master.m3u8`, duration_s: 300 })
      .where('id', '=', video)
      .execute();
  });

  it('keeps sealed keys and IVs at their exact sizes', async () => {
    const video = await insertMedia({});
    const insert = (sealed: number, iv: number) =>
      db
        .insertInto('media_keys')
        .values({ media_id: video, sealed_key: Buffer.alloc(sealed), iv: Buffer.alloc(iv) })
        .execute();
    await expect(insert(16, 16)).rejects.toThrow(/check/i);
    await expect(insert(44, 12)).rejects.toThrow(/check/i);
    await insert(44, 16);
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
