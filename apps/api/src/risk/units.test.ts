import { loadConfig } from '@mathpath/config';
import { describe, expect, it, vi } from 'vitest';
import { looksAutomated } from '../common/client-info';
import { Clock } from '../common/clock';
import { MemoryCounterStore } from '../common/counter-store';
import { parseEnv } from '../config/env';
import { EskizSmsSender } from '../identity/sms/eskiz-sms-sender';
import { DevCaptchaVerifier, TurnstileCaptchaVerifier } from './captcha';
import { SmsBudget } from './sms-budget';

class FixedClock extends Clock {
  constructor(public time = Date.parse('2026-11-15T18:59:00Z')) {
    super();
  }
  now(): Date {
    return new Date(this.time);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('SmsBudget', () => {
  const rules = { hourlyCapTiyin: 300, dailyCapTiyin: 1000, costPerSmsTiyin: 100, alertRatio: 0.7 };

  it('alerts once at the alert level and once at the cap, then reports exhaustion', async () => {
    const budget = new SmsBudget(new MemoryCounterStore(new FixedClock()), new FixedClock(), rules);
    const error = vi.spyOn(budget['logger'], 'error').mockImplementation(() => undefined);
    await budget.spend();
    await budget.spend();
    expect(error).not.toHaveBeenCalled();
    expect(await budget.exhausted()).toBe(false);
    await budget.spend(); // 300 of 300: crosses 70% (210) and 100% hourly
    expect(error).toHaveBeenCalledTimes(2);
    expect(await budget.exhausted()).toBe(true);
  });

  it('counts days and hours in Tashkent time', async () => {
    const clock = new FixedClock(); // 18:59 UTC = 23:59 in Tashkent
    const counters = new MemoryCounterStore(clock);
    const budget = new SmsBudget(counters, clock, rules);
    await budget.spend();
    expect(await counters.get('sms:day:2026-11-15')).toBe(100);
    clock.time += 2 * 60_000; // 00:01 in Tashkent: a new day
    await budget.spend();
    expect(await counters.get('sms:day:2026-11-16')).toBe(100);
  });
});

describe('CAPTCHA verifiers', () => {
  it('accepts only the fixed token in development', async () => {
    expect(await new DevCaptchaVerifier().verify('dev-pass')).toBe(true);
    expect(await new DevCaptchaVerifier().verify('anything')).toBe(false);
  });

  it('asks Turnstile without sending the user IP', async () => {
    const fetchFn = vi.fn(async () => json({ success: true }));
    const verifier = new TurnstileCaptchaVerifier('secret', fetchFn as unknown as typeof fetch);
    expect(await verifier.verify('token')).toBe(true);
    const body = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
      .body as URLSearchParams;
    expect(body.get('response')).toBe('token');
    expect(body.has('remoteip')).toBe(false);
  });

  it('fails closed when Turnstile says no or cannot be reached', async () => {
    const no = new TurnstileCaptchaVerifier('s', (async () =>
      json({ success: false })) as typeof fetch);
    expect(await no.verify('t')).toBe(false);
    const down = new TurnstileCaptchaVerifier('s', (async () => json({}, 500)) as typeof fetch);
    vi.spyOn(down['logger'], 'warn').mockImplementation(() => undefined);
    expect(await down.verify('t')).toBe(false);
  });
});

describe('EskizSmsSender', () => {
  function fakeEskiz(sendStatuses: number[]) {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/auth/login')) return json({ data: { token: `t${calls.length}` } });
      const form = init.body as FormData;
      expect(form.get('mobile_phone')).toBe('998901234567');
      const status = sendStatuses.shift() ?? 200;
      return status === 200 ? json({ id: 'msg-1', status: 'waiting' }) : json({}, status);
    });
    const sender = new EskizSmsSender({
      email: 'e@example.com',
      password: 'p',
      sender: '4546',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    vi.spyOn(sender['logger'], 'log').mockImplementation(() => undefined);
    return { sender, calls };
  }

  it('logs in once and reuses the token', async () => {
    const { sender, calls } = fakeEskiz([]);
    expect(await sender.send('+998901234567', 'hi')).toEqual({ messageId: 'msg-1' });
    await sender.send('+998901234567', 'hi');
    expect(calls.filter((c) => c.endsWith('/auth/login'))).toHaveLength(1);
  });

  it('logs in again when the token has expired', async () => {
    const { sender, calls } = fakeEskiz([401, 200]);
    await sender.send('+998901234567', 'hi');
    expect(calls.filter((c) => c.endsWith('/auth/login'))).toHaveLength(2);
  });

  it('reports a refused message', async () => {
    const { sender } = fakeEskiz([400]);
    await expect(sender.send('+998901234567', 'hi')).rejects.toThrow(/HTTP 400/);
  });

  it('reports a failed login and retries it next time', async () => {
    let attempt = 0;
    const fetchFn = (async () =>
      ++attempt === 1 ? json({}, 401) : json({ data: {} })) as typeof fetch;
    const sender = new EskizSmsSender({ email: 'e', password: 'p', sender: 'x', fetchFn });
    await expect(sender.send('+998901234567', 'hi')).rejects.toThrow(/login failed/);
    await expect(sender.send('+998901234567', 'hi')).rejects.toThrow(/no token/);
  });
});

describe('looksAutomated', () => {
  it('flags scripts, headless browsers and a missing user agent', () => {
    expect(looksAutomated(undefined)).toBe(true);
    expect(looksAutomated('curl/8.5.0')).toBe(true);
    expect(looksAutomated('Mozilla/5.0 HeadlessChrome/130.0')).toBe(true);
    expect(
      looksAutomated('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36'),
    ).toBe(false);
  });
});

describe('environment rules for risk and SMS', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost/db' };

  it('requires provider credentials for Eskiz and Turnstile', () => {
    expect(() => parseEnv({ ...base, SMS_PROVIDER: 'eskiz' })).toThrow(/ESKIZ_EMAIL/);
    expect(() => parseEnv({ ...base, CAPTCHA_PROVIDER: 'turnstile' })).toThrow(
      /TURNSTILE_SECRET_KEY/,
    );
  });

  it('requires Redis and a real CAPTCHA in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /REDIS_URL[\s\S]*|CAPTCHA_PROVIDER/,
    );
    let message = '';
    try {
      parseEnv({ ...base, NODE_ENV: 'production' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/REDIS_URL/);
    expect(message).toMatch(/CAPTCHA_PROVIDER/);
  });

  it('keeps the committed config valid', () => {
    expect(loadConfig().risk.smsBudget.costPerSmsTiyin).toBeGreaterThan(0);
  });
});
