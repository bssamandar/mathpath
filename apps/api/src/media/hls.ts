/**
 * Rewrites the HLS playlists the worker stored, at the moment a viewer asks
 * for them. Stored playlists hold only relative names; the API turns them
 * into URLs that carry the viewer's token (playlists, key) or are presigned
 * and expire (segments). Nothing viewer-specific is ever stored.
 *
 * Every relative URL below is resolved by the player against the playlist's
 * own URL, `/api/v1/media/{id}/hls/{name}.m3u8`, so no host name is needed.
 */

/** Rendition names the worker writes: `240p`…`1080p` and `audio`. */
export const RENDITION_NAME = /^(?:\d{3,4}p|audio)$/;

/**
 * Master playlist: `720p/index.m3u8` becomes `720p.m3u8?token=…`.
 * @throws Error on a variant line that is not a known rendition.
 */
export function rewriteMaster(playlist: string, token: string): string {
  return mapUriLines(playlist, (uri) => {
    const match = /^([^/]+)\/index\.m3u8$/.exec(uri);
    if (!match || !RENDITION_NAME.test(match[1]!)) throw new Error(`unexpected variant: ${uri}`);
    return `${match[1]}.m3u8?token=${encodeURIComponent(token)}`;
  });
}

/**
 * Media playlist: the key URI becomes the key endpoint with the token, and
 * each segment name becomes the URL `segmentUrl` returns for it.
 * @throws Error on a segment name that is not a plain file name.
 */
export async function rewriteMedia(
  playlist: string,
  token: string,
  segmentUrl: (file: string) => Promise<string>,
): Promise<string> {
  const keyUri = `../key?token=${encodeURIComponent(token)}`;
  const lines = playlist.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:')) {
      out.push(line.replace(/URI="[^"]*"/, `URI="${keyUri}"`));
    } else if (line.trim() === '' || line.startsWith('#')) {
      out.push(line);
    } else {
      const file = line.trim();
      if (!/^[\w-]+\.ts$/.test(file)) throw new Error(`unexpected segment: ${file}`);
      out.push(await segmentUrl(file));
    }
  }
  return out.join('\n');
}

function mapUriLines(playlist: string, map: (uri: string) => string): string {
  return playlist
    .split('\n')
    .map((line) => (line.trim() === '' || line.startsWith('#') ? line : map(line.trim())))
    .join('\n');
}
