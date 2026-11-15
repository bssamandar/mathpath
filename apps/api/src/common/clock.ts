/**
 * Source of the current time.
 *
 * Expiry rules (OTP codes, tokens, rate-limit windows) are the code most
 * worth testing at the edges. Injecting the clock lets tests move time
 * forward instead of sleeping.
 */
export abstract class Clock {
  /** @returns The current time. */
  abstract now(): Date;
}

/** The real clock used in production. */
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
