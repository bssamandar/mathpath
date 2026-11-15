import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';

/**
 * Root module. Each domain module from docs/architecture.md §4 (identity,
 * content, assessment, ...) is added here as it is built.
 */
@Module({ imports: [AppConfigModule, HealthModule] })
export class AppModule {}
