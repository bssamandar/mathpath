/**
 * "May this learner use paid content?" (architecture §4, `entitlements`).
 * A learner is covered while a trialing or active subscription lists them
 * and its period has not ended. Cancelling auto-renewal keeps access until
 * the period ends; a refund ends the period at once.
 */
import type { Database } from '@mathpath/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../common/clock';
import { Entitlements } from '../content/catalogue.service';

export class SubscriptionEntitlements extends Entitlements {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
  ) {
    super();
  }

  /** Every paid topic is open to a covered learner. */
  hasAccess(userId: string): Promise<boolean> {
    return this.hasSubscription(userId);
  }

  async hasSubscription(userId: string, db: Kysely<Database> = this.db): Promise<boolean> {
    const row = await db
      .selectFrom('subscription_members as m')
      .innerJoin('subscriptions as s', 's.id', 'm.subscription_id')
      .select('s.id')
      .where('m.student_id', '=', userId)
      .where('s.status', 'in', ['trialing', 'active'])
      .where('s.current_period_end', '>', this.clock.now())
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }
}
