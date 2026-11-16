/**
 * Billing endpoints (docs/api/openapi.yaml, tags Billing and PaymentCallbacks).
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AppConfig } from '@mathpath/config';
import { z } from 'zod';
import { ProblemException } from '../common/problem';
import { parseInput } from '../common/validation';
import { BUSINESS_RULES } from '../config/tokens';
import { readerLocale } from '../content/content.controller';
import type { AuthedRequest } from '../identity/auth.guard';
import { Access } from '../identity/permissions';
import { BillingService } from './billing.service';
import { PAYMENT_PROVIDERS, type PaymentProvider } from './payment-provider';
import type { PaymeProvider } from './payme/payme';

const id = z.uuid();

const checkoutBody = z
  .object({
    planCode: z.string().min(1).max(64),
    provider: z.enum(['payme', 'click']),
    studentIds: z.array(id).min(1).max(10),
    promoCode: z.string().trim().min(1).max(32).optional(),
    saveCardForRenewal: z.boolean().optional(),
    returnUrl: z.url().max(500).optional(),
  })
  .strict();

@Controller()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    @Inject(BUSINESS_RULES) private readonly rules: AppConfig,
  ) {}

  /** GET /plans: public, so the pricing page works before sign-up. */
  @Get('plans')
  @Access('public')
  plans() {
    return { items: this.billing.plans() };
  }

  /**
   * POST /checkout. The Idempotency-Key is required here: a parent who taps
   * "Pay" twice must get one order, not two.
   */
  @Post('checkout')
  @Access('billing:purchase')
  async checkout(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Query('locale') locale: unknown,
  ) {
    if (key === undefined) {
      throw new ProblemException(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send an Idempotency-Key header.',
      );
    }
    const input = parseInput(checkoutBody, body);
    return this.billing.checkout(
      req.auth!.userId,
      { ...input, locale: readerLocale(req, locale, this.rules.content.defaultLocale) },
      parseInput(id, key),
    );
  }

  /** GET /orders/{orderId}: polled by the return page. */
  @Get('orders/:orderId')
  @Access('billing:read')
  order(@Req() req: AuthedRequest, @Param('orderId') orderId: unknown) {
    return this.billing.order(req.auth!.userId, parseInput(id, orderId));
  }

  @Get('subscriptions')
  @Access('billing:read')
  async subscriptions(@Req() req: AuthedRequest) {
    return { items: await this.billing.subscriptions(req.auth!.userId) };
  }

  @Post('subscriptions/:subscriptionId/cancel')
  @HttpCode(200)
  @Access('billing:manage')
  cancel(@Req() req: AuthedRequest, @Param('subscriptionId') subscriptionId: unknown) {
    return this.billing.cancel(req.auth!.userId, parseInput(id, subscriptionId));
  }
}

/**
 * Provider callbacks. They carry no session: each adapter authenticates its
 * provider's own credentials before reading the body (C-27).
 */
@Controller('payments')
export class PaymentCallbacksController {
  constructor(
    @Inject(PAYMENT_PROVIDERS) private readonly providers: ReadonlyMap<string, PaymentProvider>,
  ) {}

  /** POST /payments/payme: Payme Merchant API (JSON-RPC, always HTTP 200). */
  @Post('payme')
  @HttpCode(200)
  @Access('provider:payme')
  async paymeCallback(@Headers('authorization') authorization: unknown, @Body() body: unknown) {
    const payme = this.providers.get('payme') as PaymeProvider | undefined;
    if (!payme) throw new ProblemException(404, 'PROVIDER_UNAVAILABLE', 'Payme is not enabled.');
    return payme.handle(typeof authorization === 'string' ? authorization : undefined, body);
  }
}
