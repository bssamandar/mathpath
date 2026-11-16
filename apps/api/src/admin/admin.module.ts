/**
 * Admin console API (docs/architecture.md §4; UX §3.4). Payments refunds live
 * with billing, where the provider adapters are.
 */
import type { Database } from '@mathpath/db';
import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../common/clock';
import { DB } from '../database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { MfaService } from '../identity/mfa.service';
import { SessionService } from '../identity/session.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [IdentityModule],
  controllers: [AdminController],
  providers: [
    {
      provide: AdminService,
      inject: [DB, AuditService, SessionService, MfaService, Clock],
      useFactory: (
        db: Kysely<Database>,
        audit: AuditService,
        sessions: SessionService,
        mfa: MfaService,
        clock: Clock,
      ) => new AdminService(db, audit, sessions, mfa, clock),
    },
  ],
})
export class AdminModule {}
