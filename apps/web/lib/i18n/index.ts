/**
 * UI text in Uzbek (Latin), Russian and English (PRD: uz-Latn first).
 *
 * Plain typed dictionaries instead of a library such as next-intl: the MVP has
 * a few dozen strings and no plurals yet, TypeScript enforces that every
 * language has every key, and nothing extra ships to the browser. A library
 * becomes worth it when plural rules and lazy-loaded namespaces are needed.
 */
import { en, type MessageKey, type Messages } from './en';
import { ru } from './ru';
import { uz } from './uz';

export type { MessageKey };
export const LOCALES = ['uz-Latn', 'ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'uz-Latn';
/** Remembered on the device (UX S1); not a secret, so readable by scripts. */
export const LOCALE_COOKIE = 'mp_locale';

export const LOCALE_NAMES: Record<Locale, string> = {
  'uz-Latn': 'O‘zbekcha',
  ru: 'Русский',
  en: 'English',
};

const dictionaries: Record<Locale, Messages> = { 'uz-Latn': uz, ru, en };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/** Returns a translator for a locale. `{name}` placeholders are filled from `values`. */
export function translator(locale: Locale): Translate {
  const messages = dictionaries[locale];
  return (key, values) =>
    messages[key].replace(/\{(\w+)\}/g, (match, name: string) =>
      values && name in values ? String(values[name]) : match,
    );
}

/** True when the dictionary has a message for an API problem code. */
export function hasErrorMessage(code: string): code is string {
  return `error.${code}` in en;
}
