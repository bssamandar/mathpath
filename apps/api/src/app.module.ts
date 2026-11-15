import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';

/**
 * Root module. Each domain module from docs/architecture.md §4 (identity,
 * content, assessment, ...) is added here as it is built.
 */
@Module({ imports: [AppConfigModule, DatabaseModule, AuditModule, HealthModule, IdentityModule] })
export class AppModule {}
