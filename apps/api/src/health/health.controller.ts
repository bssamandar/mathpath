import type { Database } from '@mathpath/db';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { type Kysely, sql } from 'kysely';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';
import { DB } from '../database/database.module';
import { REDIS } from '../redis/redis.module';
import { Access } from '../identity/permissions';

type Check = 'ok' | 'down';

/** Response of the readiness endpoint. */
export interface ReadinessResponse {
  status: 'ok' | 'down';
  checks: { database: Check; redis: Check | 'not_configured' };
}

/** A dependency that does not answer within this time counts as down. */
const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)),
  ]);
}

/** Response of the health endpoint. */
export interface HealthResponse {
  status: 'ok';
  version: string;
}

/**
 * Liveness check used by the load balancer and uptime monitoring.
 *
 * Public and cheap on purpose: it touches no database, so a slow dependency
 * does not make the orchestrator restart healthy API instances. Readiness
 * (`/health/ready`) checks the database and Redis, so a load balancer stops
 * sending traffic to an instance that cannot reach them.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  /**
   * GET /api/v1/health
   *
   * @returns `{ status: 'ok', version }` with HTTP 200 while the process is up.
   */
  @Get()
  @Access('public')
  check(): HealthResponse {
    return { status: 'ok', version: this.env.APP_VERSION };
  }

  /**
   * GET /api/v1/health/ready
   *
   * Says only which dependency is down, never why: the details are in the logs.
   * @returns 200 when the database and Redis answer, 503 otherwise.
   */
  @Get('ready')
  @Access('public')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const [database, redis] = await Promise.all([
      withTimeout(sql`select 1`.execute(this.db)).then(
        () => 'ok' as const,
        () => 'down' as const,
      ),
      this.redis
        ? withTimeout(this.redis.ping()).then(
            () => 'ok' as const,
            () => 'down' as const,
          )
        : Promise.resolve('not_configured' as const),
    ]);
    const body: ReadinessResponse = {
      status: database === 'ok' && redis !== 'down' ? 'ok' : 'down',
      checks: { database, redis },
    };
    if (body.status !== 'ok') res.status(503);
    return body;
  }
}
