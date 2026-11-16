/**
 * Reporting (docs/architecture.md §4 `reporting`): the weekly report for
 * parents and learners. Read models come straight from the learning tables
 * at MVP volume; a replica takes over when reads grow.
 */
import type { AppConfig } from '@mathpath/config';
import type { Database } from '@mathpath/db';
import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Clock } from '../common/clock';
import { BUSINESS_RULES } from '../config/tokens';
import { DB } from '../database/database.module';
import { LearningModule } from '../learning/learning.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [LearningModule],
  controllers: [ReportsController],
  providers: [
    {
      provide: ReportsService,
      inject: [DB, Clock, BUSINESS_RULES],
      useFactory: (db: Kysely<Database>, clock: Clock, rules: AppConfig) =>
        new ReportsService(db, clock, rules),
    },
  ],
})
export class ReportingModule {}
