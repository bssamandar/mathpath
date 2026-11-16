/**
 * Authentication, authorisation and CSRF for every request (C-07, C-08, C-09).
 *
 * Runs as a global guard:
 * 1. Reads the access token (Bearer header, else cookie) and drops it if the
 *    session was revoked.
 * 2. Enforces CSRF on cookie-authenticated, state-changing requests.
 * 3. Applies the route's {@link Access} declaration; undeclared routes are refused.
 *
 * CSRF (ADR-0010): a request authenticated by cookie and changing state must
 * send `X-CSRF-Token`, an HMAC of the session ID that the API returned at
 * sign-in. Another site can make the browser send our cookies, but cannot read
 * our responses (CORS), so it cannot know the token. Requests with a Bearer
 * header are not exposed to CSRF, because browsers never add that header by
 * themselves, and the cookie is ignored when a Bearer header is present.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ProblemException } from '../common/problem';
import { ACCESS_COOKIE } from './cookies';
import { ACCESS_METADATA, needsMfaFor, permissionsFor, type RouteAccess } from './permissions';
import { safeEqual } from './crypto';
import { RevokedSessions } from './revoked-sessions';
import { SessionService } from './session.service';
import { type AccessClaims, TokenService } from './token.service';

const SKIP_CSRF = 'mathpath:skip-csrf';

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
  private readonly logger = new Logger('AuthGuard');

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

    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ACCESS_METADATA, [
      handler,
      context.getClass(),
    ]);
    return this.authorise(access, claims, `${context.getClass().name}.${handler.name}`);
  }

  private authorise(
    access: RouteAccess | undefined,
    claims: AccessClaims | null,
    route: string,
  ): true {
    if (access === undefined) {
      // A programming mistake, caught by the route-scan test; fail closed in production.
      this.logger.error(`Route ${route} has no @Access declaration and was refused`);
      throw new ProblemException(403, 'FORBIDDEN', 'You do not have access to this action.');
    }
    if (access === 'public') return true;
    // Payment providers have no session: their adapter checks the provider's
    // own credentials or signature before reading the body (C-27).
    if (access.startsWith('provider:')) return true;
    if (!claims) throw new ProblemException(401, 'UNAUTHENTICATED', 'Please sign in.');
    if (access === 'authenticated') return true;
    if (permissionsFor(claims.roles, claims.mfaVerified).has(access)) return true;
    if (!claims.mfaVerified && needsMfaFor(claims.roles, access)) {
      throw new ProblemException(
        403,
        'MFA_REQUIRED',
        'Confirm your sign-in with your authenticator app.',
      );
    }
    throw new ProblemException(403, 'FORBIDDEN', 'You do not have access to this action.');
  }
}
