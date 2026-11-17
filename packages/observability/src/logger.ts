/**
 * Structured JSON logs (security plan C-34; architecture §7.6): one line per
 * entry on stdout, which the log shipper sends to Loki. Every entry passes
 * through {@link redact}, so a careless `logger.log(user)` cannot leak a
 * phone number or a token.
 *
 * It implements NestJS's LoggerService, so `app.useLogger(new JsonLogger())`
 * switches every `new Logger('Context')` in the code base to JSON.
 */
import { redact, redactText } from './redact';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const RANK: Record<LogLevel, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

export interface JsonLoggerOptions {
  /** `api` or `worker`; lets one Loki query span both. */
  service: string;
  level?: LogLevel;
  version?: string;
  /** Where lines go; stdout by default. */
  write?: (line: string) => void;
  now?: () => Date;
}

export class JsonLogger {
  private readonly min: number;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly options: JsonLoggerOptions) {
    this.min = RANK[options.level ?? 'info'];
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
  }

  isEnabled(level: LogLevel): boolean {
    return RANK[level] >= this.min;
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('info', message, rest);
  }

  /** Nest passes `(message, stack?, context?)`. */
  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest, true);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('trace', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit('fatal', message, rest, true);
  }

  /** A log line with fields, for code that is not a Nest logger call. */
  entry(
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown> = {},
    context?: string,
  ): void {
    if (!this.isEnabled(level)) return;
    this.print({ level, ...(context ? { context } : {}), msg, ...fields });
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[], withStack = false): void {
    if (!this.isEnabled(level)) return;
    const params = [...rest];
    // Nest's convention: a trailing string is the context name.
    const context =
      params.length > 0 && typeof params.at(-1) === 'string' ? (params.pop() as string) : undefined;
    let stack: string | undefined;
    if (withStack && typeof params[0] === 'string' && params[0].includes('\n')) {
      stack = params.shift() as string;
    }
    const fields: Record<string, unknown> = {};
    let msg: string;
    if (message instanceof Error) {
      msg = message.message;
      stack ??= message.stack;
    } else if (message !== null && typeof message === 'object') {
      const { msg: inner, message: alt, ...others } = message as Record<string, unknown>;
      msg = typeof inner === 'string' ? inner : typeof alt === 'string' ? alt : '';
      Object.assign(fields, others);
    } else {
      msg = String(message);
    }
    if (params.length > 0) fields.extra = params;
    this.print({
      level,
      ...(context ? { context } : {}),
      msg,
      ...fields,
      ...(stack ? { stack } : {}),
    });
  }

  private print(entry: Record<string, unknown>): void {
    const safe = redact(entry) as Record<string, unknown>;
    if (typeof safe.stack === 'string') safe.stack = redactText(safe.stack);
    this.write(
      JSON.stringify({
        time: this.now().toISOString(),
        service: this.options.service,
        ...(this.options.version ? { version: this.options.version } : {}),
        ...safe,
      }),
    );
  }
}
