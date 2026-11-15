import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { ProblemFilter } from './common/problem';
import type { Env } from './config/env';
import { ENV } from './config/tokens';

/** All public routes live under this prefix (see docs/api/openapi.yaml). */
export const API_PREFIX = 'api/v1';

/**
 * Applies the HTTP-level settings shared by production and tests, so the
 * security headers we test are exactly the ones we ship.
 *
 * @param app - A freshly created Nest application (Express adapter).
 * @returns The same application, configured.
 */
export function configureApp(app: NestExpressApplication): INestApplication {
  const env = app.get<Env>(ENV);

  app.setGlobalPrefix(API_PREFIX);
  // Do not advertise the framework (fingerprinting aid for attackers).
  app.disable('x-powered-by');
  // Only trust X-Forwarded-For from our own proxies (see TRUST_PROXY_HOPS).
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  // A fresh ID per request, returned to the client and put in error bodies,
  // so a user's report can be matched to the logs. Client-sent IDs are
  // ignored because they could be used to forge log entries.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = randomUUID();
    (req as Request & { id: string }).id = id;
    res.setHeader('X-Request-Id', id);
    next();
  });
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemFilter());
  // Security headers (security plan C-15). The API serves JSON only, so its
  // CSP can be the strictest possible; the web apps set their own policies.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  // Credentials (cookies) are only accepted from our own front-end origins.
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.enableShutdownHooks();
  return app;
}
