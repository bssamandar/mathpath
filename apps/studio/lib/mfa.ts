/** Helpers for staff two-factor sign-in (UX F9, security plan C-08). */

/** Pulls the secret out of an otpauth:// URI so it can be typed in by hand. */
export function otpauthSecret(uri: string): string | null {
  try {
    const secret = new URL(uri).searchParams.get('secret');
    return secret ? (secret.match(/.{1,4}/g) ?? [secret]).join(' ') : null;
  } catch {
    return null;
  }
}
