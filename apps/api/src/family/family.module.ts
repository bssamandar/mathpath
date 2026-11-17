import type { AppConfig } from '@mathpath/config';
import type { Database } from '@mathpath/db';
import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../common/clock';
import { RateLimiter } from '../common/rate-limiter';
import { BUSINESS_RULES } from '../config/tokens';
import { DB } from '../database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { OtpService } from '../identity/otp.service';
import { PasswordService } from '../identity/password.service';
import { SessionService } from '../identity/session.service';
import { SmsSender } from '../identity/sms/sms-sender';
import { ChildAuthController, ChildrenController } from './family.controller';
import { FamilyService } from './family.service';

/** The family module (docs/architecture.md §4): parent–child links and consent. */
@Module({
  imports: [IdentityModule],
  controllers: [ChildrenController, ChildAuthController],
  providers: [
    {
      provide: FamilyService,
      inject: [
        DB,
        OtpService,
        PasswordService,
        SessionService,
        RateLimiter,
        SmsSender,
        AuditService,
        Clock,
        BUSINESS_RULES,
      ],
      useFactory: (
        db: Kysely<Database>,
        otp: OtpService,
        passwords: PasswordService,
        sessions: SessionService,
        limiter: RateLimiter,
        sms: SmsSender,
        audit: AuditService,
        clock: Clock,
        rules: AppConfig,
      ) =>
        new FamilyService(
          db,
          otp,
          passwords,
          sessions,
          limiter,
          sms,
          audit,
          clock,
          rules.limits.rateLimits,
        ),
    },
  ],
})
export class FamilyModule {}
