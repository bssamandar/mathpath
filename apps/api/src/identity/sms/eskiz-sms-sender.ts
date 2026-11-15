/**
 * Eskiz.uz SMS gateway (Phase 1 decision: Eskiz first).
 *
 * Eskiz authenticates with an e-mail and password, which return a bearer
 * token valid for about 30 days. The token is cached in memory and renewed
 * when Eskiz answers 401. Eskiz only delivers texts whose wording was
 * approved in its dashboard, so the texts in messages.ts must be registered
 * there before going live.
 */
import { Logger } from '@nestjs/common';
import { maskPhone, SmsSender } from './sms-sender';

export interface EskizOptions {
  email: string;
  password: string;
  /** Sender name or short number registered with Eskiz; "4546" is Eskiz's default. */
  sender: string;
  baseUrl?: string;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class EskizSmsSender extends SmsSender {
  private readonly logger = new Logger('EskizSmsSender');
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private token: Promise<string> | undefined;

  constructor(private readonly options: EskizOptions) {
    super();
    this.baseUrl = options.baseUrl ?? 'https://notify.eskiz.uz/api';
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async send(phone: string, text: string): Promise<{ messageId: string | null }> {
    let response = await this.post(phone, text, await this.currentToken());
    if (response.status === 401) {
      // Token expired: log in again once, then give up.
      this.token = undefined;
      response = await this.post(phone, text, await this.currentToken());
    }
    if (!response.ok) {
      throw new Error(`Eskiz refused SMS to ${maskPhone(phone)}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { id?: string | number };
    return { messageId: body.id === undefined ? null : String(body.id) };
  }

  private post(phone: string, text: string, token: string): Promise<Response> {
    const form = new FormData();
    // Eskiz expects the number without the leading "+".
    form.set('mobile_phone', phone.replace(/^\+/, ''));
    form.set('message', text);
    form.set('from', this.options.sender);
    return this.fetchFn(`${this.baseUrl}/message/sms/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
  }

  private currentToken(): Promise<string> {
    this.token ??= this.login().catch((error: unknown) => {
      this.token = undefined;
      throw error;
    });
    return this.token;
  }

  private async login(): Promise<string> {
    const form = new FormData();
    form.set('email', this.options.email);
    form.set('password', this.options.password);
    const response = await this.fetchFn(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`Eskiz login failed: HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { token?: string } };
    if (!body.data?.token) throw new Error('Eskiz login returned no token');
    this.logger.log('Signed in to Eskiz');
    return body.data.token;
  }
}
