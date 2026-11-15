/**
 * Sending SMS. The Eskiz.uz adapter (ADR, Phase 1 decision) implements this
 * interface; until it is added, only the development console sender exists,
 * and the environment check refuses to start production with it.
 */
import { Logger } from '@nestjs/common';

export abstract class SmsSender {
  /**
   * Sends one SMS.
   * @param phone - E.164 number.
   * @param text - Message text, already in the user's language.
   * @returns The provider's message ID, if it gives one.
   */
  abstract send(phone: string, text: string): Promise<{ messageId: string | null }>;
}

/** Hides most digits of a phone number for logs: +998901234567 → +99890*****67. */
export function maskPhone(phone: string): string {
  return phone.length <= 7
    ? '***'
    : `${phone.slice(0, 6)}${'*'.repeat(phone.length - 8)}${phone.slice(-2)}`;
}

/** Development sender: prints the message, so codes can be read from the API log. */
export class LogSmsSender extends SmsSender {
  private readonly logger = new Logger('SMS');

  async send(phone: string, text: string): Promise<{ messageId: null }> {
    this.logger.log(`To ${maskPhone(phone)}: ${text}`);
    return Promise.resolve({ messageId: null });
  }
}
