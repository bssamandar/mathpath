import { describe, expect, it, vi } from 'vitest';
import { type MediaAsset, uploadMedia, type UploadDeps, waitUntilReady } from './upload';

const asset = (status: MediaAsset['status']): MediaAsset => ({
  id: 'm1',
  kind: 'video',
  status,
  contentType: 'video/mp4',
  sizeBytes: 10,
  locale: null,
  videoId: null,
  durationS: null,
  renditions: [],
  error: null,
  previewUrl: null,
});

function deps(responses: unknown[]): UploadDeps & { calls: [string, unknown][]; sleeps: number[] } {
  const calls: [string, unknown][] = [];
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    call: (async (path: string, options?: unknown) => {
      calls.push([path, options]);
      return responses.shift();
    }) as UploadDeps['call'],
    put: vi.fn(async (_url, _file, onProgress) => onProgress(1)),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

describe('uploadMedia', () => {
  it('asks for a slot, sends the bytes, then completes', async () => {
    const d = deps([{ mediaId: 'm1', uploadUrl: 'https://s3/put' }, asset('uploaded')]);
    const progress: number[] = [];
    const file = { type: 'video/mp4', size: 10 };
    const result = await uploadMedia({ kind: 'video', file }, (p) => progress.push(p), d);

    expect(result.status).toBe('uploaded');
    expect(d.calls[0]).toEqual([
      '/studio/media/uploads',
      { method: 'POST', body: { kind: 'video', contentType: 'video/mp4', sizeBytes: 10 } },
    ]);
    expect(d.put).toHaveBeenCalledWith('https://s3/put', file, expect.any(Function));
    expect(d.calls[1]).toEqual(['/studio/media/m1/complete', { method: 'POST' }]);
    expect(progress).toEqual([1]);
  });

  it('sends the language and video of a subtitle', async () => {
    const d = deps([{ mediaId: 's1', uploadUrl: 'u' }, asset('ready')]);
    await uploadMedia(
      { kind: 'subtitle', file: { type: 'text/vtt', size: 3 }, locale: 'ru', videoId: 'm1' },
      () => undefined,
      d,
    );
    expect(d.calls[0]![1]).toMatchObject({ body: { locale: 'ru', videoId: 'm1' } });
  });
});

describe('waitUntilReady', () => {
  it('polls with a growing delay until the video is ready', async () => {
    const d = deps([asset('uploaded'), asset('processing'), asset('processing'), asset('ready')]);
    const seen: string[] = [];
    const result = await waitUntilReady('m1', (a) => seen.push(a.status), d);
    expect(result.status).toBe('ready');
    expect(seen).toEqual(['uploaded', 'processing', 'processing', 'ready']);
    expect(d.sleeps).toEqual([2000, 3000, 4500]);
  });

  it('stops on failure', async () => {
    const d = deps([asset('failed')]);
    expect((await waitUntilReady('m1', () => undefined, d)).status).toBe('failed');
  });

  it('gives up after the time limit with the last status', async () => {
    const d = deps(Array.from({ length: 50 }, () => asset('processing')));
    const result = await waitUntilReady('m1', () => undefined, d, 5000);
    expect(result.status).toBe('processing');
    expect(d.sleeps).toEqual([2000, 3000]);
  });

  it('caps the delay at 15 seconds', async () => {
    const d = deps([...Array.from({ length: 10 }, () => asset('processing')), asset('ready')]);
    await waitUntilReady('m1', () => undefined, d);
    expect(Math.max(...d.sleeps)).toBe(15_000);
  });
});

describe('xhrPut', () => {
  class FakeXhr {
    static status = 200;
    static fail = false;
    status = 0;
    headers: Record<string, string> = {};
    upload: {
      onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void;
    } = {};
    onload?: () => void;
    onerror?: () => void;
    open = vi.fn();
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send() {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
      if (FakeXhr.fail) return this.onerror?.();
      this.status = FakeXhr.status;
      this.onload?.();
    }
  }

  it('reports progress and settles on the status', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { xhrPut } = await import('./upload');
    const progress: number[] = [];
    const file = new Blob(['x'], { type: 'video/mp4' });
    await xhrPut('https://s3/put', file, (p) => progress.push(p));
    expect(progress).toEqual([0.5]);

    FakeXhr.status = 403;
    await expect(xhrPut('u', file, () => undefined)).rejects.toThrow('403');
    FakeXhr.fail = true;
    await expect(xhrPut('u', file, () => undefined)).rejects.toThrow('upload failed');
    vi.unstubAllGlobals();
  });
});
