/**
 * Uzbek mobile numbers (UX S2): the user types the 9 digits after the fixed
 * +998 prefix, and sees them grouped as "90 123 45 67".
 */
export const COUNTRY_PREFIX = '+998';

/** Keeps at most 9 digits from whatever was typed or pasted (a pasted +998 is dropped). */
export function phoneDigits(input: string): string {
  let digits = input.replace(/\D/g, '');
  if (digits.length > 9 && digits.startsWith('998')) digits = digits.slice(3);
  return digits.slice(0, 9);
}

/** "901234567" → "90 123 45 67"; partial input is grouped as far as it goes. */
export function formatPhone(digits: string): string {
  const groups = [digits.slice(0, 2), digits.slice(2, 5), digits.slice(5, 7), digits.slice(7, 9)];
  return groups.filter(Boolean).join(' ');
}

export function isCompletePhone(digits: string): boolean {
  return /^\d{9}$/.test(digits);
}

/** The E.164 form the API expects. */
export function toE164(digits: string): string {
  return `${COUNTRY_PREFIX}${digits}`;
}
