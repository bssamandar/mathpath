/**
 * Metrics for the API (architecture §7.6). One registry per process, served
 * on METRICS_PORT by main.ts, apart from the public routes.
 */
import { createMetrics, type Metrics } from '@mathpath/observability';
import { Global, Module } from '@nestjs/common';

export const METRICS = Symbol('METRICS');
export type { Metrics };

@Global()
@Module({
  providers: [{ provide: METRICS, useFactory: (): Metrics => createMetrics('api') }],
  exports: [METRICS],
})
export class ObservabilityModule {}
