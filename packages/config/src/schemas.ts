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
        itemsPerSet: positiveInt.max(30),
      })
      .strict()
      .refine((p) => p.solutionAfterMistakes > p.hintAfterMistakes, {
        message: 'the full solution must come after the hint',
        path: ['solutionAfterMistakes'],
      }),
    masteryTest: z.object({ items: positiveInt.max(40) }).strict(),
    review: z
      .object({
        items: positiveInt.max(20),
        // SM-2 starts every card at 2.5 and never lets the ease fall below 1.3.
        initialEase: z.number().min(1.3).max(3),
      })
      .strict(),
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
    // How long a parent has to pay an order before it expires.
    orderExpiresMinutes: positiveInt.max(24 * 60),
    // Fiscal receipt data sent to the provider (OFD). Optional until the
    // product's IKPU code is registered; without it no receipt items are sent.
    fiscal: z
      .object({
        ikpuCode: z.string().regex(/^\d{17}$/, 'IKPU codes have 17 digits'),
        packageCode: z.string().min(1).max(20),
        vatPercent: z.number().int().min(0).max(100),
        title: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
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
    // Everyone gets the same quests each day; progress comes from server events only.
    quests: z
      .array(
        z
          .object({
            code: z.string().regex(/^[a-z0-9_]{2,32}$/),
            metric: z.enum(['first_try_correct', 'xp', 'sets_finished']),
            target: positiveInt,
          })
          .strict(),
      )
      .max(5)
      .refine(
        (quests) => new Set(quests.map((q) => q.code)).size === quests.length,
        'quest codes must be unique',
      ),
    leagues: z
      .object({
        size: positiveInt,
        promoteTop: nonNegativeInt,
        demoteBottom: nonNegativeInt,
        tiers: positiveInt.max(20),
        gradeBands: z.array(z.number().int().min(1).max(11)).min(1).max(11),
      })
      .strict()
      .refine(
        (l) => l.promoteTop + l.demoteBottom < l.size,
        'promotion and demotion zones must not overlap',
      )
      .refine(
        (l) =>
          l.gradeBands.every((g, i) => i === 0 || g > l.gradeBands[i - 1]!) &&
          l.gradeBands.at(-1) === 11,
        'grade bands must rise and end at grade 11',
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
        childLoginFailuresPerFamily: window,
        accountLock: window,
        promoChecksPerUser: window,
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
    smsBudget: z
      .object({
        hourlyCapTiyin: positiveInt,
        dailyCapTiyin: positiveInt,
        costPerSmsTiyin: positiveInt,
        alertRatio: fraction,
      })
      .strict()
      .refine(
        (b) => b.hourlyCapTiyin <= b.dailyCapTiyin,
        'hourly cap must not exceed the daily cap',
      ),
    // Every signal the scoring code knows, so a typo in a name is caught at start-up.
    signals: z
      .object({
        ipIsDatacenterOrVpn: nonNegativeInt,
        ipReputationBad: nonNegativeInt,
        deviceOnManyAccounts: nonNegativeInt,
        otpVelocityExceeded: nonNegativeInt,
        disposableEmail: nonNegativeInt,
        headlessOrEmulator: nonNegativeInt,
        phonePrefixFlagged: nonNegativeInt,
        newDeviceAndNewIpPrefix: nonNegativeInt,
        failedLoginEach: nonNegativeInt,
        failedLoginMax: nonNegativeInt,
      })
      .strict(),
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

export const authSchema = z
  .object({
    tokens: z
      .object({
        accessTokenTtlMinutes: z.number().int().min(1).max(60),
        refreshTokenTtlDays: z.number().int().min(1).max(90),
        registrationTokenTtlMinutes: z.number().int().min(1).max(60),
      })
      .strict(),
    otp: z.object({ resendAfterSeconds: positiveInt }).strict(),
    password: z
      .object({
        // NIST 800-63B sets 8 as the floor; the brief asks for at least 10.
        minLength: z.number().int().min(8),
        maxLength: z.number().int().max(1024),
        argon2: z
          .object({
            // OWASP minimum for Argon2id is 19 MiB with t = 2.
            memoryKiB: z.number().int().min(19456),
            timeCost: z.number().int().min(2),
            parallelism: z.number().int().min(1).max(16),
          })
          .strict(),
      })
      .strict()
      .refine((p) => p.maxLength >= p.minLength, 'maxLength must be at least minLength'),
    mfa: z
      .object({
        issuer: z.string().min(1).max(32),
        recoveryCodeCount: z.number().int().min(5).max(20),
        verifyFailures: window,
        enrolmentTtlMinutes: z.number().int().min(1).max(60),
      })
      .strict(),
    staffSession: z
      .object({
        absoluteHours: z.number().int().min(1).max(24),
        idleMinutes: z.number().int().min(5).max(240),
      })
      .strict(),
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
    video: z
      .object({
        minDurationSeconds: positiveInt,
        maxDurationSeconds: positiveInt,
        maxUploadBytes: positiveInt,
        segmentSeconds: positiveInt,
        // Renditions from lowest to highest; none is taller than the source.
        ladder: z.array(z.object({ height: positiveInt, videoKbps: positiveInt }).strict()).min(1),
        audioKbps: positiveInt,
        // The audio-only fallback for very slow connections.
        audioOnlyKbps: positiveInt,
      })
      .strict(),
    media: z
      .object({
        uploadUrlTtlSeconds: positiveInt,
        playbackTtlSeconds: positiveInt,
        segmentUrlTtlSeconds: positiveInt,
        keyRequestsPerMinute: positiveInt,
        maxImageBytes: positiveInt,
        maxSubtitleBytes: positiveInt,
      })
      .strict(),
    // Four-eyes exception (C-18): an admin may approve their own version.
    adminSelfReview: z.boolean(),
  })
  .strict()
  .refine((c) => c.uiLocales.includes(c.defaultLocale), {
    message: 'defaultLocale must be one of uiLocales',
    path: ['defaultLocale'],
  })
  .refine((c) => c.video.maxDurationSeconds > c.video.minDurationSeconds, {
    message: 'maxDurationSeconds must be greater than minDurationSeconds',
    path: ['video'],
  })
  .refine((c) => isStrictlyAscending(c.video.ladder.map((r) => r.height)), {
    message: 'ladder heights must be strictly ascending',
    path: ['video', 'ladder'],
  });

/** Maps each config file name (without .yaml) to its schema. */
export const configSchemas = {
  learning: learningSchema,
  billing: billingSchema,
  gamification: gamificationSchema,
  limits: limitsSchema,
  risk: riskSchema,
  content: contentSchema,
  auth: authSchema,
} as const;

export type ConfigName = keyof typeof configSchemas;

/** The fully validated business-rule configuration. */
export type AppConfig = { [K in ConfigName]: z.infer<(typeof configSchemas)[K]> };
