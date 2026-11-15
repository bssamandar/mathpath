/**
 * Zod schemas for every business-rule file in /config.
 *
 * Each schema mirrors one YAML file. Cross-field rules (for example "the
 * solution is shown after the hint, not before") are expressed as refinements
 * so a wrong value stops the app at start-up instead of misbehaving later.
 */
import { z } from 'zod';

const fraction = z.number().min(0).max(1);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().min(0);
const window = z.object({ limit: positiveInt, windowMinutes: positiveInt }).strict();
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24-hour clock)');

/** Returns true when every number is strictly greater than the one before it. */
export function isStrictlyAscending(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > values[index - 1]!);
}

export const learningSchema = z
  .object({
    masteryThreshold: fraction,
    reviewIntervalsDays: z
      .array(positiveInt)
      .min(1)
      .refine(isStrictlyAscending, 'review intervals must grow over time'),
    practice: z
      .object({
        hintAfterMistakes: positiveInt,
        solutionAfterMistakes: positiveInt,
        minCorrectBeforeMasteryTest: positiveInt,
      })
      .strict()
      .refine((p) => p.solutionAfterMistakes > p.hintAfterMistakes, {
        message: 'the full solution must come after the hint',
        path: ['solutionAfterMistakes'],
      }),
    gapRouting: z
      .object({
        maxDepth: positiveInt,
        maxDetoursPerDay: positiveInt,
        staleAfterDays: positiveInt,
        miniCheckItems: positiveInt,
      })
      .strict(),
  })
  .strict();

const planSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/, 'plan codes are lower_snake_case'),
    interval: z.enum(['month', 'year']),
    // Money is always integer tiyin (ADR-0008).
    priceTiyin: positiveInt,
    maxStudents: positiveInt,
  })
  .strict();

export const billingSchema = z
  .object({
    currency: z.literal('UZS'),
    trialDays: nonNegativeInt,
    plans: z
      .array(planSchema)
      .min(1)
      .refine(
        (plans) => new Set(plans.map((p) => p.code)).size === plans.length,
        'plan codes must be unique',
      ),
    renewal: z
      .object({
        chargeDaysBeforeEnd: nonNegativeInt,
        retryAfterDays: z
          .array(positiveInt)
          .refine(isStrictlyAscending, 'retry days must be ascending'),
      })
      .strict(),
    referral: z.object({ qualifyAfterActiveDays: positiveInt }).strict(),
  })
  .strict();

export const gamificationSchema = z
  .object({
    xp: z
      .object({
        firstTryCorrect: positiveInt,
        masteryPassed: positiveInt,
        reviewPassed: positiveInt,
        questCompleted: positiveInt,
        dailyCap: positiveInt,
      })
      .strict(),
    levels: z.object({ levelBase: positiveInt, levelExponent: z.number().min(1).max(3) }).strict(),
    streak: z.object({ freezeEveryDays: positiveInt, maxFreezes: nonNegativeInt }).strict(),
    leagues: z
      .object({ size: positiveInt, promoteTop: nonNegativeInt, demoteBottom: nonNegativeInt })
      .strict()
      .refine(
        (l) => l.promoteTop + l.demoteBottom < l.size,
        'promotion and demotion zones must not overlap',
      ),
    notifications: z.object({ quietHoursStart: clockTime, quietHoursEnd: clockTime }).strict(),
  })
  .strict();

export const limitsSchema = z
  .object({
    freeTier: z.object({ dailyExercises: positiveInt }).strict(),
    sessions: z
      .object({ maxConcurrentPerStudent: positiveInt, maxDevicesPerFamily: positiveInt })
      .strict(),
    rateLimits: z
      .object({
        apiPerUserPerMinute: positiveInt,
        loginFailuresPerAccount: window,
        loginFailuresPerIpPrefix: window,
        childPinFailures: window,
      })
      .strict(),
  })
  .strict();

const riskAction = z.enum(['allow', 'invisible_captcha', 'step_up', 'block_and_review']);

export const riskSchema = z
  .object({
    otp: z
      .object({
        allowedCountryCodes: z.array(z.string().regex(/^\+\d{1,4}$/)).min(1),
        codeLength: z.number().int().min(4).max(8),
        ttlSeconds: positiveInt,
        maxAttemptsPerChallenge: positiveInt,
        perPhone: window,
        perPhoneDaily: positiveInt,
        perIpPrefix: window,
        perDevice: window,
      })
      .strict(),
    smsBudget: z.object({ dailyCapTiyin: positiveInt, alertRatio: fraction }).strict(),
    signals: z.record(z.string(), nonNegativeInt),
    actions: z
      .array(z.object({ from: nonNegativeInt, action: riskAction }).strict())
      .min(1)
      .refine((bands) => bands[0]?.from === 0, 'the first risk band must start at 0')
      .refine(
        (bands) => isStrictlyAscending(bands.map((b) => b.from)),
        'risk bands must be ascending',
      ),
  })
  .strict();

const locale = z.enum(['uz-Latn', 'ru', 'en']);

export const contentSchema = z
  .object({
    uiLocales: z.array(locale).min(1),
    requiredContentLocales: z.array(locale).min(1),
    defaultLocale: locale,
    questionTypes: z
      .array(
        z.enum(['single_choice', 'multiple_choice', 'numeric', 'formula', 'matching', 'ordering']),
      )
      .min(1),
    video: z.object({ minDurationSeconds: positiveInt, maxDurationSeconds: positiveInt }).strict(),
  })
  .strict()
  .refine((c) => c.uiLocales.includes(c.defaultLocale), {
    message: 'defaultLocale must be one of uiLocales',
    path: ['defaultLocale'],
  })
  .refine((c) => c.video.maxDurationSeconds > c.video.minDurationSeconds, {
    message: 'maxDurationSeconds must be greater than minDurationSeconds',
    path: ['video'],
  });

/** Maps each config file name (without .yaml) to its schema. */
export const configSchemas = {
  learning: learningSchema,
  billing: billingSchema,
  gamification: gamificationSchema,
  limits: limitsSchema,
  risk: riskSchema,
  content: contentSchema,
} as const;

export type ConfigName = keyof typeof configSchemas;

/** The fully validated business-rule configuration. */
export type AppConfig = { [K in ConfigName]: z.infer<(typeof configSchemas)[K]> };
