import { Module } from '@nestjs/common';
import { loadConfig } from '@mathpath/config';

/** Injection token for the validated business rules. */
export const BUSINESS_RULES = Symbol('BUSINESS_RULES');

/**
 * Root module of the worker process.
 *
 * The worker shares code with the API but runs no HTTP server. Queue
 * consumers (outbox relay, transcoding, weekly reports, renewals) are added
 * here as their features are built; see docs/architecture.md §4 and ADR-0007.
 */
@Module({
  providers: [{ provide: BUSINESS_RULES, useFactory: () => loadConfig() }],
  exports: [BUSINESS_RULES],
})
export class WorkerModule {}
