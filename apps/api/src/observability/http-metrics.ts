/**
 * Request metrics and the request log (architecture §7.6; security plan C-34).
 *
 * Every request is counted and timed by route pattern (`/api/v1/children/:childId`,
 * never the URL itself, which would carry IDs and make a time series per
 * child). Only failed and slow requests get a log line: at peak traffic a
 * line per request would be millions a day with little to read, and the
 * metrics already count everything.
 */
import type { Metrics } from '@mathpath/observability';
import type { NextFunction, Request, Response } from 'express';

/** Requests slower than this are logged even when they succeed. */
const SLOW_MS = 1000;

export interface RequestLogger {
  entry(
    level: 'info' | 'warn' | 'error',
    msg: string,
    fields: Record<string, unknown>,
    context?: string,
  ): void;
}

/** The matched route pattern, or `unmatched` for 404s that hit no route. */
export function routeOf(req: Request): string {
  const route = (req as Request & { route?: { path?: unknown } }).route;
  return typeof route?.path === 'string' ? `${req.baseUrl}${route.path}` : 'unmatched';
}

export function httpMetrics(metrics: Metrics, log?: RequestLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeOf(req);
      const status = String(res.statusCode);
      metrics.httpRequests.inc({ method: req.method, route, status });
      metrics.httpDuration.observe({ method: req.method, route }, seconds);
      const ms = Math.round(seconds * 1000);
      if (log && (res.statusCode >= 400 || ms >= SLOW_MS)) {
        log.entry(
          res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
          ms >= SLOW_MS && res.statusCode < 400 ? 'slow request' : 'request failed',
          {
            method: req.method,
            route,
            status: res.statusCode,
            ms,
            requestId: (req as Request & { id?: string }).id,
          },
          'Http',
        );
      }
    });
    next();
  };
}
