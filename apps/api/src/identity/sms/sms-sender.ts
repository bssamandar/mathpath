/**
 * Sending SMS: the senders live in @mathpath/sms, shared with the worker.
 * This file keeps the API's import path and gives the development sender the
 * API's logger, so codes appear in the API log as `SMS To +99890*****67: …`.
 */
import { LogSmsSender as BaseLogSmsSender } from '@mathpath/sms';
import { Logger } from '@nestjs/common';

export { maskPhone, SmsSender } from '@mathpath/sms';

/** Development sender: prints the message, so codes can be read from the API log. */
export class LogSmsSender extends BaseLogSmsSender {
  constructor() {
    const logger = new Logger('SMS');
    super((line) => logger.log(line));
  }
}
