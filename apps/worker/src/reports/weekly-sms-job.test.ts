import { randomUUID } from 'node:crypto';
import type { ReportRecipient } from '@mathpath/db';
import { SmsSender } from '@mathpath/sms';
import { QueueEvents } from 'bullmq';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { TASHKENT } from '../schedule';
import {
  describeWeeklySms,
  insideWindow,
  sendWeeklyReports,
  startWeeklySms,
  tashkentClock,
  WEEKLY_SMS_QUEUE,
  type WeeklySmsDeps,
  weeklySmsPattern,
} from './weekly-sms-job';

const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
const rules = {
  audience: 'subscribers' as const,
  sendAt: '19:00',
  stopAt: '21:00',
  maxPerRun: 100,
  concurrency: 2,
};
// Sunday 2026-12-06: 19:00 Tashkent is 14:00 UTC.
const SUNDAY_1930 = new Date('2026-12-06T14:30:00Z');

class FakeSender extends SmsSender {
  sent: { phone: string; text: string }[] = [];
  failFor = new Set<string>();
  send(phone: string, text: string) {
    if (this.failFor.has(phone)) return Promise.reject(new Error('Eskiz refused: HTTP 500'));
    this.sent.push({ phone, text });
    return Promise.resolve({ messageId: null });
  }
}

function recipient(n: number): ReportRecipient {
  return {
    parentId: `p${n}`,
    phone: `+99890000000${n}`,
    locale: 'uz-Latn',
    children: [{ name: `Bola${n}`, minutes: 30, questions: 20, mastered: 1 }],
  };
}

function deps(overrides: Partial<WeeklySmsDeps> = {}) {
  const sender = new FakeSender();
  const claimed = new Set<string>();
  const finished: unknown[] = [];
  const base: WeeklySmsDeps = {
    rules,
    sender,
    link: 'https://mathpath.uz/parent',
    now: () => SUNDAY_1930,
    recipients: vi.fn(() => Promise.resolve([1, 2, 3].map(recipient))),
    claim: (parentId) => {
      if (claimed.has(parentId)) return Promise.resolve(false);
      claimed.add(parentId);
      return Promise.resolve(true);
    },
    finish: (parentId, week, outcome) => {
      finished.push({ parentId, week, ...outcome });
      return Promise.resolve();
    },
    onOutcome: vi.fn(),
    warn: vi.fn(),
  };
  return { deps: { ...base, ...overrides }, sender, claimed, finished };
}

describe('the send window', () => {
  it('is Sunday from sendAt until before stopAt, in Tashkent time', () => {
    expect(tashkentClock(SUNDAY_1930)).toEqual({ weekday: 0, time: '19:30' });
    expect(insideWindow(rules, new Date('2026-12-06T13:59:00Z'))).toBe(false); // 18:59
    expect(insideWindow(rules, new Date('2026-12-06T14:00:00Z'))).toBe(true); // 19:00
    expect(insideWindow(rules, new Date('2026-12-06T15:59:00Z'))).toBe(true); // 20:59
    expect(insideWindow(rules, new Date('2026-12-06T16:00:00Z'))).toBe(false); // 21:00
    expect(insideWindow(rules, new Date('2026-12-07T14:30:00Z'))).toBe(false); // Monday
    expect(weeklySmsPattern('19:05')).toBe('5 19 * * 0');
  });
});

describe('sendWeeklyReports', () => {
  it('sends one SMS per parent for this week and records each', async () => {
    const { deps: d, sender, finished } = deps();
    const result = await sendWeeklyReports(d);
    expect(result).toEqual({ week: '2026-11-30', sent: 3, failed: 0, skipped: 0, late: 0 });
    expect(d.recipients).toHaveBeenCalledWith('2026-11-30', 100);
    expect(sender.sent.map((s) => s.phone).sort()).toEqual(
      [1, 2, 3].map((n) => recipient(n).phone),
    );
    expect(sender.sent[0]!.text).toContain('https://mathpath.uz/parent');
    expect(finished).toHaveLength(3);
    expect(d.onOutcome).toHaveBeenCalledTimes(3);
  });

  it('does not send twice when run again, and records a failure without retrying', async () => {
    const { deps: d, sender, finished } = deps();
    sender.failFor.add(recipient(2).phone);
    expect(await sendWeeklyReports(d)).toMatchObject({ sent: 2, failed: 1 });
    expect(finished).toContainEqual({
      parentId: 'p2',
      week: '2026-11-30',
      ok: false,
      failure: 'Eskiz refused: HTTP 500',
    });
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('+99890*****02'));
    expect(d.warn).not.toHaveBeenCalledWith(expect.stringContaining(recipient(2).phone));
    expect(await sendWeeklyReports(d)).toMatchObject({ sent: 0, failed: 0, skipped: 3 });
    expect(sender.sent).toHaveLength(2);
  });

  it('stays quiet outside the window or when the audience is off', async () => {
    const monday = deps({ now: () => new Date('2026-12-07T14:30:00Z') });
    expect(await sendWeeklyReports(monday.deps)).toMatchObject({ week: null, sent: 0 });
    expect(monday.deps.recipients).not.toHaveBeenCalled();
    const off = deps({ rules: { ...rules, audience: 'off' } });
    expect(await sendWeeklyReports(off.deps)).toMatchObject({ week: null });
    expect(describeWeeklySms(await sendWeeklyReports(off.deps))).toBeUndefined();
  });

  it('stops when the window closes during the run', async () => {
    let calls = 0;
    // The first check opens the run; the window closes after the first message.
    const { deps: d, sender } = deps({
      rules: { ...rules, concurrency: 1 },
      now: () => (calls++ < 3 ? SUNDAY_1930 : new Date('2026-12-06T16:00:00Z')),
    });
    const result = await sendWeeklyReports(d);
    expect(result).toMatchObject({ sent: 1, late: 2 });
    expect(sender.sent).toHaveLength(1);
    expect(describeWeeklySms(result)).toBe(
      'weekly report SMS for 2026-11-30: sent 1, failed 0, already sent 0, left after the window 2',
    );
  });
});

describe('startWeeklySms', () => {
  const prefix = `test:${randomUUID()}`;
  const events = new QueueEvents(WEEKLY_SMS_QUEUE, { connection: { url }, prefix });
  afterAll(async () => {
    await events.close();
  });

  it('runs once at start and schedules Sunday sendAt in Tashkent', async () => {
    await events.waitUntilReady();
    const finished = new Promise((resolve) => events.once('completed', resolve));
    const onRun = vi.fn();
    const { deps: d } = deps();
    const job = await startWeeklySms(d, { onRun }, { redisUrl: url, prefix });
    await finished;
    expect(onRun).toHaveBeenCalledOnce();
    expect(await job.queue.getJobSchedulers()).toEqual([
      expect.objectContaining({ pattern: '0 19 * * 0', tz: TASHKENT }),
    ]);
    await job.queue.obliterate({ force: true });
    await job.stop();
  });
});
