import 'reflect-metadata';
import type { AppConfig } from '@mathpath/config';
import { closeFinishedLeagues, createDb } from '@mathpath/db';
import { objectStoreFromEnv, vaultFromEnv } from '@mathpath/media';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { parseWorkerEnv } from './env';
import { startLeagueClose } from './leagues/close-job';
import { startTranscodeConsumer } from './transcode/consumer';
import { Transcoder } from './transcode/transcoder';
import { BUSINESS_RULES, WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const env = parseWorkerEnv(process.env);
  // A standalone application context: dependency injection without HTTP.
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  const rules = app.get<AppConfig>(BUSINESS_RULES);

  const db = createDb({ connectionString: env.DATABASE_URL, maxConnections: 4 });
  const store = objectStoreFromEnv(env)!; // parseWorkerEnv requires the S3 settings
  const vault = vaultFromEnv(env, (m) => logger.warn(m));
  const consumer = startTranscodeConsumer(new Transcoder(db, store, vault, rules.content.video), {
    redisUrl: env.REDIS_URL,
    concurrency: env.TRANSCODE_CONCURRENCY,
  });

  const leagues = await startLeagueClose(
    () => closeFinishedLeagues(db, rules.gamification.leagues, new Date()),
    { redisUrl: env.REDIS_URL },
  );

  const stop = async () => {
    // Let the running encode finish its current step, then close cleanly.
    await consumer.close();
    await leagues.stop();
    await db.destroy();
    await app.close();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  logger.log(
    `Worker started: ${consumer.name} (concurrency ${env.TRANSCODE_CONCURRENCY}), ${leagues.worker.name}.`,
  );
}

void bootstrap();
