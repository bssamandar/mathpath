import { describe, expect, it } from 'vitest';
import { qrPath, telegramLink } from './telegram-card';

describe('telegram card', () => {
  it('links to the bot with a start parameter', () => {
    expect(telegramLink('mathpathbot')).toBe('https://t.me/mathpathbot?start=web');
  });

  it('draws a QR code with a quiet zone', () => {
    const { size, d } = qrPath('https://t.me/mathpathbot?start=web');
    // Version 3 (29 modules) fits this link at level M, plus 4 modules each side.
    expect(size).toBe(29 + 8);
    // The top-left finder pattern starts right after the quiet zone.
    expect(d.startsWith('M4 4h1v1h-1z')).toBe(true);
  });
});
