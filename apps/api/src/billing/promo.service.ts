/**
 * Promo codes (schema doc §3.10; step 6.5c). Admins create codes; parents
 * check one against a plan and apply it at checkout. A code is used up only
 * when the order is paid (`promo_redemptions` is written in the payment's
 * transaction), so abandoned orders never consume it.
 *
 * Checks are rate-limited per parent, because a short code can be guessed.
 */
import type { Database, DiscountType } from '@mathpath/db';
import { newId } from '@mathpath/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import { perMinutes, type RateLimiter, type RateWindow } from '../common/rate-limiter';
import { type BillingRules, findPlan, type Money, money } from './plans';

/** Why a code does not apply; shown to the parent in their language by the web app. */
export type PromoRefusal =
  | 'not_found'
  | 'not_started'
  | 'expired'
  | 'plan'
  | 'used_up'
  | 'already_used'
  | 'too_large';

export interface PromoQuote {
  promoCodeId: string;
  discountTiyin: number;
  amountTiyin: number;
}

export type PromoCheck =
  | { valid: true; amount: Money; discount: Money }
  | { valid: false; reason: PromoRefusal };

export interface PromoInput {
  code: string;
  discountType: DiscountType;
  value: number;
  planCodes?: string[];
  maxRedemptions?: number;
  perUserLimit?: number;
  validFrom: string;
  validTo: string;
}

export interface PromoView {
  id: string;
  code: string;
  discountType: DiscountType;
  value: number;
  planCodes: string[] | null;
  maxRedemptions: number | null;
  perUserLimit: number;
  validFrom: string;
  validTo: string;
  isActive: boolean;
  redemptions: number;
}

class Refused extends Error {
  constructor(readonly reason: PromoRefusal) {
    super(reason);
  }
}

export const normaliseCode = (code: string) => code.trim().toUpperCase();

const tooMany = (retryAfterS: number) =>
  new ProblemException(429, 'TOO_MANY_REQUESTS', 'Too many promo code checks. Try again later.', {
    retryAfterS,
  });

