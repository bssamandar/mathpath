/**
 * Sending SMS. Eskiz.uz is the production gateway (Phase 1 decision); the log
 * sender prints messages so development and tests can read codes. The
 * environment check refuses to start production with the log sender.
 */

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

/** Development sender: writes `To +99890*****67: text` with the given logger. */
export class LogSmsSender extends SmsSender {
  constructor(private readonly log: (line: string) => void) {
    super();
  }

  async send(phone: string, text: string): Promise<{ messageId: null }> {
    this.log(`To ${maskPhone(phone)}: ${text}`);
    return Promise.resolve({ messageId: null });
  }
}
