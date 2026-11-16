/**
 * Types and pure helpers for the course list and the lesson player (UX S3–S5).
 * The shapes follow docs/api/openapi.yaml (Track, CourseTree, Lesson, getPlayback).
 */

export interface Track {
  id: string;
  slug: string;
  title: string;
  courses: { id: string; slug: string; title: string; grade: number | null }[];
}

export interface CourseTree {
  id: string;
  title: string;
  chapters: {
    id: string;
    title: string;
    topics: {
      id: string;
      title: string;
      isFree: boolean;
      locked: boolean;
      /** Present when signed in. */
      state?: TopicState;
      mastery?: number | null;
    }[];
  }[];
}

export type TopicState = 'not_started' | 'learning' | 'mastered' | 'needs_review';

export type StepType = 'video' | 'activity' | 'practice' | 'mastery_test' | 'review';

export interface LessonStep {
  index: number;
  type: StepType;
  completed: boolean;
  mediaId?: string;
  activity?: string;
  config?: Record<string, unknown>;
  prompt?: string;
}

export interface Lesson {
  topicId: string;
  versionId: string;
  title: string;
  steps: LessonStep[];
}

export interface Playback {
  manifestUrl: string;
  expiresAt: string;
  watermark: string;
  subtitles: { locale: string; url: string }[];
}

/** Playback speeds offered; 1 is the default. */
export const SPEEDS = [0.75, 1, 1.25, 1.5] as const;

/** "720p" for a level with a height, the bitrate in kbit/s otherwise. */
export function qualityLabel(level: { height?: number; bitrate?: number }): string {
  if (level.height) return `${level.height}p`;
  return `${Math.round((level.bitrate ?? 0) / 1000)} kbit/s`;
}

/**
 * Where the watermark sits, as percentages of the video box. It moves every
 * few seconds to a spot picked from the user's code and the time, so it
 * cannot be cropped away and a recording still shows who made it (C-21).
 */
export function watermarkPosition(code: string, tick: number): { left: number; top: number } {
  let hash = tick + 1;
  for (const char of code) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  return { left: 5 + (hash % 70), top: 5 + ((hash >>> 8) % 80) };
}

/**
 * The first step a learner has not finished, so a returning learner continues
 * where they stopped; the last step when all are done.
 */
export function resumeIndex(steps: readonly LessonStep[]): number {
  const open = steps.findIndex((s) => !s.completed);
  return open === -1 ? Math.max(0, steps.length - 1) : open;
}

/** Subtitle tracks in the reader's language first, so the default one fits. */
export function orderSubtitles<T extends { locale: string }>(
  tracks: readonly T[],
  locale: string,
): T[] {
  return [...tracks].sort((a, b) => Number(b.locale === locale) - Number(a.locale === locale));
}

/** True when the playback token has run out or is about to (30 s margin). */
export function playbackExpired(playback: Playback, now = Date.now()): boolean {
  return Date.parse(playback.expiresAt) - 30_000 <= now;
}