export class PromoService {
  private readonly window: RateWindow;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly rules: BillingRules,
    private readonly limiter: RateLimiter,
    checksPerUser: { limit: number; windowMinutes: number },
  ) {
    this.window = perMinutes(checksPerUser);
  }

  /** POST /promo-codes/validate: the price with this code, or why it does not apply. */
  async check(ownerId: string, code: string, planCode: string): Promise<PromoCheck> {
    await this.consume(ownerId);
    const plan = findPlan(this.rules, planCode);
    if (!plan) {
      throw new ProblemException(422, 'PLAN_NOT_FOUND', 'This plan is not offered.', {
        errors: [{ field: 'planCode', message: 'unknown plan' }],
      });
    }
    try {
      const quote = await this.quoteOrRefuse(this.db, ownerId, code, plan.code, plan.priceTiyin);
      return {
        valid: true,
        amount: money(quote.amountTiyin),
        discount: money(quote.discountTiyin),
      };
    } catch (error) {
      if (error instanceof Refused) return { valid: false, reason: error.reason };
      throw error;
    }
  }

  /**
   * The discounted price for checkout, counted against the same rate limit.
   * @throws ProblemException 422 PROMO_INVALID with the reason as the field message.
   */
  async quote(
    ownerId: string,
    code: string,
    planCode: string,
    priceTiyin: number,
  ): Promise<PromoQuote> {
    await this.consume(ownerId);
    try {
      return await this.quoteOrRefuse(this.db, ownerId, code, planCode, priceTiyin);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      throw new ProblemException(422, 'PROMO_INVALID', 'This promo code is not valid.', {
        errors: [{ field: 'promoCode', message: error.reason }],
      });
    }
  }

  /**
   * Records that a paid order used its code. Runs in the payment's
   * transaction. Two parents paying at the same moment can take a code one
   * past its limit; refusing a payment that already went through would be worse.
   */
  async redeem(
    trx: Transaction<Database>,
    order: { id: string; owner_id: string; promo_code_id: string | null },
    at: Date,
  ): Promise<void> {
    if (!order.promo_code_id) return;
    await trx
      .insertInto('promo_redemptions')
      .values({
        promo_code_id: order.promo_code_id,
        order_id: order.id,
        owner_id: order.owner_id,
        created_at: at,
      })
      .onConflict((oc) => oc.columns(['promo_code_id', 'order_id']).doNothing())
      .execute();
  }

  /**
   * POST /admin/promo-codes.
   * @throws ProblemException 409 PROMO_CODE_EXISTS, 422 for a plan that is
   *   not offered or a percentage over 100.
   */
  async create(adminId: string, input: PromoInput): Promise<PromoView> {
    const code = normaliseCode(input.code);
    for (const planCode of input.planCodes ?? []) {
      if (!findPlan(this.rules, planCode)) {
        throw new ProblemException(422, 'PLAN_NOT_FOUND', 'This plan is not offered.', {
          errors: [{ field: 'planCodes', message: `unknown plan ${planCode}` }],
        });
      }
    }
    if (input.discountType === 'percent' && input.value > 100) {
      throw new ProblemException(422, 'VALIDATION_FAILED', 'A percentage is at most 100.', {
        errors: [{ field: 'value', message: 'at most 100 for a percent discount' }],
      });
    }
    const validFrom = new Date(input.validFrom);
    const validTo = new Date(input.validTo);
    if (validTo <= validFrom) {
      throw new ProblemException(422, 'VALIDATION_FAILED', 'The code must end after it starts.', {
        errors: [{ field: 'validTo', message: 'must be after validFrom' }],
      });
    }
    const id = newId();
    const row = await this.db
      .insertInto('promo_codes')
      .values({
        id,
        code,
        discount_type: input.discountType,
        value: input.value,
        plan_codes: input.planCodes?.length ? input.planCodes : null,
        max_redemptions: input.maxRedemptions ?? null,
        per_user_limit: input.perUserLimit ?? 1,
        valid_from: validFrom,
        valid_to: validTo,
        created_by: adminId,
        created_at: this.clock.now(),
      })
      .onConflict((oc) => oc.column('code').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!row) {
      throw new ProblemException(409, 'PROMO_CODE_EXISTS', 'This promo code already exists.', {
        errors: [{ field: 'code', message: 'already exists' }],
      });
    }
    await this.audit.record({
      action: 'billing.promo_created',
      actorId: adminId,
      targetType: 'promo_code',
      targetId: id,
      metadata: { code, discountType: input.discountType, value: input.value },
    });
    return (await this.list(id))[0]!;
  }

  /** GET /admin/promo-codes, newest first, with how many paid orders used each. */
  async list(id?: string): Promise<PromoView[]> {
    let query = this.db
      .selectFrom('promo_codes as p')
      .selectAll('p')
      .select((eb) =>
        eb
          .selectFrom('promo_redemptions as r')
          .whereRef('r.promo_code_id', '=', 'p.id')
          .select(eb.fn.countAll<string>().as('n'))
          .as('redemptions'),
      )
      .orderBy('p.created_at', 'desc')
      .limit(500);
    if (id) query = query.where('p.id', '=', id);
    const rows = await query.execute();
    return rows.map((p) => ({
      id: p.id,
      code: p.code,
      discountType: p.discount_type,
      value: Number(p.value),
      planCodes: p.plan_codes,
      maxRedemptions: p.max_redemptions,
      perUserLimit: p.per_user_limit,
      validFrom: p.valid_from.toISOString(),
      validTo: p.valid_to.toISOString(),
      isActive: p.is_active,
      redemptions: Number(p.redemptions ?? 0),
    }));
  }

  /** POST /admin/promo-codes/{id}/deactivate: stops new uses; paid orders keep their price. */
  async deactivate(adminId: string, id: string): Promise<PromoView> {
    const row = await this.db
      .updateTable('promo_codes')
      .set({ is_active: false })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    if (!row)
      throw new ProblemException(404, 'PROMO_CODE_NOT_FOUND', 'This promo code does not exist.');
    await this.audit.record({
      action: 'billing.promo_deactivated',
      actorId: adminId,
      targetType: 'promo_code',
      targetId: id,
    });
    return (await this.list(id))[0]!;
  }

  private async consume(ownerId: string): Promise<void> {
    const result = await this.limiter.consume(`promo:${ownerId}`, this.window);
    if (!result.allowed) throw tooMany(result.retryAfterS);
  }

  private async quoteOrRefuse(
    db: Kysely<Database>,
    ownerId: string,
    rawCode: string,
    planCode: string,
    priceTiyin: number,
  ): Promise<PromoQuote> {
    const code = normaliseCode(rawCode);
    const promo = await db
      .selectFrom('promo_codes')
      .selectAll()
      .where('code', '=', code)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!promo) throw new Refused('not_found');
    const now = this.clock.now();
    if (now < promo.valid_from) throw new Refused('not_started');
    if (now >= promo.valid_to) throw new Refused('expired');
    if (promo.plan_codes && !promo.plan_codes.includes(planCode)) throw new Refused('plan');
    const used = await db
      .selectFrom('promo_redemptions')
      .select((eb) => [
        eb.fn.countAll<string>().as('all'),
        eb.fn.count<string>('order_id').filterWhere('owner_id', '=', ownerId).as('mine'),
      ])
      .where('promo_code_id', '=', promo.id)
      .executeTakeFirstOrThrow();
    if (promo.max_redemptions !== null && Number(used.all) >= promo.max_redemptions) {
      throw new Refused('used_up');
    }
    if (Number(used.mine) >= promo.per_user_limit) throw new Refused('already_used');
    const value = Number(promo.value);
    const discountTiyin =
      promo.discount_type === 'percent' ? Math.floor((priceTiyin * value) / 100) : value;
    // A code may not make a plan free: the providers need a positive amount.
    if (discountTiyin >= priceTiyin) throw new Refused('too_large');
    return { promoCodeId: promo.id, discountTiyin, amountTiyin: priceTiyin - discountTiyin };
  }
}
