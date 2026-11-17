import { describe, expect, it } from 'vitest';
import { JsonLogger } from './logger';

function capture(level?: 'info' | 'debug' | 'warn') {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger({
    service: 'api',
    version: '1.2.3',
    level,
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date('2026-11-17T02:00:00Z'),
  });
  return { logger, lines };
}

describe('JsonLogger', () => {
  it('writes one JSON line with time, service, level, context and message', () => {
    const { logger, lines } = capture();
    logger.log('API listening on port 4000', 'Bootstrap');
    expect(lines).toEqual([
      {
        time: '2026-11-17T02:00:00.000Z',
        service: 'api',
        version: '1.2.3',
        level: 'info',
        context: 'Bootstrap',
        msg: 'API listening on port 4000',
      },
    ]);
  });

  it('redacts messages, fields and stacks', () => {
    const { logger, lines } = capture();
    logger.warn(
      { msg: 'login failed for +998901234567', phone: '+998901234567', attempts: 3 },
      'Auth',
    );
    logger.error('send failed', 'Error: to +998901234567\n    at x', 'Sms');
    expect(lines[0]).toMatchObject({
      level: 'warn',
      context: 'Auth',
      msg: 'login failed for +99890*****67',
      phone: '[redacted]',
      attempts: 3,
    });
    expect(lines[1]).toMatchObject({ level: 'error', context: 'Sms', msg: 'send failed' });
    expect(lines[1]!.stack).toContain('+99890*****67');
    expect(JSON.stringify(lines)).not.toContain('1234567');
  });

  it('takes an Error as the message, keeps extra params, and maps Nest levels', () => {
    const { logger, lines } = capture('debug');
    logger.error(new Error('boom'));
    logger.debug('details', { a: 1 }, 'Ctx');
    logger.verbose('too fine');
    logger.fatal('down', 'Main');
    logger.entry('info', 'request', { status: 500, route: '/x' }, 'Http');
    logger.entry('trace', 'skipped');
    expect(lines.map((l) => l.level)).toEqual(['error', 'debug', 'fatal', 'info']);
    expect(lines[0]).toMatchObject({ msg: 'boom', stack: expect.stringContaining('Error: boom') });
    expect(lines[1]).toMatchObject({ msg: 'details', context: 'Ctx', extra: [{ a: 1 }] });
    expect(lines[3]).toMatchObject({ msg: 'request', status: 500, context: 'Http' });
  });

  it('drops entries below the level', () => {
    const { logger, lines } = capture('warn');
    logger.log('hidden');
    logger.debug('hidden');
    logger.warn({ message: 'shown' });
    expect(lines).toEqual([expect.objectContaining({ msg: 'shown', level: 'warn' })]);
    expect(logger.isEnabled('error')).toBe(true);
    expect(logger.isEnabled('info')).toBe(false);
  });
});
