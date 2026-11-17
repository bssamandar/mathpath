/**
 * Risk scoring for sign-up, code requests and sign-in (security plan §6.2, C-20, C-21).
 *
 * A weighted sum of signals decides the action: allow, ask for an invisible
 * CAPTCHA, ask for an interactive one (step-up), or block and open a manual
 * review. Weights and bands live in config/risk.yaml.
 *
 * Why rules and not a machine-learning model: there is no fraud data yet,
 * and an admin can see exactly why a request was flagged. Every non-zero
 * decision is stored as a risk_event, so a model can be trained later.
 *
 * Signals that need data we do not have yet score nothing for now: IP
 * reputation and datacenter/VPN lists (need a local IP database, kept
 * in-country) and device signals (arrive with device tokens, C-22).
 */
import type { AppConfig } from '@mathpath/config';
import { type Database, newId } from '@mathpath/db';
import { type Kysely, sql } from 'kysely';
import { ProblemException } from '../common/problem';
import { perMinutes, type RateLimiter } from '../common/rate-limiter';
import type { CaptchaVerifier } from './captcha';
import type { SmsBudget } from './sms-budget';

export type RiskAction = 'allow' | 'invisible_captcha' | 'step_up' | 'block_and_review';
type RiskRules = AppConfig['risk'];
type SignalName = keyof RiskRules['signals'];

/** What is being attempted, and by whom as far as we know. */
export interface RiskInput {
  kind: 'otp_request' | 'login';
  phone: string;
  /** The account being signed in to, when it exists. */
  userId?: string | null;
  ipPrefix: string | null;
  /** True for user agents of scripts and headless browsers. */
  automationSuspected: boolean;
  captchaToken?: string | undefined;
}

export interface RiskAssessment {
  score: number;
  action: RiskAction;
  /** Weighted signals from config, plus `accountRestricted` after an admin decision. */
  signals: (SignalName | 'accountRestricted')[];
  /** The SMS budget is spent, so a CAPTCHA is needed regardless of score. */
  budgetExhausted: boolean;
}

const ORDER: RiskAction[] = ['allow', 'invisible_captcha', 'step_up', 'block_and_review'];

