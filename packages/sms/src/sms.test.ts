import { describe, expect, it, vi } from 'vitest';
import { EskizSmsSender, LogSmsSender, maskPhone, smsMessages } from './index';

describe('maskPhone', () => {
  it('keeps the country and operator code and the last two digits', () => {
    expect(maskPhone('+998901234567')).toBe('+99890*****67');
    expect(maskPhone('+12345')).toBe('***');
  });
});

describe('LogSmsSender', () => {
  it('writes the masked number and the text', async () => {
    const log = vi.fn();
    await expect(new LogSmsSender(log).send('+998901234567', 'Salom')).resolves.toEqual({
      messageId: null,
    });
    expect(log).toHaveBeenCalledWith('To +99890*****67: Salom');
  });
});

describe('weekly report SMS', () => {
  const aziza = { name: 'Aziza', minutes: 95, questions: 120, mastered: 2 };
  const bobur = { name: 'Bobur', minutes: 40, questions: 30, mastered: 0 };
  const link = 'https://mathpath.example/parent';

  it('describes one child in a sentence, in GSM-7 for Uzbek', () => {
    const text = smsMessages.weeklyReport('uz-Latn', [aziza], link);
    expect(text).toBe(
      "MathPath haftalik hisobot: Aziza bu hafta 95 daq. mashq qildi, 120 ta savol, 2 mavzuni o'zlashtirdi. Batafsil: https://mathpath.example/parent",
    );
    expect(text.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
    expect(smsMessages.weeklyReport('uz-Latn', [bobur], link)).toContain('30 ta savol. Batafsil');
  });

  it('lists two children and counts the rest', () => {
    const third = { ...bobur, name: 'Dilya' };
    expect(smsMessages.weeklyReport('uz-Latn', [aziza, bobur, third], link)).toBe(
      'MathPath haftalik hisobot: Aziza 95 daq., 120 savol; Bobur 40 daq., 30 savol va yana 1 farzand. Batafsil: https://mathpath.example/parent',
    );
    expect(smsMessages.weeklyReport('ru', [aziza, bobur], link)).toBe(
      'MathPath за неделю: Aziza 95 мин, 120 задач; Bobur 40 мин, 30 задач. Отчёт: https://mathpath.example/parent',
    );
  });

  it('uses the parent’s language, and Uzbek for an unknown one', () => {
    expect(smsMessages.weeklyReport('ru', [aziza], link)).toContain('освоено тем: 2');
    expect(smsMessages.weeklyReport('ru', [bobur], link)).toContain('30 задач. Отчёт');
    expect(smsMessages.weeklyReport('en', [aziza], link)).toContain('2 topics mastered');
    expect(smsMessages.weeklyReport('en', [bobur, aziza, aziza], link)).toContain('and 1 more');
    expect(smsMessages.weeklyReport('ru', [aziza, bobur, bobur], link)).toContain('и ещё 1');
    expect(smsMessages.weeklyReport('de', [aziza], link)).toContain('MathPath haftalik');
  });

  it('keeps the existing code texts', () => {
    expect(smsMessages.otpCode('123456')).toContain('123456');
    expect(smsMessages.confirmCode('654321')).toContain('654321');
    expect(smsMessages.childPinLocked()).toContain('PIN');
    expect(smsMessages.alreadyRegistered()).toContain('MathPath');
    expect(smsMessages.accountLocked()).toContain('MathPath');
  });
});

describe('EskizSmsSender', () => {
  const json = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('signs in once, sends with the token and renews it after a 401', async () => {
    const log = vi.fn();
    const fetchFn = vi
      .fn()
      .mockReturnValueOnce(json(200, { data: { token: 't1' } }))
      .mockReturnValueOnce(json(200, { id: 7 }))
      .mockReturnValueOnce(json(401, {}))
      .mockReturnValueOnce(json(200, { data: { token: 't2' } }))
      .mockReturnValueOnce(json(200, {}));
    const eskiz = new EskizSmsSender({
      email: 'ops@example.test',
      password: ['not', 'real'].join('-'),
      sender: '4546',
      baseUrl: 'https://eskiz.example/api',
      fetchFn,
      log,
    });
    await expect(eskiz.send('+998901234567', 'a')).resolves.toEqual({ messageId: '7' });
    await expect(eskiz.send('+998901234567', 'b')).resolves.toEqual({ messageId: null });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    const sent = fetchFn.mock.calls[1]!;
    expect(sent[0]).toBe('https://eskiz.example/api/message/sms/send');
    expect(sent[1].headers.Authorization).toBe('Bearer t1');
    expect((sent[1].body as FormData).get('mobile_phone')).toBe('998901234567');
    expect(fetchFn.mock.calls[4]![1].headers.Authorization).toBe('Bearer t2');
    expect(log).toHaveBeenCalledWith('Signed in to Eskiz');
  });

  it('reports refusals and failed sign-ins without the full number', async () => {
    const refusing = new EskizSmsSender({
      email: 'e',
      password: 'p',
      sender: '4546',
      fetchFn: vi
        .fn()
        .mockReturnValueOnce(json(200, { data: { token: 't' } }))
        .mockReturnValueOnce(json(500, {})),
    });
    await expect(refusing.send('+998901234567', 'x')).rejects.toThrow(
      'Eskiz refused SMS to +99890*****67: HTTP 500',
    );
    const noLogin = new EskizSmsSender({
      email: 'e',
      password: 'p',
      sender: '4546',
      fetchFn: vi.fn().mockReturnValue(json(403, {})),
    });
    await expect(noLogin.send('+998901234567', 'x')).rejects.toThrow('Eskiz login failed');
    const noToken = new EskizSmsSender({
      email: 'e',
      password: 'p',
      sender: '4546',
      fetchFn: vi.fn().mockReturnValue(json(200, { data: {} })),
    });
    await expect(noToken.send('+998901234567', 'x')).rejects.toThrow('no token');
  });
});
