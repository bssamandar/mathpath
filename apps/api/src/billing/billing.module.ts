/**
 * Billing (docs/architecture.md §4 `billing`; ADR-0008). Providers are
 * switched on with PAYMENT_PROVIDERS; a provider that is not listed has no
 * adapter, so checkout refuses it and its callback endpoint answers 404.
 */
import type { AppConfig } from '@mathpath/config';
import type { Database } from '@mathpath/db';
import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../common/clock';
import type { Env } from '../config/env';
import { BUSINESS_RULES, ENV } from '../config/tokens';
import { DB } from '../database/database.module';
import { BillingController, PaymentCallbacksController } from './billing.controller';
import { BillingService } from './billing.service';
import { PAYMENT_PROVIDERS as PROVIDERS, type PaymentProvider } from './payment-provider';
import { ClickProvider } from './click/click';
import { PaymeProvider } from './payme/payme';

@Module({
  controllers: [BillingController, PaymentCallbacksController],
  providers: [
    // Filled by each adapter's factory below; read at request time.
    { provide: PROVIDERS, useFactory: () => new Map<string, PaymentProvider>() },
    {
      provide: BillingService,
      inject: [DB, AuditService, Clock, BUSINESS_RULES, PROVIDERS, ENV],
      useFactory: (
        db: Kysely<Database>,
        audit: AuditService,
        clock: Clock,
        rules: AppConfig,
        providers: Map<string, PaymentProvider>,
        env: Env,
      ) => new BillingService(db, audit, clock, rules.billing, providers, env.CORS_ORIGINS),
    },
    {
      provide: PaymeProvider,
      inject: [DB, Clock, BillingService, BUSINESS_RULES, PROVIDERS, ENV],
      useFactory: (
        db: Kysely<Database>,
        clock: Clock,
        billing: BillingService,
        rules: AppConfig,
        providers: Map<string, PaymentProvider>,
        env: Env,
      ) => {
        if (!env.PAYMENT_PROVIDERS.includes('payme')) return null;
        const payme = new PaymeProvider(db, clock, billing, rules.billing, {
          merchantId: env.PAYME_MERCHANT_ID!,
          key: env.PAYME_KEY!,
          checkoutUrl: env.PAYME_CHECKOUT_URL,
        });
        providers.set('payme', payme);
        return payme;
      },
    },
    {
      provide: ClickProvider,
      inject: [DB, Clock, BillingService, PROVIDERS, ENV],
      useFactory: (
        db: Kysely<Database>,
        clock: Clock,
        billing: BillingService,
        providers: Map<string, PaymentProvider>,
        env: Env,
      ) => {
        if (!env.PAYMENT_PROVIDERS.includes('click')) return null;
        const click = new ClickProvider(db, clock, billing, {
          serviceId: env.CLICK_SERVICE_ID!,
          merchantId: env.CLICK_MERCHANT_ID!,
          secretKey: env.CLICK_SECRET_KEY!,
          checkoutUrl: env.CLICK_CHECKOUT_URL,
        });
        providers.set('click', click);
        return click;
      },
    },
  ],
  exports: [BillingService],
})
export class BillingModule {}
