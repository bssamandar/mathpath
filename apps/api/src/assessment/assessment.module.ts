/**
 * Assessment (docs/architecture.md §4: `assessment`): practice sets, mastery
 * tests and their marking. Wired with factories, as in the content module.
 */
import type { AppConfig } from '@mathpath/config';
import type { Database } from '@mathpath/db';
import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Clock } from '../common/clock';
import { BUSINESS_RULES } from '../config/tokens';
import { CatalogueService, Entitlements } from '../content/catalogue.service';
import { ContentModule } from '../content/content.module';
import { DB } from '../database/database.module';
import { LearningModule } from '../learning/learning.module';
import { LearningService } from '../learning/learning.service';
import { AttemptsController } from './attempts.controller';
import { AttemptsService } from './attempts.service';

@Module({
  imports: [ContentModule, LearningModule],
  controllers: [AttemptsController],
  providers: [
    {
      provide: AttemptsService,
      inject: [DB, CatalogueService, Entitlements, Clock, BUSINESS_RULES, LearningService],
      useFactory: (
        db: Kysely<Database>,
        catalogue: CatalogueService,
        entitlements: Entitlements,
        clock: Clock,
        rules: AppConfig,
        learning: LearningService,
      ) => new AttemptsService(db, catalogue, entitlements, clock, rules, learning),
    },
  ],
})
export class AssessmentModule {}
