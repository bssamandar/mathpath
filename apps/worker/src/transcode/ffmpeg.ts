/**
 * Thin wrappers over ffprobe and ffmpeg (architecture §7.1, §7.3).
 *
 * Arguments are passed as an array to execFile, never through a shell, so a
 * file name cannot inject a command. Uploads are untrusted input to a large
 * C program, so ffmpeg may only read local files (`-protocol_whitelist`), and
 * every run has a time limit.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The facts about a source video the transcoder needs. */
export interface Probe {
  durationS: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** A source that can never be transcoded; retrying will not help. */
export class RejectedMedia extends Error {}

export async function probe(file: string, timeoutMs = 60_000): Promise<Probe> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        file,
      ],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch {
    throw new RejectedMedia('the file is not a readable video');
  }
  const info = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const video = info.streams?.find((s) => s.codec_type === 'video');
  const durationS = Number(info.format?.duration);
  if (!video?.width || !video.height) throw new RejectedMedia('the file has no video stream');
  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw new RejectedMedia('the video has no duration');
  }
  return {
    durationS,
    width: video.width,
    height: video.height,
    hasAudio: info.streams?.some((s) => s.codec_type === 'audio') ?? false,
  };
}

export interface EncodeOptions {
  source: string;
  /** Directory for this rendition's playlist and segments. */
  outDir: string;
  /** ffmpeg key info file: key URI, key file path, IV. */
  keyInfoFile: string;
  segmentSeconds: number;
  /** Target height, or null for the audio-only rendition. */
  height: number | null;
  videoKbps: number;
  audioKbps: number;
  hasAudio: boolean;
  timeoutMs: number;
}

/** Builds the ffmpeg arguments for one encrypted HLS rendition. */
export function encodeArgs(o: EncodeOptions): string[] {
  const input = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file'];
  const video =
    o.height === null
      ? ['-vn']
      : [
          '-vf',
          `scale=-2:${o.height}`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-profile:v',
          'main',
          '-pix_fmt',
          'yuv420p',
          '-b:v',
          `${o.videoKbps}k`,
          '-maxrate',
          `${Math.round(o.videoKbps * 1.1)}k`,
          '-bufsize',
          `${o.videoKbps * 2}k`,
          // A key frame at every segment boundary, so segments cut cleanly.
          '-force_key_frames',
          `expr:gte(t,n_forced*${o.segmentSeconds})`,
        ];
  const audio = o.hasAudio ? ['-c:a', 'aac', '-b:a', `${o.audioKbps}k`, '-ac', '2'] : ['-an'];
  return [
    ...input,
    '-i',
    o.source,
    ...video,
    ...audio,
    '-f',
    'hls',
    '-hls_time',
    String(o.segmentSeconds),
    '-hls_playlist_type',
    'vod',
    '-hls_key_info_file',
    o.keyInfoFile,
    '-hls_segment_filename',
    `${o.outDir}/seg_%04d.ts`,
    `${o.outDir}/index.m3u8`,
  ];
}

export async function encode(o: EncodeOptions): Promise<void> {
  await run('ffmpeg', encodeArgs(o), { timeout: o.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
}
