import { Module } from '@nestjs/common';
import { AssessmentModule } from './assessment/assessment.module';
import { AuditModule } from './audit/audit.module';
import { BillingModule } from './billing/billing.module';
import { CommonModule } from './common/common.module';
import { RedisModule } from './redis/redis.module';
import { RiskModule } from './risk/risk.module';
import { AppConfigModule } from './config/config.module';
import { ContentModule } from './content/content.module';
import { MediaModule } from './media/media.module';
import { DatabaseModule } from './database/database.module';
import { FamilyModule } from './family/family.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { LearningModule } from './learning/learning.module';

/**
 * Root module. Each domain module from docs/architecture.md §4 (identity,
 * content, assessment, ...) is added here as it is built.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    RedisModule,
    CommonModule,
    AuditModule,
    RiskModule,
    HealthModule,
    IdentityModule,
    FamilyModule,
    ContentModule,
    MediaModule,
    LearningModule,
    AssessmentModule,
    BillingModule,
  ],
})
export class AppModule {}
