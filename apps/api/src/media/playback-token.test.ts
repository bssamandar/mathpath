import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthKeys } from '../identity/keys';
import { PlaybackTokens } from './playback-token';

const keys = new AuthKeys(
  generateKeyPairSync('ed25519').privateKey,
  'k',
  new Map(),
  Buffer.alloc(32, 1),
);
const tokens = new PlaybackTokens(keys);
const now = Date.parse('2026-11-15T10:00:00Z');
const claims = { mediaId: 'm1', userId: 'u1', expiresAt: now / 1000 + 600 };

describe('PlaybackTokens', () => {
  it('verifies its own tokens until they expire', () => {
    const token = tokens.sign(claims);
    expect(tokens.verify(token, now)).toEqual(claims);
    expect(tokens.verify(token, now + 600_000)).toBeNull();
  });

  it('refuses forged, malformed and foreign tokens', () => {
    const [body, mac] = tokens.sign(claims).split('.') as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ m: 'm2', u: 'u1', e: 9e9 })).toString(
      'base64url',
    );
    expect(tokens.verify(`${forgedBody}.${mac}`, now)).toBeNull();
    expect(tokens.verify(`${body}.${mac}.x`, now)).toBeNull();
    expect(tokens.verify(body, now)).toBeNull();
    expect(tokens.verify(`${body}.short`, now)).toBeNull();

    const other = new PlaybackTokens(
      new AuthKeys(generateKeyPairSync('ed25519').privateKey, 'k', new Map(), Buffer.alloc(32, 2)),
    );
    expect(other.verify(tokens.sign(claims), now)).toBeNull();
  });

  it('refuses a correctly signed body that is not valid claims', () => {
    for (const raw of ['not json', JSON.stringify({ m: 1, u: 'u', e: 1 }), 'null']) {
      const body = Buffer.from(raw).toString('base64url');
      expect(tokens.verify(`${body}.${keys.hmac('media', body)}`, now)).toBeNull();
    }
  });
});
