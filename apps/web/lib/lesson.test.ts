import { describe, expect, it } from 'vitest';
import {
  type LessonStep,
  orderSubtitles,
  playbackExpired,
  qualityLabel,
  resumeIndex,
  watermarkPosition,
} from './lesson';

const step = (index: number, completed: boolean): LessonStep => ({
  index,
  type: 'video',
  completed,
});

describe('lesson helpers', () => {
  it('labels qualities by height, or by bitrate for audio', () => {
    expect(qualityLabel({ height: 720, bitrate: 2_800_000 })).toBe('720p');
    expect(qualityLabel({ bitrate: 96_000 })).toBe('96 kbit/s');
    expect(qualityLabel({})).toBe('0 kbit/s');
  });

  it('moves the watermark within the frame, the same way for the same inputs', () => {
    const seen = new Set<string>();
    for (let tick = 0; tick < 20; tick++) {
      const { left, top } = watermarkPosition('MP-1a2b3c4d', tick);
      expect(left).toBeGreaterThanOrEqual(5);
      expect(left).toBeLessThan(75);
      expect(top).toBeGreaterThanOrEqual(5);
      expect(top).toBeLessThan(85);
      seen.add(`${left},${top}`);
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(watermarkPosition('MP-x', 3)).toEqual(watermarkPosition('MP-x', 3));
  });

  it('resumes at the first unfinished step', () => {
    expect(resumeIndex([step(0, true), step(1, false), step(2, false)])).toBe(1);
    expect(resumeIndex([step(0, true), step(1, true)])).toBe(1);
    expect(resumeIndex([])).toBe(0);
  });

  it('puts subtitles in the reader language first', () => {
    const tracks = [{ locale: 'uz-Latn' }, { locale: 'ru' }];
    expect(orderSubtitles(tracks, 'ru').map((t) => t.locale)).toEqual(['ru', 'uz-Latn']);
    expect(orderSubtitles(tracks, 'en').map((t) => t.locale)).toEqual(['uz-Latn', 'ru']);
  });

  it('treats a token as expired 30 s early', () => {
    const playback = {
      manifestUrl: '/x',
      watermark: 'MP-1',
      subtitles: [],
      expiresAt: '2026-11-16T10:00:00Z',
    };
    expect(playbackExpired(playback, Date.parse('2026-11-16T09:59:00Z'))).toBe(false);
    expect(playbackExpired(playback, Date.parse('2026-11-16T09:59:45Z'))).toBe(true);
  });
});
