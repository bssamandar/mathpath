/**
 * Catalogue and content (docs/architecture.md §4: `catalogue` and `content`).
 * Services are plain classes wired with factories, as in the identity module.
 */
import type { AppConfig } from '@mathpath/config';
import type { Database } from '@mathpath/db';
import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../common/clock';
import { BUSINESS_RULES } from '../config/tokens';
import { DB } from '../database/database.module';
import { CatalogueService, Entitlements, NoEntitlements } from './catalogue.service';
import { CatalogueController, StudioController } from './content.controller';
import { StudioService } from './studio.service';

@Module({
  controllers: [CatalogueController, StudioController],
  providers: [
    // Replaced by the billing module's implementation in step 6.5.
    { provide: Entitlements, useClass: NoEntitlements },
    {
      provide: CatalogueService,
      inject: [DB, Entitlements, BUSINESS_RULES],
      useFactory: (db: Kysely<Database>, entitlements: Entitlements, rules: AppConfig) =>
        new CatalogueService(db, entitlements, rules.content),
    },
    {
      provide: StudioService,
      inject: [DB, AuditService, Clock, BUSINESS_RULES],
      useFactory: (db: Kysely<Database>, audit: AuditService, clock: Clock, rules: AppConfig) =>
        new StudioService(db, audit, clock, rules.content),
    },
  ],
  exports: [CatalogueService, Entitlements],
})
export class ContentModule {}
