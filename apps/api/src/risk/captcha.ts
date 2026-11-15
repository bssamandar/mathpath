/**
 * Server-side CAPTCHA verification (security plan C-21).
 *
 * Cloudflare Turnstile was chosen (2026-11-15) because it is free, usually
 * invisible (no picture puzzles for young children) and light on low-end
 * phones. It sits behind this interface, so another provider is one new class.
 * Alternatives considered: Yandex SmartCaptcha (similar, also outside
 * Uzbekistan) and hCaptcha (frequent image puzzles).
 */
import { Logger } from '@nestjs/common';

export abstract class CaptchaVerifier {
  /** @returns True when the token proves a human solved the challenge just now. */
  abstract verify(token: string): Promise<boolean>;
}

/** Development only: accepts the fixed token `dev-pass`. Refused in production by env checks. */
export class DevCaptchaVerifier extends CaptchaVerifier {
  async verify(token: string): Promise<boolean> {
    return Promise.resolve(token === 'dev-pass');
  }
}

/**
 * Cloudflare Turnstile siteverify. The user's IP is not sent: it is optional
 * for Turnstile, and leaving it out keeps one more personal datum in-country.
 * Fails closed: if Cloudflare cannot be reached, the request needs a retry,
 * because a CAPTCHA is only asked for when risk is already elevated.
 */
export class TurnstileCaptchaVerifier extends CaptchaVerifier {
  private readonly logger = new Logger('Turnstile');

  constructor(
    private readonly secret: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {
    super();
  }

  async verify(token: string): Promise<boolean> {
    try {
      const response = await this.fetchFn(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: this.secret, response: token }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { success?: boolean };
      return body.success === true;
    } catch (error) {
      this.logger.warn(`Turnstile verification failed: ${(error as Error).message}`);
      return false;
    }
  }
}
