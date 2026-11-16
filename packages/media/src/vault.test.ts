import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MediaKeyVault } from './vault';

const vault = new MediaKeyVault(Buffer.alloc(32, 7));
const key = randomBytes(16);

describe('MediaKeyVault', () => {
  it('opens what it sealed', () => {
    const sealed = vault.seal('video-1', key);
    expect(sealed.length).toBe(12 + 16 + 16);
    expect(vault.open('video-1', sealed)).toEqual(key);
  });

  it('uses a fresh IV, so the same key seals differently each time', () => {
    expect(vault.seal('video-1', key)).not.toEqual(vault.seal('video-1', key));
  });

  it('refuses a key copied onto another video', () => {
    expect(() => vault.open('video-2', vault.seal('video-1', key))).toThrow();
  });

  it('refuses a changed or cut-short value', () => {
    const sealed = vault.seal('video-1', key);
    sealed[sealed.length - 1]! ^= 1;
    expect(() => vault.open('video-1', sealed)).toThrow();
    expect(() => vault.open('video-1', sealed.subarray(0, 27))).toThrow('too short');
  });

  it('refuses a value sealed under another secret', () => {
    const other = new MediaKeyVault(Buffer.alloc(32, 8));
    expect(() => other.open('video-1', vault.seal('video-1', key))).toThrow();
  });

  it('needs a secret of at least 32 bytes', () => {
    expect(() => new MediaKeyVault(Buffer.alloc(31))).toThrow('at least 32 bytes');
  });
});
