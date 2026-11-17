import 'reflect-metadata';
import type { AppConfig } from '@mathpath/config';
import { closeFinishedLeagues, createDb, verifyAuditChain } from '@mathpath/db';
import { objectStoreFromEnv, vaultFromEnv } from '@mathpath/media';
import { createMetrics, JsonLogger, startMetricsServer } from '@mathpath/observability';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { startAuditCheck } from './audit/check-job';
import { parseWorkerEnv } from './env';
import { startLeagueClose } from './leagues/close-job';
import { startTranscodeConsumer } from './transcode/consumer';
import { Transcoder } from './transcode/transcoder';
import { BUSINESS_RULES, WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const env = parseWorkerEnv(process.env);
  const json = new JsonLogger({
    service: 'worker',
    level: env.LOG_LEVEL,
    version: env.APP_VERSION,
  });
  // A standalone application context: dependency injection without HTTP.
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: json });
  app.enableShutdownHooks();
  const logger = new Logger('Worker');
  const rules = app.get<AppConfig>(BUSINESS_RULES);
  const metrics = createMetrics('worker');
  const succeeded = (task: string) => metrics.jobLastSuccess.set({ task }, Date.now() / 1000);

  const db = createDb({ connectionString: env.DATABASE_URL, maxConnections: 4 });
  const store = objectStoreFromEnv(env)!; // parseWorkerEnv requires the S3 settings
  const vault = vaultFromEnv(env, (m) => logger.warn(m));
  const consumer = startTranscodeConsumer(new Transcoder(db, store, vault, rules.content.video), {
    redisUrl: env.REDIS_URL,
    concurrency: env.TRANSCODE_CONCURRENCY,
    onOutcome: (outcome) => metrics.transcodeJobs.inc({ outcome }),
  });

  const leagues = await startLeagueClose(
    async () => {
      const closed = await closeFinishedLeagues(db, rules.gamification.leagues, new Date());
      metrics.leagueWeeksClosed.inc(closed);
      succeeded('league_close');
      return closed;
    },
    { redisUrl: env.REDIS_URL },
  );

  const audit = await startAuditCheck(
    () => verifyAuditChain(db),
    {
      onResult: (check) => {
        metrics.auditChainBroken.set(check.ok ? 0 : 1);
        if (check.ok) succeeded('audit_chain_check');
      },
    },
    { redisUrl: env.REDIS_URL },
  );

  const server =
    env.WORKER_METRICS_PORT > 0
      ? await startMetricsServer(metrics.registry, { port: env.WORKER_METRICS_PORT })
      : null;

  const stop = async () => {
    // Let the running encode finish its current step, then close cleanly.
    await consumer.close();
    await leagues.stop();
    await audit.stop();
    server?.close();
    await db.destroy();
    await app.close();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  logger.log(
    `Worker started: ${consumer.name} (concurrency ${env.TRANSCODE_CONCURRENCY}), ${leagues.worker.name}, ${audit.worker.name}.`,
  );
}

void bootstrap();
