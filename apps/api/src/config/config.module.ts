import { Global, Module } from '@nestjs/common';
import { loadConfig } from '@mathpath/config';
import { parseEnv } from './env';
import { BUSINESS_RULES, ENV } from './tokens';

/**
 * Provides the environment and business rules to every module.
 *
 * Both are loaded once when the app starts; invalid values stop the process
 * before it accepts traffic. Inject with `@Inject(ENV)` or `@Inject(BUSINESS_RULES)`.
 */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => parseEnv(process.env) },
    { provide: BUSINESS_RULES, useFactory: () => loadConfig() },
  ],
  exports: [ENV, BUSINESS_RULES],
})
export class AppConfigModule {}
