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
import { PromoService } from './promo.service';
import { PAYMENT_PROVIDERS, type PaymentProvider } from './payment-provider';
import type { ClickProvider } from './click/click';
import type { PaymeProvider } from './payme/payme';

const id = z.uuid();
const planCode = z.string().min(1).max(64);
const promoCode = z.string().trim().min(1).max(32);

const promoCheckBody = z.object({ code: promoCode, planCode }).strict();

const trialBody = z
  .object({
    studentIds: z.array(id).min(1).max(10),
    deviceToken: z.string().min(1).max(512).optional(),
  })
  .strict();

const promoBody = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9_-]{4,32}$/),
    discountType: z.enum(['percent', 'fixed']),
    value: z.number().int().min(1).max(100_000_000_000),
    planCodes: z.array(planCode).max(20).optional(),
    maxRedemptions: z.number().int().min(1).max(1_000_000).optional(),
    perUserLimit: z.number().int().min(1).max(100).optional(),
    validFrom: z.iso.datetime({ offset: true }),
    validTo: z.iso.datetime({ offset: true }),
  })
  .strict();

const checkoutBody = z
  .object({
    planCode,
    provider: z.enum(['payme', 'click']),
    studentIds: z.array(id).min(1).max(10),
    promoCode: promoCode.optional(),
    saveCardForRenewal: z.boolean().optional(),
    returnUrl: z.url().max(500).optional(),
  })
  .strict();

@Controller()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly promo: PromoService,
    @Inject(BUSINESS_RULES) private readonly rules: AppConfig,
  ) {}

  /**
   * GET /plans: public, so the pricing page works before sign-up. Also says
   * which payment providers are on and how long the free trial is.
   */
  @Get('plans')
  @Access('public')
  plans() {
    return {
      items: this.billing.plans(),
      providers: this.billing.providerCodes(),
      trialDays: this.rules.billing.trialDays,
    };
  }

  /** POST /promo-codes/validate: the discounted price, or why the code does not apply. */
  @Post('promo-codes/validate')
  @HttpCode(200)
  @Access('billing:purchase')
  validatePromo(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = parseInput(promoCheckBody, body);
    return this.promo.check(req.auth!.userId, input.code, input.planCode);
  }

  /** POST /trials: the free trial for some of the parent's children. */
  @Post('trials')
  @Access('billing:purchase')
  startTrial(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.billing.startTrial(req.auth!.userId, parseInput(trialBody, body));
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
    const [items, trialAvailable] = await Promise.all([
      this.billing.subscriptions(req.auth!.userId),
      this.billing.trialAvailable(req.auth!.userId),
    ]);
    return { items, trialAvailable };
  }

  @Post('subscriptions/:subscriptionId/cancel')
  @HttpCode(200)
  @Access('billing:manage')
  cancel(@Req() req: AuthedRequest, @Param('subscriptionId') subscriptionId: unknown) {
    return this.billing.cancel(req.auth!.userId, parseInput(id, subscriptionId));
  }
}

/** Promo codes for admins (studio). */
@Controller('admin/promo-codes')
export class AdminPromoController {
  constructor(private readonly promo: PromoService) {}

  @Get()
  @Access('admin:billing')
  async list() {
    return { items: await this.promo.list() };
  }

  @Post()
  @Access('admin:billing')
  create(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.promo.create(req.auth!.userId, parseInput(promoBody, body));
  }

  @Post(':promoCodeId/deactivate')
  @HttpCode(200)
  @Access('admin:billing')
  deactivate(@Req() req: AuthedRequest, @Param('promoCodeId') promoCodeId: unknown) {
    return this.promo.deactivate(req.auth!.userId, parseInput(id, promoCodeId));
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

  /**
   * POST /payments/click/{prepare|complete}: Click Shop API (form-encoded,
   * always HTTP 200 with Click's error codes).
   */
  @Post('click/:stage')
  @HttpCode(200)
  @Access('provider:click')
  async clickCallback(@Param('stage') stage: unknown, @Body() body: unknown) {
    const click = this.providers.get('click') as ClickProvider | undefined;
    if (!click) throw new ProblemException(404, 'PROVIDER_UNAVAILABLE', 'Click is not enabled.');
    if (stage !== 'prepare' && stage !== 'complete') {
      throw new ProblemException(404, 'NOT_FOUND', 'Unknown Click stage.');
    }
    return click.handle(stage, body);
  }
}
