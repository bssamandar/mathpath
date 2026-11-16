/**
 * Orders and subscriptions (architecture §5.5; ADR-0008).
 *
 * A parent buys a plan for some of their children: checkout snapshots the
 * price onto an order and returns the provider's payment page. The provider
 * then calls its adapter (payme/), which uses {@link BillingService.fulfil}
 * and {@link BillingService.revoke} inside its own database transaction, so a
 * payment and the access it grants change together or not at all.
 */
import { createHash } from 'node:crypto';
import { type Database, newId, type SubscriptionStatus } from '@mathpath/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { AuditService } from '../audit/audit.service';
import type { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import type { PaymentProvider } from './payment-provider';
import type { PromoService } from './promo.service';
import {
  type BillingRules,
  findPlan,
  type Money,
  money,
  periodEnd,
  type PlanView,
  planViews,
} from './plans';

export interface CheckoutInput {
  planCode: string;
  provider: 'payme' | 'click';
  studentIds: string[];
  promoCode?: string;
  returnUrl?: string;
  locale: string;
}

export interface CheckoutView {
  orderId: string;
  amount: Money;
  redirectUrl: string;
  expiresAt: string;
}

/** OpenAPI `Subscription`. Saved cards come with auto-renewal. */
export interface SubscriptionView {
  id: string;
  planCode: string;
  status: SubscriptionStatus;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  studentIds: string[];
  paymentMethod: null;
}

export interface OrderView {
  orderId: string;
  status: 'created' | 'pending' | 'paid' | 'cancelled' | 'expired';
  amount: Money;
  subscription?: SubscriptionView;
}

/** The plan code of a free trial's subscription. */
export const TRIAL_PLAN = 'trial';

const notFound = () => new ProblemException(404, 'ORDER_NOT_FOUND', 'This order does not exist.');

export class BillingService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly rules: BillingRules,
    private readonly providers: ReadonlyMap<string, PaymentProvider>,
    /** Origins a return URL may point to (the web apps). */
    private readonly returnOrigins: readonly string[],
    private readonly promo: PromoService,
  ) {}

  plans(): PlanView[] {
    return planViews(this.rules);
  }

  /** The payment providers switched on, in the order checkout offers them. */
  providerCodes(): string[] {
    return (['payme', 'click'] as const).filter((code) => this.providers.has(code));
  }

  /**
   * Creates an order with the plan price from config and returns the
   * provider's payment page. A repeated Idempotency-Key returns the same order.
   * @throws ProblemException 422 for an unknown plan, an unavailable
   *   provider, a promo code that does not apply or a return URL off our
   *   origins; 404 when a student is not the parent's child; 409 for too many
   *   children; 429 after too many promo code checks.
   */
  async checkout(ownerId: string, input: CheckoutInput, key: string): Promise<CheckoutView> {
    const existing = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (existing) return this.checkoutView(existing, input.locale);

    const plan = findPlan(this.rules, input.planCode);
    if (!plan) {
      throw new ProblemException(422, 'PLAN_NOT_FOUND', 'This plan is not offered.', {
        errors: [{ field: 'planCode', message: 'unknown plan' }],
      });
    }
    if (!this.providers.has(input.provider)) {
      throw new ProblemException(
        422,
        'PROVIDER_UNAVAILABLE',
        'This payment method is not available.',
        { errors: [{ field: 'provider', message: 'not enabled' }] },
      );
    }
    const returnUrl = input.returnUrl ? this.checkReturnUrl(input.returnUrl) : null;
    const studentIds = await this.ownChildren(ownerId, input.studentIds, plan.maxStudents);
    const quote = input.promoCode
      ? await this.promo.quote(ownerId, input.promoCode, plan.code, plan.priceTiyin)
      : null;
    const amountTiyin = quote?.amountTiyin ?? plan.priceTiyin;

    const now = this.clock.now();
    const id = newId();
    const row = await this.db
      .insertInto('orders')
      .values({
        id,
        owner_id: ownerId,
        plan_code: plan.code,
        plan_interval: plan.interval,
        student_ids: studentIds,
        amount_tiyin: amountTiyin,
        discount_tiyin: quote?.discountTiyin ?? 0,
        promo_code_id: quote?.promoCodeId ?? null,
        provider: input.provider,
        idempotency_key: key,
        return_url: returnUrl,
        expires_at: new Date(now.getTime() + this.rules.orderExpiresMinutes * 60_000),
        created_at: now,
        updated_at: now,
      })
      // Two requests with the same key at once: the second one reads the first.
      .onConflict((oc) => oc.columns(['owner_id', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
    const order =
      row ??
      (await this.db
        .selectFrom('orders')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .where('idempotency_key', '=', key)
        .executeTakeFirstOrThrow());
    if (row) {
      await this.audit.record({
        action: 'billing.order_created',
        actorId: ownerId,
        targetType: 'order',
        targetId: id,
        metadata: {
          planCode: plan.code,
          provider: input.provider,
          amountTiyin,
          ...(quote ? { promoCodeId: quote.promoCodeId, discountTiyin: quote.discountTiyin } : {}),
        },
      });
    }
    return this.checkoutView(order, input.locale);
  }

  /** The order for the return page; only its owner may see it. */
  async order(ownerId: string, orderId: string): Promise<OrderView> {
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!order) throw notFound();
    const status =
      order.status === 'created' && order.expires_at <= this.clock.now() ? 'expired' : order.status;
    const view: OrderView = {
      orderId: order.id,
      status,
      amount: money(Number(order.amount_tiyin)),
    };
    if (status === 'paid') {
      const sub = await this.db
        .selectFrom('subscriptions')
        .select('id')
        .where('order_id', '=', order.id)
        .executeTakeFirst();
      if (sub) view.subscription = (await this.subscriptionViews(ownerId, sub.id))[0];
    }
    return view;
  }

  subscriptions(ownerId: string): Promise<SubscriptionView[]> {
    return this.subscriptionViews(ownerId);
  }

  /** Whether this parent may still start the free trial. */
  async trialAvailable(ownerId: string): Promise<boolean> {
    if (this.rules.trialDays === 0) return false;
    const used = await this.db
      .selectFrom('trials')
      .select('id')
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return !used;
  }

  /**
   * POST /trials: a free trial of every paid topic for some of the parent's
   * children, once per account, per child and (when the app sends one) per
   * device. It does not renew and needs no card.
   * @throws ProblemException 422 TRIAL_UNAVAILABLE when trials are off;
   *   409 TRIAL_USED, ALREADY_SUBSCRIBED or TOO_MANY_STUDENTS; 404 STUDENT_NOT_FOUND.
   */
  async startTrial(
    ownerId: string,
    input: { studentIds: string[]; deviceToken?: string },
  ): Promise<SubscriptionView> {
    const days = this.rules.trialDays;
    if (days === 0) {
      throw new ProblemException(422, 'TRIAL_UNAVAILABLE', 'Free trials are not offered.');
    }
    const maxStudents = Math.max(...this.rules.plans.map((p) => p.maxStudents));
    const studentIds = await this.ownChildren(ownerId, input.studentIds, maxStudents);
    const trialUsed = () =>
      new ProblemException(409, 'TRIAL_USED', 'The free trial has already been used.');
    const now = this.clock.now();
    const deviceHash = input.deviceToken
      ? createHash('sha256').update(input.deviceToken).digest('hex')
      : null;

    const id = await this.db.transaction().execute(async (trx) => {
      const earlier = await trx
        .selectFrom('subscriptions as s')
        .innerJoin('subscription_members as m', 'm.subscription_id', 's.id')
        .select(['s.plan_code', 's.status', 's.current_period_end'])
        .where('m.student_id', 'in', studentIds)
        .execute();
      // A child gets one trial, even when a second parent asks for it.
      if (earlier.some((s) => s.plan_code === TRIAL_PLAN)) throw trialUsed();
      if (
        earlier.some(
          (s) => (s.status === 'active' || s.status === 'trialing') && s.current_period_end > now,
        )
      ) {
        throw new ProblemException(
          409,
          'ALREADY_SUBSCRIBED',
          'This child already has a subscription.',
          { errors: [{ field: 'studentIds', message: 'already covered' }] },
        );
      }
      const subscriptionId = newId();
      const end = new Date(now.getTime() + days * 86_400_000);
      await trx
        .insertInto('subscriptions')
        .values({
          id: subscriptionId,
          owner_id: ownerId,
          plan_code: TRIAL_PLAN,
          status: 'trialing',
          seats: studentIds.length,
          price_tiyin: 0,
          current_period_start: now,
          current_period_end: end,
          // A trial never renews by itself.
          cancel_at_period_end: true,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await trx
        .insertInto('subscription_members')
        .values(studentIds.map((student_id) => ({ subscription_id: subscriptionId, student_id })))
        .execute();
      // The unique keys on owner and device refuse a second trial, also under a race.
      const inserted = await trx
        .insertInto('trials')
        .values({
          id: newId(),
          owner_id: ownerId,
          device_hash: deviceHash,
          subscription_id: subscriptionId,
          started_at: now,
          ends_at: end,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) throw trialUsed();
      await this.audit.record(
        {
          action: 'billing.trial_started',
          actorId: ownerId,
          targetType: 'subscription',
          targetId: subscriptionId,
          metadata: { students: studentIds.length, days },
        },
        trx,
      );
      return subscriptionId;
    });
    return (await this.subscriptionViews(ownerId, id))[0]!;
  }

  /**
   * Turns off renewal; access continues until the period ends.
   * @throws ProblemException 404 when the subscription is not the caller's.
   */
  async cancel(ownerId: string, subscriptionId: string): Promise<SubscriptionView> {
    const updated = await this.db
      .updateTable('subscriptions')
      .set({ cancel_at_period_end: true, updated_at: this.clock.now() })
      .where('id', '=', subscriptionId)
      .where('owner_id', '=', ownerId)
      .returning('id')
      .executeTakeFirst();
    if (!updated) {
      throw new ProblemException(
        404,
        'SUBSCRIPTION_NOT_FOUND',
        'This subscription does not exist.',
      );
    }
    await this.audit.record({
      action: 'billing.subscription_cancelled',
      actorId: ownerId,
      targetType: 'subscription',
      targetId: subscriptionId,
    });
    return (await this.subscriptionViews(ownerId, subscriptionId))[0]!;
  }

  /**
   * Grants what a paid order bought: a subscription for its children. When a
   * child is still covered, the new period starts where that coverage ends,
   * so paying early never loses days. Runs in the adapter's transaction.
   * @returns The new subscription's ID.
   */
  async fulfil(
    trx: Transaction<Database>,
    orderId: string,
    paymentId: string,
    paidAt: Date,
  ): Promise<string> {
    const order = await trx
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();
    const covered = await trx
      .selectFrom('subscriptions as s')
      .innerJoin('subscription_members as m', 'm.subscription_id', 's.id')
      .select(sql<Date | null>`max(s.current_period_end)`.as('until'))
      .where('m.student_id', 'in', order.student_ids)
      .where('s.status', 'in', ['trialing', 'active'])
      .where('s.current_period_end', '>', paidAt)
      .executeTakeFirst();
    const start = covered?.until && covered.until > paidAt ? covered.until : paidAt;
    const id = newId();
    await trx
      .insertInto('subscriptions')
      .values({
        id,
        owner_id: order.owner_id,
        order_id: order.id,
        plan_code: order.plan_code,
        status: 'active',
        seats: order.student_ids.length,
        price_tiyin: Number(order.amount_tiyin),
        current_period_start: start,
        current_period_end: periodEnd(start, order.plan_interval),
        created_at: paidAt,
        updated_at: paidAt,
      })
      .execute();
    await trx
      .insertInto('subscription_members')
      .values(order.student_ids.map((student_id) => ({ subscription_id: id, student_id })))
      .execute();
    await trx
      .updateTable('orders')
      .set({ status: 'paid', paid_at: paidAt, updated_at: paidAt })
      .where('id', '=', order.id)
      .execute();
    await trx
      .updateTable('payments')
      .set({ subscription_id: id })
      .where('id', '=', paymentId)
      .execute();
    await this.promo.redeem(trx, order, paidAt);
    // Receipts, notifications and referral checks run from the outbox (ADR-0007).
    await trx
      .insertInto('outbox_events')
      .values({
        id: newId(),
        aggregate_type: 'order',
        aggregate_id: order.id,
        event_type: 'PaymentSucceeded',
        payload: {
          orderId: order.id,
          paymentId,
          subscriptionId: id,
          ownerId: order.owner_id,
          amountTiyin: Number(order.amount_tiyin),
        },
        created_at: paidAt,
      })
      .execute();
    await this.audit.record(
      {
        action: 'billing.order_paid',
        actorId: null,
        targetType: 'order',
        targetId: order.id,
        metadata: { paymentId, subscriptionId: id, amountTiyin: Number(order.amount_tiyin) },
      },
      trx,
    );
    return id;
  }

  /**
   * Takes back what a refunded order granted: its subscription ends now.
   * Runs in the adapter's transaction.
   */
  async revoke(trx: Transaction<Database>, orderId: string, at: Date): Promise<void> {
    const subs = await trx
      .updateTable('subscriptions')
      .set({ status: 'cancelled', current_period_end: at, updated_at: at })
      .where('order_id', '=', orderId)
      .where('current_period_start', '<', at)
      .returning('id')
      .execute();
    // A period that had not started yet (paid early) is cancelled as it stands.
    await trx
      .updateTable('subscriptions')
      .set({ status: 'cancelled', updated_at: at })
      .where('order_id', '=', orderId)
      .where('status', '<>', 'cancelled')
      .execute();
    await trx
      .insertInto('outbox_events')
      .values({
        id: newId(),
        aggregate_type: 'order',
        aggregate_id: orderId,
        event_type: 'PaymentRefunded',
        payload: { orderId, subscriptionIds: subs.map((s) => s.id) },
        created_at: at,
      })
      .execute();
    await this.audit.record(
      { action: 'billing.order_refunded', actorId: null, targetType: 'order', targetId: orderId },
      trx,
    );
  }

  private checkoutView(
    order: {
      id: string;
      amount_tiyin: unknown;
      provider: string;
      return_url: string | null;
      expires_at: Date;
    },
    locale: string,
  ): CheckoutView {
    const provider = this.providers.get(order.provider);
    if (!provider) {
      throw new ProblemException(
        422,
        'PROVIDER_UNAVAILABLE',
        'This payment method is not available.',
      );
    }
    const amountTiyin = Number(order.amount_tiyin);
    return {
      orderId: order.id,
      amount: money(amountTiyin),
      redirectUrl: provider.checkoutUrl({
        orderId: order.id,
        amountTiyin,
        returnUrl: order.return_url,
        locale,
      }),
      expiresAt: order.expires_at.toISOString(),
    };
  }

  /**
   * The distinct children, checked to be this parent's own and within the plan's seats.
   * @throws ProblemException 409 TOO_MANY_STUDENTS, 404 STUDENT_NOT_FOUND.
   */
  private async ownChildren(
    ownerId: string,
    ids: string[],
    maxStudents: number,
  ): Promise<string[]> {
    const studentIds = [...new Set(ids)];
    if (studentIds.length > maxStudents) {
      throw new ProblemException(409, 'TOO_MANY_STUDENTS', 'This plan covers fewer children.', {
        errors: [{ field: 'studentIds', message: `at most ${maxStudents}` }],
      });
    }
    const linked = await this.db
      .selectFrom('parent_child_links as l')
      .innerJoin('users as u', 'u.id', 'l.child_id')
      .select('l.child_id')
      .where('l.parent_id', '=', ownerId)
      .where('l.child_id', 'in', studentIds)
      .where('u.deleted_at', 'is', null)
      .execute();
    if (linked.length !== studentIds.length) {
      throw new ProblemException(404, 'STUDENT_NOT_FOUND', 'This child is not in your family.', {
        errors: [{ field: 'studentIds', message: 'not your child' }],
      });
    }
    return studentIds;
  }

  /** A return URL must be on one of our own web origins (no open redirect). */
  private checkReturnUrl(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      parsed = new URL('invalid:');
    }
    if (!this.returnOrigins.includes(parsed.origin) || url.includes(';')) {
      throw new ProblemException(
        422,
        'RETURN_URL_NOT_ALLOWED',
        'This return address is not allowed.',
        {
          errors: [{ field: 'returnUrl', message: 'must be on a MathPath origin' }],
        },
      );
    }
    return parsed.toString();
  }

  private async subscriptionViews(ownerId: string, id?: string): Promise<SubscriptionView[]> {
    let query = this.db
      .selectFrom('subscriptions as s')
      .select([
        's.id',
        's.plan_code',
        's.status',
        's.current_period_end',
        's.cancel_at_period_end',
        sql<string[]>`coalesce(array(
          SELECT m.student_id FROM subscription_members m
          WHERE m.subscription_id = s.id ORDER BY m.student_id
        ), '{}')`.as('student_ids'),
      ])
      .where('s.owner_id', '=', ownerId)
      .orderBy('s.current_period_end', 'desc');
    if (id) query = query.where('s.id', '=', id);
    const rows = await query.execute();
    const now = this.clock.now();
    return rows.map((r) => ({
      id: r.id,
      planCode: r.plan_code,
      // A period that ended is reported as expired before the nightly job marks it.
      status:
        (r.status === 'active' || r.status === 'trialing') && r.current_period_end <= now
          ? 'expired'
          : r.status,
      currentPeriodEnd: r.current_period_end.toISOString(),
      cancelAtPeriodEnd: r.cancel_at_period_end,
      studentIds: r.student_ids,
      paymentMethod: null,
    }));
  }
}
