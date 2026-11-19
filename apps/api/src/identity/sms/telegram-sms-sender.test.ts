import { describe, expect, it, vi } from 'vitest';
import type { TelegramBotApi } from './telegram-sms-sender';
import {
  normalizeTelegramPhone,
  TelegramBotPoller,
  TelegramSmsSender,
  telegramKeys,
  type TelegramStore,
} from './telegram-sms-sender';

function memoryStore(): TelegramStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    setIfAbsent: async (k, v) => (data.has(k) ? false : (data.set(k, v), true)),
    extendIfOwner: async (k, v) => data.get(k) === v,
  };
}

function fakeApi() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const api = {
    call: vi.fn(async (method: string, body: Record<string, unknown>) => {
      calls.push({ method, body });
      return { message_id: 42 };
    }),
  } as unknown as TelegramBotApi;
  return { api, calls };
}

const privateChat = { id: 555, type: 'private' };

describe('normalizeTelegramPhone', () => {
  it('turns Telegram numbers into E.164', () => {
    expect(normalizeTelegramPhone('998901234567')).toBe('+998901234567');
    expect(normalizeTelegramPhone('+998 90 123-45-67')).toBe('+998901234567');
    expect(normalizeTelegramPhone('12')).toBeNull();
  });
});

describe('TelegramSmsSender', () => {
  it('sends to the linked chat', async () => {
    const store = memoryStore();
    store.data.set(telegramKeys.phone('+998901234567'), '555');
    const { api, calls } = fakeApi();
    const result = await new TelegramSmsSender(api, store).send('+998901234567', 'Kod: 1234');
    expect(calls).toEqual([{ method: 'sendMessage', body: { chat_id: 555, text: 'Kod: 1234' } }]);
    expect(result).toEqual({ messageId: '42' });
  });

  it('refuses a phone that is not linked, without leaking the number', async () => {
    const { api } = fakeApi();
    await expect(
      new TelegramSmsSender(api, memoryStore()).send('+998901234567', 'x'),
    ).rejects.toThrow('+99890*****67 is not linked');
  });
});

describe('TelegramBotPoller.handle', () => {
  it('links the sender’s own shared contact', async () => {
    const store = memoryStore();
    const { api, calls } = fakeApi();
    await new TelegramBotPoller(api, store).handle({
      update_id: 1,
      message: {
        chat: privateChat,
        from: { id: 7 },
        contact: { phone_number: '998901234567', user_id: 7 },
      },
    });
    expect(store.data.get(telegramKeys.phone('+998901234567'))).toBe('555');
    expect(store.data.get(telegramKeys.chat(555))).toBe('+998901234567');
    expect(calls[0]?.body.text).toContain('+99890*****67');
  });

  it('ignores a forwarded contact of somebody else', async () => {
    const store = memoryStore();
    const { api } = fakeApi();
    await new TelegramBotPoller(api, store).handle({
      update_id: 1,
      message: {
        chat: privateChat,
        from: { id: 7 },
        contact: { phone_number: '998901234567', user_id: 8 },
      },
    });
    expect(store.data.size).toBe(0);
  });

  it('answers /start with a share-contact button, and skips group chats', async () => {
    const { api, calls } = fakeApi();
    const poller = new TelegramBotPoller(api, memoryStore());
    await poller.handle({
      update_id: 1,
      message: { chat: { id: 9, type: 'group' }, text: '/start' },
    });
    expect(calls).toHaveLength(0);
    await poller.handle({ update_id: 2, message: { chat: privateChat, text: '/start' } });
    const markup = calls[0]?.body.reply_markup as { keyboard: { request_contact: boolean }[][] };
    expect(markup.keyboard[0]?.[0]?.request_contact).toBe(true);
  });
});
