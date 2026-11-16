/**
 * Gamification (docs/architecture.md §4 `gamification`). The assessment
 * module calls the service inside the transaction that saves a result.
 */
import type { AppConfig } from '@mathpath/config';
import type { Database } from '@mathpath/db';
import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Clock } from '../common/clock';
import { BUSINESS_RULES } from '../config/tokens';
import { DB } from '../database/database.module';
import { GamificationController } from './gamification.controller';
import { GamificationService } from './gamification.service';

@Module({
  controllers: [GamificationController],
  providers: [
    {
      provide: GamificationService,
      inject: [DB, Clock, BUSINESS_RULES],
      useFactory: (db: Kysely<Database>, clock: Clock, rules: AppConfig) =>
        new GamificationService(db, clock, rules.gamification),
    },
  ],
  exports: [GamificationService],
})
export class GamificationModule {}
