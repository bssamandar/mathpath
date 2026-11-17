import 'reflect-metadata';
import { JsonLogger, startMetricsServer } from '@mathpath/observability';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './app.factory';
import { AppModule } from './app.module';
import type { Env } from './config/env';
import { ENV } from './config/tokens';
import { METRICS, type Metrics } from './observability/observability.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const env = app.get<Env>(ENV);
  // JSON lines with personal data redacted (C-34); the buffered start-up
  // logs are written through it too.
  const logger = new JsonLogger({ service: 'api', level: env.LOG_LEVEL, version: env.APP_VERSION });
  app.useLogger(logger);
  configureApp(app, logger);
  await app.listen(env.PORT);
  if (env.METRICS_PORT > 0) {
    await startMetricsServer(app.get<Metrics>(METRICS).registry, { port: env.METRICS_PORT });
  }
  new Logger('Bootstrap').log(
    `API listening on port ${env.PORT}${env.METRICS_PORT > 0 ? `, metrics on ${env.METRICS_PORT}` : ''}`,
  );
}

void bootstrap();
