import { describe, expect, it } from 'vitest';
import { sniff, watermarkFor } from './media.service';

describe('sniff', () => {
  it('accepts matching files and names what is wrong with others', () => {
    expect(sniff('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(sniff('image/png', Buffer.from('not png'))).toBe('not a PNG file');
    expect(sniff('image/svg+xml', Buffer.from('<html></html>'))).toBe('not an SVG file');
    expect(sniff('image/svg+xml', Buffer.from('<svg><foreignObject/></svg>'))).toMatch(/scripts/);
    expect(sniff('text/vtt', Buffer.from('1\n00:00 --> 00:01'))).toBe('not a WebVTT file');
    expect(sniff('application/pdf', Buffer.from('%PDF'))).toBe('unsupported type');
  });
});

describe('watermarkFor', () => {
  it('uses the random tail of the user ID', () => {
    expect(watermarkFor('0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe('MP-2E3F4A5B');
  });
});
