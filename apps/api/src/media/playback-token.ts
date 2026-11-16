/**
 * Short-lived tokens for HLS playlists and keys (architecture §7.3).
 *
 * The player fetches playlists and the key by URL, so the URL carries a
 * token naming the video, the viewer and an expiry, signed with an HMAC.
 * The session cookie is still required as well: a token copied to another
 * account does not work, because its user must match the session's.
 */
import { timingSafeEqual } from 'node:crypto';
import type { AuthKeys } from '../identity/keys';

export interface PlaybackClaims {
  mediaId: string;
  userId: string;
  /** Expiry, Unix seconds. */
  expiresAt: number;
}

export class PlaybackTokens {
  constructor(private readonly keys: AuthKeys) {}

  sign(claims: PlaybackClaims): string {
    const body = Buffer.from(
      JSON.stringify({ m: claims.mediaId, u: claims.userId, e: claims.expiresAt }),
    ).toString('base64url');
    return `${body}.${this.keys.hmac('media', body)}`;
  }

  /** @returns The claims, or null when the token is malformed, forged or expired. */
  verify(token: string, nowMs: number): PlaybackClaims | null {
    const [body, mac, extra] = token.split('.');
    if (!body || !mac || extra !== undefined) return null;
    const expected = Buffer.from(this.keys.hmac('media', body));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const { m, u, e } = (parsed ?? {}) as { m?: unknown; u?: unknown; e?: unknown };
    if (typeof m !== 'string' || typeof u !== 'string' || typeof e !== 'number') return null;
    if (e * 1000 <= nowMs) return null;
    return { mediaId: m, userId: u, expiresAt: e };
  }
}
