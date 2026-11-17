import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  currentSession,
  forgetSession,
  refreshSession,
  rememberSession,
  type SessionInfo,
} from './api';

/** A minimal localStorage, since tests run in Node. */
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const session: SessionInfo = {
  userId: 'u1',
  roles: ['parent'],
  mfaRequired: false,
  accessExpiresAt: '2026-11-16T10:15:00Z',
  csrfToken: 'csrf-1',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('sends JSON with the CSRF token on writes, not on reads', async () => {
    rememberSession(session);
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    await api('/children', { method: 'POST', body: { a: 1 } }, fetchMock);
    await api('/children', {}, fetchMock);
    const [postUrl, post] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, get] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(postUrl).toBe('/api/v1/children');
    expect(post.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
    expect(post.body).toBe('{"a":1}');
    expect(post.credentials).toBe('same-origin');
    expect(get.headers).not.toHaveProperty('X-CSRF-Token');
  });

  it('turns problem responses into ApiError with code, retry time and fields', async () => {
    const fetchMock = vi.fn(async () =>
      json(429, { code: 'TOO_MANY_REQUESTS', retryAfterS: 120, errors: [] }),
    );
    const error = (await api('/auth/otp', { method: 'POST' }, fetchMock).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'TOO_MANY_REQUESTS', retryAfterS: 120 });
  });

  it('reports a network failure as OFFLINE and a body without a code as UNKNOWN', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api('/x', {}, offline)).rejects.toMatchObject({ code: 'OFFLINE' });
    const html = vi.fn(async () => new Response('<html>', { status: 502 }));
    await expect(api('/x', {}, html)).rejects.toMatchObject({ status: 502, code: 'UNKNOWN' });
  });

  it('sends extra headers such as If-Match', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, {}));
    await api('/x', { method: 'PUT', body: {}, headers: { 'If-Match': '"e1"' } }, fetchImpl);
    expect(fetchImpl.mock.calls[0]![1].headers).toMatchObject({ 'If-Match': '"e1"' });
  });

  it('returns nothing for 204', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(api('/auth/logout', { method: 'POST' }, fetchMock)).resolves.toBeUndefined();
  });

  it('refreshes once on 401 and retries with the new CSRF token', async () => {
    rememberSession(session);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { code: 'UNAUTHENTICATED' }))
      .mockResolvedValueOnce(json(200, { ...session, csrfToken: 'csrf-2' }))
      .mockResolvedValueOnce(json(200, { done: true }));
    const result = await api<{ done: boolean }>('/children', { method: 'POST' }, fetchMock);
    expect(result).toEqual({ done: true });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/auth/refresh');
    expect((fetchMock.mock.calls[2]![1] as RequestInit).headers).toMatchObject({
      'X-CSRF-Token': 'csrf-2',
    });
  });

  it('does not refresh for sign-in calls', async () => {
    const fetchMock = vi.fn(async () => json(401, { code: 'INVALID_CREDENTIALS' }));
    await expect(
      api('/auth/login', { method: 'POST', noRefresh: true }, fetchMock),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forgets the session when the refresh is refused', async () => {
    rememberSession(session);
    const fetchMock = vi.fn(async () => json(401, { code: 'SESSION_EXPIRED' }));
    await expect(api('/children', {}, fetchMock)).rejects.toMatchObject({ status: 401 });
    expect(currentSession()).toBeNull();
  });
});

describe('refreshSession', () => {
  it('reuses a refresh another tab finished after the request started (C-06)', async () => {
    const fetchMock = vi.fn(async () => json(200, session));
    const before = Date.now() - 1000;
    expect(await refreshSession(before, fetchMock)).toBe(true);
    expect(await refreshSession(before, fetchMock)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runs inside the shared Web Lock when the browser has one', async () => {
    const request = vi.fn(async (_name: string, run: () => Promise<boolean>) => run());
    vi.stubGlobal('navigator', { locks: { request } });
    const fetchMock = vi.fn(async () => json(200, session));
    await refreshSession(Date.now(), fetchMock);
    expect(request).toHaveBeenCalledWith('mp-refresh', expect.any(Function));
  });

  it('reports failure when offline', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('offline');
    });
    expect(await refreshSession(Date.now(), offline)).toBe(false);
  });
});

describe('session memory', () => {
  it('remembers and forgets who is signed in', () => {
    rememberSession(session);
    expect(currentSession()).toEqual({ userId: 'u1', roles: ['parent'] });
    forgetSession();
    expect(currentSession()).toBeNull();
  });

  it('survives storage that throws or holds junk', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    });
    expect(() => rememberSession(session)).not.toThrow();
    expect(currentSession()).toBeNull();
    vi.stubGlobal('localStorage', new MemoryStorage());
    localStorage.setItem('mp_session', '{not json');
    expect(currentSession()).toBeNull();
  });
});
