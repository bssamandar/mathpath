/**
 * Telegram instead of SMS (SMS_PROVIDER=telegram): a temporary way to deliver
 * codes and notices until the Eskiz account is set up.
 *
 * A bot cannot write to a phone number, only to a chat the user opened. So the
 * user opens the bot, presses "Share my phone number", and the poller stores
 * phone → chat. From then on every text MathPath would send by SMS to that
 * phone goes to that chat. Only the user's own contact is accepted
 * (contact.user_id === from.id), so nobody can link someone else's number by
 * forwarding their contact card.
 */
import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { maskPhone, SmsSender } from './sms-sender';

/** The few Redis commands used here; ioredis's client fits, tests pass a fake. */
export interface TelegramStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  /** SET key value PX ms NX: true when the key was set. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Extends the TTL only while the key still holds `value`. */
  extendIfOwner(key: string, value: string, ttlMs: number): Promise<boolean>;
}

/** Adapts an ioredis client to TelegramStore. */
export function redisTelegramStore(redis: Redis): TelegramStore {
  return {
    get: (key) => redis.get(key),
    set: (key, value) => redis.set(key, value),
    setIfAbsent: async (key, value, ttlMs) =>
      (await redis.set(key, value, 'PX', ttlMs, 'NX')) === 'OK',
    extendIfOwner: async (key, value, ttlMs) =>
      (await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        1,
        key,
        value,
        ttlMs,
      )) === 1,
  };
}

export const telegramKeys = {
  phone: (phone: string) => `tg:phone:${phone}`,
  chat: (chatId: number) => `tg:chat:${chatId}`,
  offset: 'tg:offset',
  pollerLock: 'tg:poller',
};

/** Telegram gives "998901234567" or "+998901234567"; MathPath stores E.164. */
export function normalizeTelegramPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

type Fetch = typeof fetch;

/** Minimal Bot API client. The token is never logged. */
export class TelegramBotApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  async call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
    return json.result as T;
  }
}

export class TelegramSmsSender extends SmsSender {
  constructor(
    private readonly api: TelegramBotApi,
    private readonly store: TelegramStore,
  ) {
    super();
  }

  async send(phone: string, text: string): Promise<{ messageId: string | null }> {
    const chatId = await this.store.get(telegramKeys.phone(phone));
    if (!chatId) throw new Error(`${maskPhone(phone)} is not linked to the Telegram bot`);
    const message = await this.api.call<{ message_id: number }>('sendMessage', {
      chat_id: Number(chatId),
      text,
    });
    return { messageId: String(message.message_id) };
  }
}

interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    from?: { id: number };
    text?: string;
    contact?: { phone_number: string; user_id?: number };
  };
}

const texts = {
  start:
    'MathPath: kirish kodlarini shu yerda olasiz.\n' +
    'Pastdagi «📱 Raqamni yuborish» tugmasini bosing.\n\n' +
    'MathPath: коды для входа будут приходить сюда.\n' +
    'Нажмите кнопку «📱 Raqamni yuborish» ниже.',
  button: '📱 Raqamni yuborish',
  linked: (masked: string) =>
    `✅ ${masked} ulandi. Endi saytda kodni so‘rang.\n` +
    `✅ ${masked} привязан. Теперь запросите код на сайте.`,
  notOwn:
    'Faqat o‘z raqamingizni tugma orqali yuboring.\n' +
    'Отправьте только свой номер, через кнопку.',
  badPhone: 'Raqamni o‘qib bo‘lmadi. / Не удалось прочитать номер.',
};

const LOCK_TTL_MS = 90_000;
const POLL_TIMEOUT_S = 25;

/**
 * Long-polls the bot for /start and shared contacts. Only one API instance
 * polls at a time (a Redis lock), because Telegram allows one getUpdates
 * consumer per bot.
 */
export class TelegramBotPoller implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('TelegramBot');
  private readonly holder = randomUUID();
  private abort = new AbortController();
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly api: TelegramBotApi,
    private readonly store: TelegramStore,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
    this.logger.log('Telegram poller started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loop;
  }

  private async holdLock(): Promise<boolean> {
    const { pollerLock } = telegramKeys;
    return (
      (await this.store.extendIfOwner(pollerLock, this.holder, LOCK_TTL_MS)) ||
      (await this.store.setIfAbsent(pollerLock, this.holder, LOCK_TTL_MS))
    );
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (!(await this.holdLock())) {
          await this.sleep(30_000);
          continue;
        }
        const offset = Number((await this.store.get(telegramKeys.offset)) ?? 0);
        const updates = await this.api.call<TgUpdate[]>(
          'getUpdates',
          { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
          this.abort.signal,
        );
        for (const update of updates) {
          try {
            await this.handle(update);
          } catch (error) {
            this.logger.error(`update ${update.update_id} failed: ${(error as Error).message}`);
          }
          await this.store.set(telegramKeys.offset, String(update.update_id + 1));
        }
      } catch (error) {
        if (!this.running) return;
        this.logger.warn(`polling failed: ${(error as Error).message}`);
        await this.sleep(5_000);
      }
    }
  }

  /** Handles one update; public for tests. */
  async handle(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    const reply = (text: string, extra: object = {}) =>
      this.api.call('sendMessage', { chat_id: chatId, text, ...extra });

    if (msg.contact) {
      if (!msg.from || msg.contact.user_id !== msg.from.id) {
        await reply(texts.notOwn);
        return;
      }
      const phone = normalizeTelegramPhone(msg.contact.phone_number);
      if (!phone) {
        await reply(texts.badPhone);
        return;
      }
      await this.store.set(telegramKeys.phone(phone), String(chatId));
      await this.store.set(telegramKeys.chat(chatId), phone);
      this.logger.log(`linked ${maskPhone(phone)}`);
      await reply(texts.linked(maskPhone(phone)), { reply_markup: { remove_keyboard: true } });
      return;
    }

    await reply(texts.start, {
      reply_markup: {
        keyboard: [[{ text: texts.button, request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }
}
