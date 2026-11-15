/**
 * Error responses as RFC 9457 problem details (docs/api/openapi.yaml `Problem`).
 *
 * Every error leaves the API in one shape with a stable machine `code`, so
 * clients can show a translated message without parsing English text, and
 * with the request ID that support can look up in the logs.
 */
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** One field-level validation error. */
export interface FieldError {
  field: string;
  message: string;
}

/** An error with a stable code that is safe to show to the client. */
export class ProblemException extends Error {
  /**
   * @param status - HTTP status code.
   * @param code - Stable machine code in UPPER_SNAKE_CASE, for example `OTP_EXPIRED`.
   * @param title - Short English summary for developers; clients translate `code`.
   * @param extra - Optional field errors and a `Retry-After` value in seconds.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly extra: { errors?: FieldError[]; retryAfterS?: number } = {},
  ) {
    super(title);
    this.name = 'ProblemException';
  }
}

/** Builds the `type` URI for a code: `OTP_EXPIRED` → `.../errors/otp-expired`. */
export function problemType(code: string): string {
  return `https://docs.mathpath.uz/errors/${code.toLowerCase().replaceAll('_', '-')}`;
}

/** Reads the request ID assigned by the request-ID middleware. */
export function requestIdOf(req: Request): string {
  return (req as Request & { id?: string }).id ?? 'unknown';
}

/**
 * Converts every thrown error into a problem response.
 *
 * Unknown errors become a generic 500 and are logged with their stack; their
 * message is never sent to the client because it may contain internals.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = requestIdOf(req);

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let title = 'Something went wrong. Please try again.';
    let extra: ProblemException['extra'] = {};

    if (error instanceof ProblemException) {
      ({ status, code, title, extra } = error);
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = (HttpStatus[status] as string | undefined) ?? 'HTTP_ERROR';
      title = error.message;
    } else {
      this.logger.error(`Unhandled error (request ${requestId})`, (error as Error)?.stack);
    }

    if (extra.retryAfterS !== undefined) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(extra.retryAfterS))));
    }
    res
      .status(status)
      .type('application/problem+json')
      .json({
        type: problemType(code),
        title,
        status,
        code,
        requestId,
        ...(extra.errors ? { errors: extra.errors } : {}),
      });
  }
}
