/**
 * Child PIN rules. A 4–6 digit PIN is weak by nature; it is acceptable only
 * because sign-in also needs the family code and the profile locks after a few
 * wrong tries (C-04). Refusing the most guessable PINs makes those tries count.
 */

/** True for PINs like 0000, 1234, 4321 or 121212 that are guessed first. */
export function isTooSimplePin(pin: string): boolean {
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]!);
  if (steps.every((s) => s === 0)) return true; // 0000
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true; // 1234, 4321
  // Repeated pairs or triples: 1212, 123123.
  for (const size of [2, 3]) {
    if (
      pin.length % size === 0 &&
      pin.length > size &&
      pin === pin.slice(0, size).repeat(pin.length / size)
    ) {
      return true;
    }
  }
  return false;
}
