/**
 * Demo catalogue for development, staging and usability tests (PRD: "CMS plus
 * 2–3 seeded demo topics"): grade 5 → Fractions with three published topics in
 * Uzbek and Russian.
 *
 * Run with `pnpm db:seed`. It is idempotent: fixed IDs, and existing rows are
 * left alone, so running it twice changes nothing. Real content is written in
 * the studio and goes through review; these rows skip that workflow on purpose
 * and are never loaded in production (the CLI refuses NODE_ENV=production).
 */
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database, LocalisedText } from '../schema';

/** Fixed IDs so other seeds and test scripts can refer to the demo content. */
export const DEMO_IDS = {
  author: '01936a00-0000-7000-8000-000000000001',
  track: '01936a00-0000-7000-8000-000000000010',
  course: '01936a00-0000-7000-8000-000000000020',
  chapter: '01936a00-0000-7000-8000-000000000030',
  topics: [
    '01936a00-0000-7000-8000-000000000041',
    '01936a00-0000-7000-8000-000000000042',
    '01936a00-0000-7000-8000-000000000043',
  ],
  versions: [
    '01936a00-0000-7000-8000-000000000051',
    '01936a00-0000-7000-8000-000000000052',
    '01936a00-0000-7000-8000-000000000053',
  ],
} as const;

interface DemoTopic {
  slug: string;
  isFree: boolean;
  title: LocalisedText;
  summary: LocalisedText;
  steps: unknown[];
}

const TOPICS: DemoTopic[] = [
  {
    slug: 'what-is-a-fraction',
    isFree: true,
    title: { 'uz-Latn': 'Kasr nima?', ru: 'Что такое дробь?' },
    summary: {
      'uz-Latn': 'Butunni teng qismlarga bo‘lamiz va qismlarni kasr bilan yozamiz.',
      ru: 'Делим целое на равные части и записываем части дробью.',
    },
    steps: [
      {
        type: 'activity',
        activity: 'fraction_model',
        config: { shape: 'circle', parts: 4, target: [1, 4] },
        prompt: {
          'uz-Latn': 'Pitsaning to‘rtdan bir qismini bo‘yang.',
          ru: 'Закрасьте одну четвёртую часть пиццы.',
        },
      },
      {
        type: 'activity',
        activity: 'fraction_model',
        config: { shape: 'bar', parts: 3, target: [2, 3] },
        prompt: {
          'uz-Latn': 'Shokoladning uchdan ikki qismini bo‘yang.',
          ru: 'Закрасьте две третьих шоколадки.',
        },
      },
      { type: 'practice', minCorrect: 5, prompt: {} },
      { type: 'mastery_test' },
    ],
  },
  {
    slug: 'comparing-fractions',
    isFree: false,
    title: { 'uz-Latn': 'Kasrlarni taqqoslash', ru: 'Сравнение дробей' },
    summary: {
      'uz-Latn': 'Qaysi kasr katta? Son o‘qida va rasmda taqqoslaymiz.',
      ru: 'Какая дробь больше? Сравниваем на числовом луче и на рисунке.',
    },
    steps: [
      {
        type: 'activity',
        activity: 'number_line',
        config: { min: 0, max: 1, ticks: 8 },
        prompt: {
          'uz-Latn': '3/8 ni son o‘qiga joylashtiring.',
          ru: 'Отметьте 3/8 на числовом луче.',
        },
      },
      { type: 'practice', minCorrect: 6, prompt: {} },
      { type: 'mastery_test' },
    ],
  },
  {
    slug: 'adding-like-fractions',
    isFree: false,
    title: {
      'uz-Latn': 'Maxrajlari bir xil kasrlarni qo‘shish',
      ru: 'Сложение дробей с одинаковыми знаменателями',
    },
    summary: {
      'uz-Latn': 'Maxraj o‘zgarmaydi, suratlar qo‘shiladi.',
      ru: 'Знаменатель не меняется, числители складываются.',
    },
    steps: [
      {
        type: 'activity',
        activity: 'step_solver',
        config: { expression: '2/7 + 3/7' },
        prompt: { 'uz-Latn': 'Qadamma-qadam yeching.', ru: 'Решите по шагам.' },
      },
      { type: 'practice', minCorrect: 6, prompt: {} },
      { type: 'mastery_test' },
      { type: 'review' },
    ],
  },
];

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Inserts the demo catalogue. @returns How many topics were newly created. */
export async function seedDemoContent(db: Kysely<Database>, now = new Date()): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await trx
      .insertInto('users')
      // The demo author has no phone, password or role, so nobody can sign in as it.
      .values({ id: DEMO_IDS.author, first_name: 'MathPath', last_name: 'Demo' })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('tracks')
      .values({
        id: DEMO_IDS.track,
        slug: 'school',
        title: { 'uz-Latn': 'Maktab dasturi', ru: 'Школьная программа', en: 'School curriculum' },
        sort: 1,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('courses')
      .values({
        id: DEMO_IDS.course,
        track_id: DEMO_IDS.track,
        slug: 'grade-5',
        grade: 5,
        title: { 'uz-Latn': '5-sinf matematika', ru: 'Математика, 5 класс', en: 'Grade 5 maths' },
        status: 'published',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('chapters')
      .values({
        id: DEMO_IDS.chapter,
        course_id: DEMO_IDS.course,
        slug: 'fractions',
        title: { 'uz-Latn': 'Kasrlar', ru: 'Дроби', en: 'Fractions' },
        status: 'published',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    let created = 0;
    for (const [i, topic] of TOPICS.entries()) {
      const topicId = DEMO_IDS.topics[i]!;
      const versionId = DEMO_IDS.versions[i]!;
      const exists = await trx
        .selectFrom('topics')
        .select('id')
        .where('id', '=', topicId)
        .executeTakeFirst();
      if (exists) continue;
      await trx
        .insertInto('topics')
        .values({
          id: topicId,
          chapter_id: DEMO_IDS.chapter,
          slug: topic.slug,
          sort: i + 1,
          is_free: topic.isFree,
        })
        .execute();
      const content = {
        title: topic.title,
        summary: topic.summary,
        steps: topic.steps,
        question_pool: {},
      };
      await trx
        .insertInto('topic_versions')
        .values({
          id: versionId,
          topic_id: topicId,
          version_no: 1,
          status: 'published',
          title: JSON.stringify(topic.title),
          summary: JSON.stringify(topic.summary),
          steps: JSON.stringify(topic.steps),
          author_id: DEMO_IDS.author,
          content_hash: hash(content),
          published_at: now,
        })
        .execute();
      await trx
        .updateTable('topics')
        .set({ published_version_id: versionId })
        .where('id', '=', topicId)
        .execute();
      created += 1;
    }
    return created;
  });
}
