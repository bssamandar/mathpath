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
import { RateLimiter } from '../common/rate-limiter';
import type { Env } from '../config/env';
import { BUSINESS_RULES, ENV } from '../config/tokens';
import { DB } from '../database/database.module';
import {
  AdminPaymentsController,
  AdminPromoController,
  BillingController,
  PaymentCallbacksController,
} from './billing.controller';
import { BillingService } from './billing.service';
import { PAYMENT_PROVIDERS as PROVIDERS, type PaymentProvider } from './payment-provider';
import { ClickProvider } from './click/click';
import { PaymeProvider } from './payme/payme';
import { PromoService } from './promo.service';
import { ClickMerchantApi } from './click/merchant-api';
import { RefundService } from './refund.service';

@Module({
  controllers: [
    BillingController,
    AdminPromoController,
    AdminPaymentsController,
    PaymentCallbacksController,
  ],
  providers: [
    // Filled by each adapter's factory below; read at request time.
    { provide: PROVIDERS, useFactory: () => new Map<string, PaymentProvider>() },
    {
      provide: PromoService,
      inject: [DB, AuditService, Clock, BUSINESS_RULES, RateLimiter],
      useFactory: (
        db: Kysely<Database>,
        audit: AuditService,
        clock: Clock,
        rules: AppConfig,
        limiter: RateLimiter,
      ) =>
        new PromoService(
          db,
          audit,
          clock,
          rules.billing,
          limiter,
          rules.limits.rateLimits.promoChecksPerUser,
        ),
    },
    {
      provide: BillingService,
      inject: [DB, AuditService, Clock, BUSINESS_RULES, PROVIDERS, ENV, PromoService],
      useFactory: (
        db: Kysely<Database>,
        audit: AuditService,
        clock: Clock,
        rules: AppConfig,
        providers: Map<string, PaymentProvider>,
        env: Env,
        promo: PromoService,
      ) => new BillingService(db, audit, clock, rules.billing, providers, env.CORS_ORIGINS, promo),
    },
    {
      provide: RefundService,
      inject: [DB, AuditService, Clock, BillingService, ENV],
      useFactory: (
        db: Kysely<Database>,
        audit: AuditService,
        clock: Clock,
        billing: BillingService,
        env: Env,
      ) => {
        // Click reversals need the Merchant API user; without it the admin
        // reverses Click payments in the Click cabinet.
        const click =
          env.CLICK_MERCHANT_USER_ID && env.CLICK_SERVICE_ID && env.CLICK_SECRET_KEY
            ? new ClickMerchantApi({
                apiUrl: env.CLICK_MERCHANT_API_URL,
                serviceId: env.CLICK_SERVICE_ID,
                merchantUserId: env.CLICK_MERCHANT_USER_ID,
                secretKey: env.CLICK_SECRET_KEY,
              })
            : null;
        return new RefundService(db, audit, clock, billing, click);
      },
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
