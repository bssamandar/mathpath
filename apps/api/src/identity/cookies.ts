/**
 * Session cookies for the web apps (security plan C-07).
 *
 * - `__Host-` / `__Secure-` prefixes make the browser refuse cookies that are
 *   not Secure (and, for `__Host-`, any Domain attribute), so a sibling
 *   subdomain cannot plant or overwrite them.
 * - HttpOnly: JavaScript never sees a token, so XSS cannot steal one.
 * - The refresh cookie is sent only to the refresh endpoint, which keeps the
 *   long-lived token off every other request.
 * Browsers accept Secure cookies from http://localhost, so this works locally.
 */
import type { CookieOptions, Response } from 'express';
import type { IssuedSession } from './session.service';

export const ACCESS_COOKIE = '__Host-mp_at';
export const REFRESH_COOKIE = '__Secure-mp_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth/refresh';

const base: CookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' };

/** Sets both cookies for a newly issued or refreshed session. */
export function setSessionCookies(res: Response, session: IssuedSession, now: Date): void {
  res.cookie(ACCESS_COOKIE, session.accessToken, {
    ...base,
    path: '/',
    maxAge: session.accessExpiresAt.getTime() - now.getTime(),
  });
  res.cookie(REFRESH_COOKIE, session.refreshToken, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    maxAge: session.refreshExpiresAt.getTime() - now.getTime(),
  });
}

/** Removes both cookies (logout, or a refresh token that no longer works). */
export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
}
