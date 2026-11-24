/** One child's week in the Sunday report SMS. */
export interface WeeklyChildLine {
  name: string;
  minutes: number;
  questions: number;
  mastered: number;
}

type Locale = 'uz-Latn' | 'ru' | 'en';

const WEEKLY: Record<
  Locale,
  {
    one: (c: WeeklyChildLine) => string;
    many: (c: WeeklyChildLine) => string;
    head: string;
    more: (n: number) => string;
    link: string;
  }
> = {
  // Plain apostrophes keep the Uzbek text in GSM-7: 160 characters per segment
  // instead of 70.
  'uz-Latn': {
    head: 'MathPath haftalik hisobot:',
    one: (c) =>
      `${c.name} bu hafta ${c.minutes} daq. mashq qildi, ${c.questions} ta savol` +
      (c.mastered ? `, ${c.mastered} mavzuni o'zlashtirdi.` : '.'),
    many: (c) => `${c.name} ${c.minutes} daq., ${c.questions} savol`,
    more: (n) => `va yana ${n} farzand`,
    link: 'Batafsil:',
  },
  ru: {
    head: 'MathPath за неделю:',
    one: (c) =>
      `${c.name}: ${c.minutes} мин, ${c.questions} задач` +
      (c.mastered ? `, освоено тем: ${c.mastered}.` : '.'),
    many: (c) => `${c.name} ${c.minutes} мин, ${c.questions} задач`,
    more: (n) => `и ещё ${n}`,
    link: 'Отчёт:',
  },
  en: {
    head: 'MathPath this week:',
    one: (c) =>
      `${c.name} practised ${c.minutes} min, ${c.questions} questions` +
      (c.mastered ? `, ${c.mastered} topics mastered.` : '.'),
    many: (c) => `${c.name} ${c.minutes} min, ${c.questions} questions`,
    more: (n) => `and ${n} more`,
    link: 'Report:',
  },
};

/** Children named in one SMS; the rest are counted, so the text stays short. */
const MAX_NAMED = 2;

/**
 * The Sunday report SMS in the parent's language: one child in a sentence,
 * several as short lines, and a link to the report in the app.
 */
function weeklyReport(locale: string, children: readonly WeeklyChildLine[], link: string): string {
  const w = WEEKLY[(locale in WEEKLY ? locale : 'uz-Latn') as Locale];
  if (children.length === 1) return `${w.head} ${w.one(children[0]!)} ${w.link} ${link}`;
  const named = children.slice(0, MAX_NAMED).map(w.many).join('; ');
  const rest = children.length - MAX_NAMED;
  return `${w.head} ${named}${rest > 0 ? ` ${w.more(rest)}` : ''}. ${w.link} ${link}`;
}

/**
 * SMS texts. Short and in Uzbek (Latin) and Russian together, because the
 * user's language is not known before sign-up. Each part fits one GSM-7 or
 * UCS-2 segment as closely as practical to keep SMS costs down. The weekly
 * report goes to signed-up parents, so it uses their language.
 *
 * Eskiz delivers only texts whose wording was approved in its dashboard:
 * register every template here (with the numbers and link as variables)
 * before going live.
 */
export const smsMessages = {
  otpCode: (code: string): string =>
    `MathPath kodi: ${code}. Uni hech kimga bermang. / Kod: ${code}. Никому не сообщайте.`,
  resetCode: (code: string): string =>
    `MathPath parolni tiklash kodi: ${code}. Siz so'ramagan bo'lsangiz, e'tibor bermang. / Код для сброса пароля: ${code}. Если это не вы, ничего не делайте.`,
  confirmCode: (code: string): string =>
    `MathPath tasdiqlash kodi: ${code}. Uni hech kimga bermang. / Код подтверждения: ${code}.`,
  childPinLocked: (): string =>
    'MathPath: farzandingiz profiliga ko‘p marta noto‘g‘ri PIN kiritildi, profil vaqtincha bloklandi. / Профиль ребёнка временно заблокирован из-за неверных PIN.',
  alreadyRegistered: (): string =>
    'Bu raqam MathPath’da ro‘yxatdan o‘tgan. Kirish sahifasidan foydalaning. / Номер уже зарегистрирован, войдите в аккаунт.',
  accountLocked: (): string =>
    'MathPath: hisobingizga ko‘p marta noto‘g‘ri parol kiritildi. Siz bo‘lmasangiz, parolni almashtiring. / Много неверных паролей. Если это не вы, смените пароль.',
  weeklyReport,
} as const;
