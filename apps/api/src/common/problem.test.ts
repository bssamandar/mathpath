import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ProblemFilter, problemType } from './problem';

function hostFor(id?: string) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ id }), getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe('ProblemFilter', () => {
  it('hides the message of unexpected errors', () => {
    const { host, res } = hostFor('req-1');
    const filter = new ProblemFilter();
    vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    filter.catch(new Error('database password is hunter2'), host);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR', requestId: 'req-1' });
  });

  it('maps Nest HTTP exceptions to a problem with the status name as code', () => {
    const { host, res } = hostFor();
    new ProblemFilter().catch(new BadRequestException('bad'), host);
    expect(res.body).toMatchObject({ status: 400, code: 'BAD_REQUEST', requestId: 'unknown' });
  });

  it('builds documentation links from codes', () => {
    expect(problemType('OTP_EXPIRED')).toBe('https://docs.mathpath.uz/errors/otp-expired');
  });
});
