import { Controller, Get, Inject } from '@nestjs/common';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';

/** Response of the health endpoint. */
export interface HealthResponse {
  status: 'ok';
  version: string;
}

/**
 * Liveness check used by the load balancer and uptime monitoring.
 *
 * Public and cheap on purpose: it touches no database, so a slow dependency
 * does not make the orchestrator restart healthy API instances. A separate
 * readiness check that verifies dependencies is added with the database module.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * GET /api/v1/health
   *
   * @returns `{ status: 'ok', version }` with HTTP 200 while the process is up.
   */
  @Get()
  check(): HealthResponse {
    return { status: 'ok', version: this.env.APP_VERSION };
  }
}
