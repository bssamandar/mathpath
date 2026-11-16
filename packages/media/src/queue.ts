/** The BullMQ queue the API fills and the worker drains (ADR-0007). */
export const TRANSCODE_QUEUE = 'media-transcode';

/** A job carries only the ID; the worker reads everything else from the database. */
export interface TranscodeJob {
  mediaId: string;
}
