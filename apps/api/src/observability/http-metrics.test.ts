import { EventEmitter } from 'node:events';
import { createMetrics } from '@mathpath/observability';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { httpMetrics, routeOf } from './http-metrics';

function call(status: number, route?: string, delayMs = 0) {
  const metrics = createMetrics('test');
  const log = { entry: vi.fn() };
  const req = {
    method: 'POST',
    baseUrl: '',
    id: 'req-1',
    ...(route ? { route: { path: route } } : {}),
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), { statusCode: status }) as unknown as Response;
  const next = vi.fn() as NextFunction;
  const now = vi.spyOn(process.hrtime, 'bigint');
  now.mockReturnValueOnce(0n).mockReturnValueOnce(BigInt(delayMs) * 1_000_000n);
  httpMetrics(metrics, log)(req, res, next);
  (res as unknown as EventEmitter).emit('finish');
  now.mockRestore();
  return { log, next };
}

describe('httpMetrics', () => {
  it('logs failed and slow requests only, with the request ID', () => {
    expect(call(200, '/api/v1/x', 20).log.entry).not.toHaveBeenCalled();
    expect(call(201, '/api/v1/x', 1500).log.entry).toHaveBeenCalledWith(
      'info',
      'slow request',
      { method: 'POST', route: '/api/v1/x', status: 201, ms: 1500, requestId: 'req-1' },
      'Http',
    );
    expect(call(422, '/api/v1/x').log.entry.mock.calls[0]?.[0]).toBe('warn');
    const failed = call(503);
    expect(failed.log.entry.mock.calls[0]?.slice(0, 2)).toEqual(['error', 'request failed']);
    expect(failed.next).toHaveBeenCalled();
  });

  it('names unmatched requests instead of using the URL', () => {
    expect(routeOf({ baseUrl: '' } as Request)).toBe('unmatched');
    expect(routeOf({ baseUrl: '/api', route: { path: '/x/:id' } } as unknown as Request)).toBe(
      '/api/x/:id',
    );
  });
});
