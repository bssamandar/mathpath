import { describe, expect, it } from 'vitest';
import { rewriteMaster, rewriteMedia } from './hls';

describe('rewriteMaster', () => {
  it('points each variant at the API with the token', () => {
    const out = rewriteMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p/index.m3u8\n', 'a+b');
    expect(out).toBe('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p.m3u8?token=a%2Bb\n');
  });

  it('refuses a variant it does not recognise', () => {
    expect(() => rewriteMaster('#EXTM3U\nhttps://evil.example/x.m3u8\n', 't')).toThrow(
      'unexpected variant',
    );
    expect(() => rewriteMaster('#EXTM3U\n../x/index.m3u8\n', 't')).toThrow('unexpected variant');
  });
});

describe('rewriteMedia', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x00',
    '#EXTINF:6.0,',
    'seg_0000.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  it('swaps the key URI and presigns every segment', async () => {
    const out = await rewriteMedia(playlist, 't', (file) => Promise.resolve(`https://s3/${file}`));
    expect(out).toContain('#EXT-X-KEY:METHOD=AES-128,URI="../key?token=t",IV=0x00');
    expect(out).toContain('https://s3/seg_0000.ts');
  });

  it('refuses a segment that is not a plain file name', async () => {
    await expect(
      rewriteMedia('#EXTM3U\n../../sources/x\n', 't', (f) => Promise.resolve(f)),
    ).rejects.toThrow('unexpected segment');
  });
});
