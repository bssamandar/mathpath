/**
 * HTTP helpers shared by every controller that starts a session or needs
 * facts about the client.
 */
import type { Request, Response } from 'express';
import { ipPrefix, looksAutomated, userAgentSummary } from '../common/client-info';
import { requestIdOf } from '../common/problem';
import { setSessionCookies } from './cookies';
import type { ClientContext, IssuedSession } from './session.service';

/** The `SessionInfo` response body. */
export interface SessionInfo {
  userId: string;
  roles: string[];
  mfaRequired: boolean;
  accessExpiresAt: string;
  csrfToken: string;
  accessToken?: string;
  refreshToken?: string;
}

/**
 * Hands a new session to the client: cookies for browsers, tokens in the
 * body for native apps (`X-Client-Type: mobile`), which keep them in the
 * device's secure storage.
 */
export function sendSession(
  req: Request,
  res: Response,
  session: IssuedSession,
  now: Date,
): SessionInfo {
  const info: SessionInfo = {
    userId: session.userId,
    roles: session.roles,
    mfaRequired: session.mfaRequired,
    accessExpiresAt: session.accessExpiresAt.toISOString(),
    csrfToken: session.csrfToken,
  };
  if (req.get('x-client-type') === 'mobile') {
    return { ...info, accessToken: session.accessToken, refreshToken: session.refreshToken };
  }
  setSessionCookies(res, session, now);
  return info;
}

/** Coarse, minimised facts about the caller (see common/client-info.ts). */
export function clientOf(req: Request): ClientContext {
  return {
    ipPrefix: ipPrefix(req.ip),
    userAgentSummary: userAgentSummary(req.get('user-agent')),
    requestId: requestIdOf(req),
    automationSuspected: looksAutomated(req.get('user-agent')),
  };
}
