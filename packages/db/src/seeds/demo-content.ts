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

interface DemoQuestion {
  /** Index into DEMO_IDS.topics. */
  topic: number;
  type: 'numeric' | 'single_choice' | 'multiple_choice';
  difficulty: number;
  skills: string[];
  body: Record<string, unknown>;
}

/**
 * Demo question templates (schema doc §4.2), two or three per topic. They
 * are checked against the engine by the API's question tests.
 */
const QUESTIONS: DemoQuestion[] = [
  {
    topic: 0,
    type: 'single_choice',
    difficulty: 1,
    skills: ['fraction_meaning'],
    body: {
      variables: { n: { int: [3, 9] }, k: { int: [1, 'n-1'] } },
      constraints: ['2 * k != n'],
      stem: {
        'uz-Latn':
          'Doira {n} ta teng qismga bo‘lingan, {k} tasi bo‘yalgan. Bo‘yalgan qism qaysi kasr?',
        ru: 'Круг разделён на {n} равных частей, {k} из них закрашены. Какая это дробь?',
      },
      answer: { kind: 'choice', expr: 'k/n', display: 'fraction' },
      distractors: ['n/k', '(n-k)/n', '1/n'],
      hints: [
        {
          'uz-Latn': 'Maxraj: hamma qismlar soni. Surat: bo‘yalgan qismlar soni.',
          ru: 'Знаменатель: сколько всего частей. Числитель: сколько закрашено.',
        },
      ],
    },
  },
  {
    topic: 0,
    type: 'numeric',
    difficulty: 2,
    skills: ['fraction_meaning'],
    body: {
      variables: { n: { int: [12, 30] }, k: { int: [1, 'n-1'] } },
      stem: {
        'uz-Latn':
          'Sinfda {n} o‘quvchi bor, {k} tasi qiz bola. Qiz bolalar sinfning qancha qismi? Kasr bilan yozing.',
        ru: 'В классе {n} учеников, {k} из них девочки. Какую часть класса составляют девочки? Запишите дробью.',
      },
      answer: { kind: 'fraction', expr: 'k/n', accept: ['equivalent'] },
    },
  },
  {
    topic: 0,
    type: 'multiple_choice',
    difficulty: 2,
    skills: ['equivalent_fractions'],
    body: {
      stem: {
        'uz-Latn': 'Qaysi kasrlar $\\frac{1}{2}$ ga teng? Hammasini belgilang.',
        ru: 'Какие дроби равны $\\frac{1}{2}$? Отметьте все.',
      },
      answer: {
        kind: 'choices',
        options: [
          { text: { 'uz-Latn': '$\\frac{2}{4}$', ru: '$\\frac{2}{4}$' }, correct: true },
          { text: { 'uz-Latn': '$\\frac{3}{6}$', ru: '$\\frac{3}{6}$' }, correct: true },
          { text: { 'uz-Latn': '$\\frac{2}{3}$', ru: '$\\frac{2}{3}$' }, correct: false },
          { text: { 'uz-Latn': '$\\frac{1}{4}$', ru: '$\\frac{1}{4}$' }, correct: false },
        ],
      },
    },
  },
  {
    topic: 1,
    type: 'single_choice',
    difficulty: 1,
    skills: ['comparing_fractions'],
    body: {
      variables: { d: { int: [3, 12] }, a: { int: [1, 'd-1'] }, b: { int: [1, 'd-1'] } },
      constraints: ['a != b'],
      stem: {
        'uz-Latn': 'Qaysi kasr katta: $\\frac{{a}}{{d}}$ yoki $\\frac{{b}}{{d}}$?',
        ru: 'Какая дробь больше: $\\frac{{a}}{{d}}$ или $\\frac{{b}}{{d}}$?',
      },
      answer: { kind: 'choice', expr: 'max(a, b)/d', display: 'fraction' },
      distractors: ['min(a, b)/d'],
    },
  },
  {
    topic: 1,
    type: 'numeric',
    difficulty: 3,
    skills: ['fraction_to_decimal'],
    body: {
      variables: { d: { choice: [2, 4, 5, 8, 10, 20, 25] }, a: { int: [1, 'd-1'] } },
      stem: {
        'uz-Latn': '$\\frac{{a}}{{d}}$ ni o‘nli kasr ko‘rinishida yozing.',
        ru: 'Запишите $\\frac{{a}}{{d}}$ в виде десятичной дроби.',
      },
      answer: { kind: 'number', expr: 'a/d' },
    },
  },
  {
    topic: 2,
    type: 'numeric',
    difficulty: 2,
    skills: ['fraction_addition'],
    body: {
      variables: { d: { int: [2, 9] }, a: { int: [1, 'd-1'] }, b: { int: [1, 'd-1'] } },
      constraints: ['a + b != d'],
      stem: {
        'uz-Latn': 'Hisoblang: $\\frac{{a}}{{d}} + \\frac{{b}}{{d}}$',
        ru: 'Вычислите: $\\frac{{a}}{{d}} + \\frac{{b}}{{d}}$',
      },
      answer: { kind: 'fraction', expr: '(a+b)/d', accept: ['equivalent', 'mixed_number'] },
      hints: [
        {
          'uz-Latn': 'Maxrajlar bir xil: suratlarni qo‘shing.',
          ru: 'Знаменатели одинаковые: сложите числители.',
        },
      ],
      solution: {
        'uz-Latn': '$\\frac{{a}}{{d}} + \\frac{{b}}{{d}} = \\frac{{a+b}}{{d}}$',
        ru: '$\\frac{{a}}{{d}} + \\frac{{b}}{{d}} = \\frac{{a+b}}{{d}}$',
      },
    },
  },
  {
    topic: 2,
    type: 'single_choice',
    difficulty: 1,
    skills: ['fraction_addition'],
    body: {
      variables: { d: { int: [3, 11] }, a: { int: [1, 'd-2'] }, b: { int: [1, 'd-a-1'] } },
      stem: {
        'uz-Latn': '$\\frac{{a}}{{d}} + \\frac{{b}}{{d}} = ?$',
        ru: '$\\frac{{a}}{{d}} + \\frac{{b}}{{d}} = ?$',
      },
      answer: { kind: 'choice', expr: '(a+b)/d', display: 'fraction' },
      distractors: ['(a+b)/(2*d)', '(a*b)/d', '(a+b+1)/d'],
    },
  },
  {
    topic: 2,
    type: 'numeric',
    difficulty: 3,
    skills: ['fraction_addition', 'word_problem'],
    body: {
      variables: { d: { int: [5, 12] }, a: { int: [1, 'd-2'] }, b: { int: [1, 'd-a-1'] } },
      stem: {
        'uz-Latn':
          'Ali pitsaning {a}/{d} qismini, Vali esa {b}/{d} qismini yedi. Ikkalasi birga pitsaning qancha qismini yedi?',
        ru: 'Али съел {a}/{d} пиццы, а Вали {b}/{d}. Какую часть пиццы они съели вместе?',
      },
      answer: { kind: 'fraction', expr: '(a+b)/d', accept: ['equivalent'] },
    },
  },
];

