import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './app.factory';
import { AppModule } from './app.module';
import type { Env } from './config/env';
import { ENV } from './config/tokens';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApp(app);
  const env = app.get<Env>(ENV);
  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`API listening on port ${env.PORT}`);
}

void bootstrap();
