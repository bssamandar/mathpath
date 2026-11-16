/**
 * Browser client for the MathPath API.
 *
 * Tokens live only in HttpOnly cookies set by the API (ADR-0005); this code
 * never sees them. It keeps the CSRF token (an HMAC of the session ID, ADR-0010)
 * and sends it on every state-changing request.
 *
 * A refresh token can be used once, and presenting a used one revokes the
 * session (C-06). So refreshes are serialised across all tabs with the Web
 * Locks API, and a tab that waited for the lock reuses the refresh another
 * tab just did instead of sending its own.
 */

/** Same origin: Next.js forwards /api to the API, so cookies stay first-party. */
export const API_BASE = '/api/v1';

const CSRF_KEY = 'mp_csrf';
const SESSION_KEY = 'mp_session';
const REFRESHED_AT_KEY = 'mp_refreshed_at';
const REFRESH_LOCK = 'mp-refresh';

/** The `SessionInfo` response body (docs/api/openapi.yaml). */
export interface SessionInfo {
  userId: string;
  roles: string[];
  mfaRequired: boolean;
  accessExpiresAt: string;
  csrfToken: string;
}

/** An RFC 9457 problem from the API, or OFFLINE when the request did not get through. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterS?: number,
    readonly fields: { field: string; message: string }[] = [],
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/** Storage can throw in private mode or when blocked; the app still works for this tab. */
const store = {
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) globalThis.localStorage?.removeItem(key);
      else globalThis.localStorage?.setItem(key, value);
    } catch {
      // Not persisted; the next refresh returns a fresh CSRF token anyway.
    }
  },
};

/** Remembers a new session (CSRF token and who is signed in). */
export function rememberSession(session: SessionInfo): void {
  store.set(CSRF_KEY, session.csrfToken);
  store.set(SESSION_KEY, JSON.stringify({ userId: session.userId, roles: session.roles }));
}

export function forgetSession(): void {
  store.set(CSRF_KEY, null);
  store.set(SESSION_KEY, null);
}

/** Who is signed in on this device, as far as this browser knows. */
export function currentSession(): { userId: string; roles: string[] } | null {
  const raw = store.get(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { userId: string; roles: string[] };
  } catch {
    return null;
  }
}

/** Where a newly signed-in user starts. */
export function homeFor(roles: readonly string[]): string {
  return roles.includes('student') && !roles.includes('parent') ? '/student' : '/parent';
}

type Fetch = typeof fetch;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Do not try a refresh on 401 (sign-in and refresh calls themselves). */
  noRefresh?: boolean;
}

/**
 * Calls the API and returns the parsed JSON body.
 * @throws ApiError for any non-2xx response and for network failures.
 */
export async function api<T>(
  path: string,
  options: RequestOptions = {},
  fetchImpl: Fetch = fetch,
): Promise<T> {
  const startedAt = Date.now();
  let response = await send(path, options, fetchImpl);
  if (response.status === 401 && !options.noRefresh) {
    const refreshed = await refreshSession(startedAt, fetchImpl);
    if (refreshed) response = await send(path, options, fetchImpl);
  }
  return parse<T>(response);
}

async function send(path: string, options: RequestOptions, fetchImpl: Fetch): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const csrf = store.get(CSRF_KEY);
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  try {
    return await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'OFFLINE');
  }
}

async function parse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return body as T;
  throw new ApiError(
    response.status,
    typeof body?.code === 'string' ? body.code : 'UNKNOWN',
    typeof body?.retryAfterS === 'number' ? body.retryAfterS : undefined,
    Array.isArray(body?.errors) ? (body.errors as { field: string; message: string }[]) : [],
  );
}

/**
 * Refreshes the session once for all tabs.
 * @param since - When the failed request started; a refresh after that already helps it.
 * @returns True when the caller should retry.
 */
export async function refreshSession(since: number, fetchImpl: Fetch = fetch): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    if (Number(store.get(REFRESHED_AT_KEY) ?? 0) > since) return true;
    let response: Response;
    try {
      response = await fetchImpl(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });
    } catch {
      return false;
    }
    if (!response.ok) {
      forgetSession();
      return false;
    }
    rememberSession((await response.json()) as SessionInfo);
    store.set(REFRESHED_AT_KEY, String(Date.now()));
    return true;
  };
  const locks = globalThis.navigator?.locks;
  // Every browser we support has Web Locks; without it one tab still works.
  return locks ? locks.request(REFRESH_LOCK, run) : run();
}