/** Fixed IDs, so seeding twice changes nothing: template …0061+i, version …0071+i. */
const questionId = (base: number, i: number) =>
  `01936a00-0000-7000-8000-${String(base + i).padStart(12, '0')}`;

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

    for (const [i, q] of QUESTIONS.entries()) {
      const templateId = questionId(61, i);
      const versionId = questionId(81, i);
      const inserted = await trx
        .insertInto('question_templates')
        .values({
          id: templateId,
          topic_id: DEMO_IDS.topics[q.topic]!,
          created_by: DEMO_IDS.author,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) continue;
      await trx
        .insertInto('question_template_versions')
        .values({
          id: versionId,
          template_id: templateId,
          version_no: 1,
          status: 'published',
          type: q.type,
          difficulty: q.difficulty,
          skills: q.skills,
          body: JSON.stringify(q.body),
          author_id: DEMO_IDS.author,
          content_hash: hash(q),
          published_at: now,
        })
        .execute();
      await trx
        .updateTable('question_templates')
        .set({ published_version_id: versionId })
        .where('id', '=', templateId)
        .execute();
    }

    // Knowledge graph: comparing needs the meaning of a fraction; adding
    // like fractions needs comparing (gap routing walks these edges).
    const [meaning, comparing, adding] = DEMO_IDS.topics;
    await trx
      .insertInto('topic_prerequisites')
      .values([
        { topic_id: comparing, prerequisite_id: meaning },
        { topic_id: adding, prerequisite_id: comparing },
      ])
      .onConflict((oc) => oc.columns(['topic_id', 'prerequisite_id']).doNothing())
      .execute();
    return created;
  });
}
