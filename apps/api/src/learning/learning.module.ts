/**
 * Learning (docs/architecture.md §4: `learning`): progress, gap routing,
 * spaced review and the learning path. The assessment module calls it after
 * every submitted attempt.
 */
import type { AppConfig } from '@mathpath/config';
import type { Database } from '@mathpath/db';
import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Clock } from '../common/clock';
import { BUSINESS_RULES } from '../config/tokens';
import { CatalogueService } from '../content/catalogue.service';
import { ContentModule } from '../content/content.module';
import { DB } from '../database/database.module';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';

@Module({
  imports: [ContentModule],
  controllers: [LearningController],
  providers: [
    {
      provide: LearningService,
      inject: [DB, CatalogueService, Clock, BUSINESS_RULES],
      useFactory: (
        db: Kysely<Database>,
        catalogue: CatalogueService,
        clock: Clock,
        rules: AppConfig,
      ) => new LearningService(db, catalogue, clock, rules),
    },
  ],
  exports: [LearningService],
})
export class LearningModule {}
