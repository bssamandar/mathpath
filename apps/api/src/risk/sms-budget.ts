/**
 * SMS spend guard (security plan C-20).
 *
 * SMS pumping fraud makes a site send thousands of paid messages. Besides
 * the per-phone and per-network limits, this counts what we spend per hour and
 * per day. At the alert ratio it logs an error for monitoring; at 100% every
 * OTP request needs a CAPTCHA until the period ends ("circuit breaker").
 */
import type { AppConfig } from '@mathpath/config';
import { Logger } from '@nestjs/common';
import type { Clock } from '../common/clock';
import type { CounterStore } from '../common/counter-store';

const HOUR_MS = 3_600_000;
/** Uzbekistan has no daylight saving time, so a fixed offset is exact. */
const TASHKENT_OFFSET_MS = 5 * HOUR_MS;

export class SmsBudget {
  private readonly logger = new Logger('SmsBudget');

  constructor(
    private readonly counters: CounterStore,
    private readonly clock: Clock,
    private readonly rules: AppConfig['risk']['smsBudget'],
  ) {}

  /** True when the hourly or daily cap has been reached. */
  async exhausted(): Promise<boolean> {
    const { hour, day } = this.keys();
    const [hourly, daily] = await Promise.all([this.counters.get(hour), this.counters.get(day)]);
    return hourly >= this.rules.hourlyCapTiyin || daily >= this.rules.dailyCapTiyin;
  }

  /** Records one sent SMS and alerts when a threshold is crossed. */
  async spend(): Promise<void> {
    const cost = this.rules.costPerSmsTiyin;
    const { hour, day } = this.keys();
    const [hourly, daily] = await Promise.all([
      this.counters.add(hour, cost, HOUR_MS),
      this.counters.add(day, cost, 24 * HOUR_MS),
    ]);
    this.alertIfCrossed('hourly', hourly, cost, this.rules.hourlyCapTiyin);
    this.alertIfCrossed('daily', daily, cost, this.rules.dailyCapTiyin);
  }

  /** Logs once per threshold: when this SMS moved the total across it. */
  private alertIfCrossed(period: string, total: number, cost: number, cap: number): void {
    for (const [ratio, label] of [
      [this.rules.alertRatio, 'alert level'],
      [1, 'cap; CAPTCHA now required for every code'],
    ] as const) {
      const threshold = cap * ratio;
      if (total >= threshold && total - cost < threshold) {
        this.logger.error(`SMS spend reached the ${period} ${label} (${total} of ${cap} tiyin)`);
      }
    }
  }

  /** Counter keys for the current Tashkent hour and day. */
  private keys(): { hour: string; day: string } {
    const local = new Date(this.clock.now().getTime() + TASHKENT_OFFSET_MS).toISOString();
    return { hour: `sms:hour:${local.slice(0, 13)}`, day: `sms:day:${local.slice(0, 10)}` };
  }
}
