/** Helpers for staff two-factor sign-in (UX F9, security plan C-08). */

import qrcode from 'qrcode-generator';

/** Pulls the secret out of an otpauth:// URI so it can be typed in by hand. */
export function otpauthSecret(uri: string): string | null {
  try {
    const secret = new URL(uri).searchParams.get('secret');
    return secret ? (secret.match(/.{1,4}/g) ?? [secret]).join(' ') : null;
  } catch {
    return null;
  }
}

/**
 * The dark modules of a QR code for `text`, as one SVG path with a 4-module
 * quiet zone. Drawn in the browser, so the secret never goes to a QR service.
 */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let d = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
    }
  }
  return { size: count + 8, d };
}