export class RiskService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly limiter: RateLimiter,
    private readonly captcha: CaptchaVerifier,
    private readonly budget: SmsBudget,
    private readonly rules: RiskRules,
    private readonly loginFailures: { limit: number; windowMinutes: number },
  ) {}

  /** Scores a request without acting on it. */
  async assess(input: RiskInput): Promise<RiskAssessment> {
    const weights = this.rules.signals;
    const signals: RiskAssessment['signals'] = [];
    let score = 0;
    const add = (name: SignalName, weight = weights[name]): void => {
      if (weight > 0) {
        signals.push(name);
        score += weight;
      }
    };

    if (await this.prefixBlocked(input.phone)) add('phonePrefixFlagged');
    if (input.automationSuspected) add('headlessOrEmulator');

    if (input.kind === 'otp_request') {
      // Half the per-network allowance used up is unusual for real families.
      const window = perMinutes(this.rules.otp.perIpPrefix);
      const used = await this.limiter.count(
        `otp:ip:${input.ipPrefix ?? 'unknown'}`,
        window.windowMs,
      );
      if (used >= Math.ceil(window.limit / 2)) add('otpVelocityExceeded');
    } else {
      const failures = await this.limiter.count(
        `login:account:${input.phone}`,
        perMinutes(this.loginFailures).windowMs,
      );
      if (failures > 0) {
        add(
          'failedLoginEach',
          Math.min(failures * weights.failedLoginEach, weights.failedLoginMax),
        );
      }
      // Approximation until device tokens exist: a network this account has
      // never signed in from before.
      if (input.userId && (await this.isNewNetwork(input.userId, input.ipPrefix))) {
        add('newDeviceAndNewIpPrefix');
      }
    }

    let action = this.actionFor(score);
    // An admin restricted this account after a review (S17): every sign-in
    // and code request needs an interactive CAPTCHA until it is cleared.
    if (
      input.userId &&
      ORDER.indexOf(action) < ORDER.indexOf('step_up') &&
      (await this.restricted(input.userId))
    ) {
      signals.push('accountRestricted');
      action = 'step_up';
    }
    const budgetExhausted = input.kind === 'otp_request' && (await this.budget.exhausted());
    if (budgetExhausted && ORDER.indexOf(action) < ORDER.indexOf('invisible_captcha')) {
      action = 'invisible_captcha';
    }
    return { score, action, signals, budgetExhausted };
  }

  /**
   * Scores a request, records the decision and enforces it.
   * @throws ProblemException 428 when a CAPTCHA is needed, 403 when blocked.
   */
  async enforce(input: RiskInput): Promise<RiskAssessment> {
    const assessment = await this.assess(input);
    const { action } = assessment;
    let captchaPassed = false;
    if ((action === 'invisible_captcha' || action === 'step_up') && input.captchaToken) {
      captchaPassed = await this.captcha.verify(input.captchaToken);
    }
    await this.record(input, assessment, captchaPassed);

    if (action === 'allow' || captchaPassed) return assessment;
    if (action === 'block_and_review') {
      if (input.userId) await this.openReview(input.userId, assessment);
      throw new ProblemException(
        403,
        'BLOCKED_FOR_REVIEW',
        'This request was blocked for a security check. Contact support if this is a mistake.',
      );
    }
    // The client shows the matching Turnstile widget and retries with its token.
    throw action === 'step_up'
      ? new ProblemException(
          428,
          'CAPTCHA_INTERACTIVE_REQUIRED',
          'Please confirm you are not a robot.',
        )
      : new ProblemException(428, 'CAPTCHA_REQUIRED', 'Please confirm you are not a robot.');
  }

  private actionFor(score: number): RiskAction {
    let action: RiskAction = 'allow';
    for (const band of this.rules.actions) if (score >= band.from) action = band.action;
    return action;
  }

  private async restricted(userId: string): Promise<boolean> {
    const user = await this.db
      .selectFrom('users')
      .select('risk_level')
      .where('id', '=', userId)
      .executeTakeFirst();
    return user?.risk_level === 'high';
  }

  private async prefixBlocked(phone: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('blocked_prefixes')
      .select('prefix')
      .where(sql<boolean>`${phone} LIKE prefix || '%'`)
      .executeTakeFirst();
    return row !== undefined;
  }

  private async isNewNetwork(userId: string, ipPrefix: string | null): Promise<boolean> {
    const rows = await this.db
      .selectFrom('sessions')
      .select(sql<boolean>`bool_or(ip_prefix IS NOT DISTINCT FROM ${ipPrefix}::inet)`.as('seen'))
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(rows.total) > 0 && !rows.seen;
  }

  /** Stores every decision that was not a plain zero-score allow. */
  private async record(input: RiskInput, a: RiskAssessment, captchaPassed: boolean): Promise<void> {
    if (a.score === 0 && !a.budgetExhausted) return;
    if (!input.userId && !input.ipPrefix) return; // the table needs a subject
    await this.db
      .insertInto('risk_events')
      .values({
        id: newId(),
        user_id: input.userId ?? null,
        ip_prefix: input.ipPrefix,
        type: `${input.kind}.${a.action}`,
        score_delta: a.score,
        details: { signals: a.signals, budgetExhausted: a.budgetExhausted, captchaPassed },
      })
      .execute();
  }

  private async openReview(userId: string, a: RiskAssessment): Promise<void> {
    const open = await this.db
      .selectFrom('risk_reviews')
      .select('id')
      .where('subject_user_id', '=', userId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (open) return;
    await this.db
      .insertInto('risk_reviews')
      .values({
        id: newId(),
        subject_user_id: userId,
        reason: `score ${a.score}: ${a.signals.join(', ')}`,
      })
      .execute();
  }
}
