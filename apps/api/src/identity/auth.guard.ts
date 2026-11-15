/**
 * Reads the caller's access token on every request and enforces CSRF.
 *
 * Runs as a global guard. It authenticates when a token is present and only
 * rejects when a handler is marked {@link Authenticated} (until the
 * permission guard in the next step makes "deny unless declared" the default,
 * C-09).
 *
 * CSRF (C-07): a request authenticated by cookie and changing state must send
 * `X-CSRF-Token`, an HMAC of the session ID that the API returned at sign-in.
 * Another site can make the browser send our cookies, but cannot read our
 * responses (CORS), so it cannot know the token. Requests with a Bearer header
 * are not exposed to CSRF, because browsers never add that header by themselves.
 *
 * Why an HMAC of the session ID and not the classic double-submit cookie: the
 * web app runs on a different origin from the API, so its JavaScript could
 * not read a cookie set by the API anyway.
 */
import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ProblemException } from '../common/problem';
import { ACCESS_COOKIE } from './cookies';
import { safeEqual } from './crypto';
import { RevokedSessions } from './revoked-sessions';
import { SessionService } from './session.service';
import { type AccessClaims, TokenService } from './token.service';

const AUTHENTICATED = 'mathpath:authenticated';
const SKIP_CSRF = 'mathpath:skip-csrf';

/** Marks a handler that needs a signed-in caller. */
export const Authenticated = (): MethodDecorator => SetMetadata(AUTHENTICATED, true);

/**
 * Exempts a handler from the CSRF check. Only for endpoints whose response a
 * cross-site attacker cannot use: refresh rotates a token the attacker cannot
 * read, and SameSite=Lax already keeps the cookie off cross-site POSTs.
 */
export const SkipCsrf = (): MethodDecorator => SetMetadata(SKIP_CSRF, true);

/** A request after the guard ran. */
export type AuthedRequest = Request & { auth?: AccessClaims };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly revoked: RevokedSessions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const handler = context.getHandler();

    const header = req.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const token = bearer ?? cookies[ACCESS_COOKIE];

    let claims = token ? await this.tokens.verifyAccess(token) : null;
    if (claims && (await this.revoked.has(claims.sessionId))) claims = null;
    if (claims) req.auth = claims;

    const viaCookie = claims !== null && bearer === undefined;
    if (
      viaCookie &&
      !SAFE_METHODS.has(req.method) &&
      !this.reflector.get<boolean>(SKIP_CSRF, handler)
    ) {
      const sent = req.get('x-csrf-token') ?? '';
      if (!safeEqual(sent, this.sessions.csrfToken(claims!.sessionId))) {
        throw new ProblemException(403, 'CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token.');
      }
    }

    if (this.reflector.get<boolean>(AUTHENTICATED, handler) && !claims) {
      throw new ProblemException(401, 'UNAUTHENTICATED', 'Please sign in.');
    }
    return true;
  }
}
