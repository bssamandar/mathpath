import type { AppConfig } from '@mathpath/config';
import type { Database } from '@mathpath/db';
import { Global, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Clock } from '../common/clock';
import { CounterStore } from '../common/counter-store';
import { RateLimiter } from '../common/rate-limiter';
import type { Env } from '../config/env';
import { BUSINESS_RULES, ENV } from '../config/tokens';
import { DB } from '../database/database.module';
import { CaptchaVerifier, DevCaptchaVerifier, TurnstileCaptchaVerifier } from './captcha';
import { RiskService } from './risk.service';
import { SmsBudget } from './sms-budget';

/** The risk module (docs/architecture.md §4): scoring, CAPTCHA and SMS spend guard. */
@Global()
@Module({
  providers: [
    {
      provide: CaptchaVerifier,
      inject: [ENV],
      useFactory: (env: Env): CaptchaVerifier =>
        env.CAPTCHA_PROVIDER === 'turnstile'
          ? new TurnstileCaptchaVerifier(env.TURNSTILE_SECRET_KEY!)
          : new DevCaptchaVerifier(),
    },
    {
      provide: SmsBudget,
      inject: [CounterStore, Clock, BUSINESS_RULES],
      useFactory: (counters: CounterStore, clock: Clock, rules: AppConfig) =>
        new SmsBudget(counters, clock, rules.risk.smsBudget),
    },
    {
      provide: RiskService,
      inject: [DB, RateLimiter, CaptchaVerifier, SmsBudget, BUSINESS_RULES],
      useFactory: (
        db: Kysely<Database>,
        limiter: RateLimiter,
        captcha: CaptchaVerifier,
        budget: SmsBudget,
        rules: AppConfig,
      ) =>
        new RiskService(
          db,
          limiter,
          captcha,
          budget,
          rules.risk,
          rules.limits.rateLimits.loginFailuresPerAccount,
        ),
    },
  ],
  exports: [RiskService, SmsBudget],
})
export class RiskModule {}
