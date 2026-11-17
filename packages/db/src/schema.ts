/**
 * TypeScript types for the database tables, used by Kysely for type-safe queries.
 *
 * Keep in sync with the migrations in ./migrations. A test (schema.test.ts)
 * checks that every table declared here exists after migrating, so drift is caught.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** A timestamp column the database fills by default. */
type CreatedAt = ColumnType<Date, Date | undefined, never>;
type Timestamp = ColumnType<Date, Date, Date>;
type NullableTimestamp = ColumnType<Date | null, Date | null | undefined, Date | null>;

export type Locale = 'uz-Latn' | 'ru' | 'en';
export type Role = 'student' | 'parent' | 'teacher' | 'author' | 'reviewer' | 'admin' | 'support';
export type UserStatus = 'active' | 'locked' | 'suspended' | 'pending_deletion';
export type RiskLevel = 'normal' | 'elevated' | 'high' | 'blocked';
export type OtpPurpose = 'signup' | 'login' | 'reset_password' | 'change_phone' | 'confirm_action';
export type RevokeReason =
  | 'logout'
  | 'token_reuse'
  | 'admin'
  | 'session_limit'
  | 'password_change'
  | 'expired';

export interface UsersTable {
  id: string;
  phone_e164: string | null;
  phone_verified_at: NullableTimestamp;
  email: string | null;
  password_hash: string | null;
  first_name: string;
  last_name: string | null;
  locale: ColumnType<Locale, Locale | undefined, Locale>;
  status: ColumnType<UserStatus, UserStatus | undefined, UserStatus>;
  risk_level: ColumnType<RiskLevel, RiskLevel | undefined, RiskLevel>;
  last_login_at: NullableTimestamp;
  terms_version: string | null;
  terms_accepted_at: NullableTimestamp;
  deleted_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

export interface UserRolesTable {
  user_id: string;
  role: Role;
  granted_by: string | null;
  granted_at: CreatedAt;
}

export interface StudentProfilesTable {
  user_id: string;
  nickname: string;
  nickname_status: ColumnType<
    'pending' | 'approved' | 'rejected',
    'pending' | 'approved' | 'rejected' | undefined
  >;
  grade: number;
  birth_year: number | null;
  avatar_code: string | null;
  pin_hash: string;
  pin_failed_count: Generated<number>;
  pin_locked_until: NullableTimestamp;
  daily_time_limit_min: number | null;
}

export interface FamilyCodesTable {
  parent_id: string;
  code: string;
  created_at: CreatedAt;
}

export interface ConsentsTable {
  id: string;
  parent_id: string;
  child_id: string;
  policy_version: string;
  scopes: string[];
  method: 'otp_confirmed';
  evidence: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined>;
  granted_at: CreatedAt;
  revoked_at: NullableTimestamp;
}

export interface ParentChildLinksTable {
  parent_id: string;
  child_id: string;
  consent_id: string;
  relationship: ColumnType<'parent' | 'guardian', 'parent' | 'guardian' | undefined>;
  created_at: CreatedAt;
}

export interface MfaFactorsTable {
  id: string;
  user_id: string;
  type: 'totp';
  secret: Buffer;
  confirmed_at: NullableTimestamp;
  last_used_step: ColumnType<string | null, number | null | undefined, number | null>;
  created_at: CreatedAt;
}

export interface MfaRecoveryCodesTable {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: NullableTimestamp;
}

export interface DevicesTable {
  id: string;
  fingerprint_hash: string;
  flags: ColumnType<string[], string[] | undefined>;
  trial_used_at: NullableTimestamp;
  first_seen_at: CreatedAt;
  last_seen_at: ColumnType<Date, Date | undefined, Date>;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  device_id: string | null;
  parent_session_id: string | null;
  ip_prefix: string | null;
  user_agent_summary: string | null;
  mfa_verified: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  last_seen_at: ColumnType<Date, Date | undefined, Date>;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
  revoke_reason: RevokeReason | null;
}

export interface RefreshTokensTable {
  id: string;
  session_id: string;
  token_hash: Buffer;
  replaced_by: string | null;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: CreatedAt;
}

export interface OtpChallengesTable {
  id: string;
  phone_e164: string;
  purpose: OtpPurpose;
  code_hash: string;
  attempts: Generated<number>;
  expires_at: Timestamp;
  consumed_at: NullableTimestamp;
  ip_prefix: string | null;
  device_id: string | null;
  provider_message_id: string | null;
  created_at: CreatedAt;
}

export interface RiskEventsTable {
  id: string;
  user_id: string | null;
  device_id: string | null;
  ip_prefix: string | null;
  type: string;
  score_delta: ColumnType<number, number | undefined>;
  details: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined>;
  created_at: CreatedAt;
}

export interface RiskReviewsTable {
  id: string;
  subject_user_id: string;
  reason: string;
  status: ColumnType<
    'open' | 'cleared' | 'restricted' | 'banned',
    'open' | 'cleared' | 'restricted' | 'banned' | undefined
  >;
  reviewer_id: string | null;
  notes: string | null;
  created_at: CreatedAt;
  decided_at: NullableTimestamp;
}

export interface BlockedPrefixesTable {
  prefix: string;
  reason: string;
  created_by: string | null;
  created_at: CreatedAt;
}

export interface AuditLogTable {
  id: string;
  actor_id: string | null;
  actor_roles: ColumnType<string[], string[] | undefined>;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip_prefix: string | null;
  request_id: string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined>;
  prev_hash: Buffer | null;
  hash: Buffer;
  created_at: CreatedAt;
}

export interface OutboxEventsTable {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: CreatedAt;
  published_at: NullableTimestamp;
}

export interface ProcessedEventsTable {
  event_id: string;
  handler: string;
  processed_at: CreatedAt;
}

export interface IdempotencyKeysTable {
  scope: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  created_at: CreatedAt;
}

/** Localised text: `{"uz-Latn": "...", "ru": "...", "en": "..."}` (schema doc §1). */
export type LocalisedText = Partial<Record<Locale, string>>;
type Json<T> = ColumnType<T, T | string | undefined, T | string>;
export type CatalogueStatus = 'draft' | 'published' | 'archived';
export type VersionStatus =
  | 'draft'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'published'
  | 'archived';

export interface TracksTable {
  id: string;
  slug: string;
  title: Json<LocalisedText>;
  sort: ColumnType<number, number | undefined, number>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface CoursesTable {
  id: string;
  track_id: string;
  slug: string;
  grade: number | null;
  title: Json<LocalisedText>;
  description: Json<LocalisedText>;
  status: ColumnType<CatalogueStatus, CatalogueStatus | undefined, CatalogueStatus>;
  sort: ColumnType<number, number | undefined, number>;
}

export interface ChaptersTable {
  id: string;
  course_id: string;
  slug: string;
  title: Json<LocalisedText>;
  sort: ColumnType<number, number | undefined, number>;
  status: ColumnType<CatalogueStatus, CatalogueStatus | undefined, CatalogueStatus>;
}

export interface TopicsTable {
  id: string;
  chapter_id: string;
  slug: string;
  sort: ColumnType<number, number | undefined, number>;
  is_free: ColumnType<boolean, boolean | undefined, boolean>;
  published_version_id: string | null;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface TopicVersionsTable {
  id: string;
  topic_id: string;
  version_no: number;
  status: ColumnType<VersionStatus, VersionStatus | undefined, VersionStatus>;
  title: Json<LocalisedText>;
  summary: Json<LocalisedText>;
  /** Lesson steps; shape validated by the content module (schema doc §4.1). */
  steps: Json<unknown[]>;
  question_pool: Json<Record<string, unknown>>;
  author_id: string;
  content_hash: string;
  published_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type QuestionType =
  | 'single_choice'
  | 'multiple_choice'
  | 'numeric'
  | 'formula'
  | 'matching'
  | 'ordering';

export interface QuestionTemplatesTable {
  id: string;
  topic_id: string;
  external_ref: string | null;
  created_by: string;
  created_at: CreatedAt;
  published_version_id: string | null;
}

export interface QuestionTemplateVersionsTable {
  id: string;
  template_id: string;
  version_no: number;
  status: ColumnType<VersionStatus, VersionStatus | undefined, VersionStatus>;
  type: QuestionType;
  difficulty: number;
  skills: ColumnType<string[], string[] | undefined, string[]>;
  /** Template body; validated by @mathpath/questions (schema doc §4.2). Server-only. */
  body: Json<Record<string, unknown>>;
  author_id: string;
  content_hash: string;
  published_at: NullableTimestamp;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type AssessmentType =
  | 'diagnostic'
  | 'practice'
  | 'mastery'
  | 'review'
  | 'chapter'
  | 'mock_exam';
export type AttemptStatus = 'in_progress' | 'submitted' | 'expired' | 'invalidated';

export interface AssessmentsTable {
  id: string;
  type: AssessmentType;
  scope_type: 'topic' | 'chapter' | 'course';
  scope_id: string;
  /** Overrides of config/learning.yaml for this assessment; `{}` uses the config. */
  blueprint: Json<Record<string, unknown>>;
  version_no: ColumnType<number, number | undefined, number>;
  status: ColumnType<CatalogueStatus, CatalogueStatus | undefined, CatalogueStatus>;
  created_at: CreatedAt;
}

export interface AttemptsTable {
  id: string;
  user_id: string;
  assessment_id: string;
  topic_id: string | null;
  assignment_id: ColumnType<string | null, string | null | undefined, string | null>;
  status: ColumnType<AttemptStatus, AttemptStatus | undefined, AttemptStatus>;
  started_at: ColumnType<Date, Date | undefined, never>;
  deadline_at: NullableTimestamp;
  submitted_at: NullableTimestamp;
  /** numeric(7,2): read as a string. */
  score: ColumnType<string | null, number | null | undefined, number | null>;
  max_score: ColumnType<string | null, number | null | undefined, number | null>;
  passed: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  integrity_flags: ColumnType<string[], string[] | undefined, string[]>;
  idempotency_key: ColumnType<string | null, string | null | undefined, never>;
  /** The gap router's recommendation after submit (6.4c). */
  recommendation: ColumnType<unknown, string | null | undefined, string | null>;
  /** What submitting earned: { xp, badges, questsCompleted } (6.6). */
  reward: ColumnType<unknown, string | null | undefined, string | null>;
  created_at: CreatedAt;
}

export interface AttemptItemsTable {
  id: string;
  attempt_id: string;
  position: number;
  template_version_id: string;
  seed: string;
  params: Json<Record<string, string>>;
  /** What the learner sees (stem and shuffled choices, all locales). */
  presented: Json<Record<string, unknown>>;
  /** Server-only (C-16). */
  answer_key: Json<Record<string, unknown>>;
  /** Hints and solution for this item's numbers. Server-only until earned. */
  feedback: Json<Record<string, unknown>>;
  response: ColumnType<unknown, string | null | undefined, string | null>;
  is_correct: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  score: ColumnType<string | null, number | null | undefined, number | null>;
  tries: ColumnType<number, number | undefined, number>;
  hints_shown: ColumnType<number, number | undefined, number>;
  served_at: NullableTimestamp;
  answered_at: NullableTimestamp;
  /** Idempotency-Key of the last answer and its result, so a retried answer is not counted twice. */
  last_request_key: ColumnType<string | null, string | null | undefined, string | null>;
  last_result: ColumnType<unknown, string | null | undefined, string | null>;
  created_at: CreatedAt;
}

export interface DailyUsageTable {
  user_id: string;
  /** Tashkent calendar day, `YYYY-MM-DD`. */
  day: ColumnType<string, string, never>;
  exercises_count: ColumnType<number, number | undefined, number>;
  minutes_active: ColumnType<number, number | undefined, number>;
}

export type MasteryState = 'not_started' | 'learning' | 'mastered' | 'needs_review';
export type DetourStatus = 'open' | 'refreshed' | 'added_to_path' | 'closed';

export interface TopicProgressTable {
  user_id: string;
  topic_id: string;
  topic_version_id: ColumnType<string | null, string | null | undefined, string | null>;
  state: ColumnType<MasteryState, MasteryState | undefined, MasteryState>;
  /** numeric(4,3): read as a string. */
  mastery: ColumnType<string | null, number | null | undefined, number | null>;
  steps_completed: ColumnType<number[], number[] | undefined, number[]>;
  mastered_at: NullableTimestamp;
  next_review_at: NullableTimestamp;
  review_interval_days: ColumnType<number | null, number | null | undefined, number | null>;
  /** numeric(3,2): read as a string. */
  ease: ColumnType<string | null, number | null | undefined, number | null>;
  review_count: ColumnType<number, number | undefined, number>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface LearningDetoursTable {
  id: string;
  user_id: string;
  from_topic_id: string;
  to_topic_id: string;
  depth: number;
  status: ColumnType<DetourStatus, DetourStatus | undefined, DetourStatus>;
  created_at: CreatedAt;
  resolved_at: NullableTimestamp;
}

export interface LearningEventsTable {
  id: string;
  user_id: string;
  /** For example `mastery_passed`, `gap_routed`, `review_scheduled`. */
  type: string;
  topic_id: string | null;
  payload: Json<Record<string, unknown>>;
  created_at: CreatedAt;
}

/** Money in tiyin (bigint). Drivers return a string, number or BigInt, so read it with Number(). */
type Tiyin = ColumnType<string | number | bigint, number, number>;
export type OrderStatus = 'created' | 'pending' | 'paid' | 'cancelled' | 'expired';
export type PaymentStatus =
  | 'pending'
  | 'paid'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded'
  | 'failed';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';
export type PaymentProviderCode = 'payme' | 'click';

export interface OrdersTable {
  id: string;
  owner_id: string;
  plan_code: string;
  plan_interval: 'month' | 'year';
  student_ids: string[];
  amount_tiyin: Tiyin;
  discount_tiyin: ColumnType<string | number | bigint, number | undefined, number>;
  provider: PaymentProviderCode;
  status: ColumnType<OrderStatus, OrderStatus | undefined, OrderStatus>;
  idempotency_key: string;
  return_url: string | null;
  expires_at: Timestamp;
  paid_at: NullableTimestamp;
  promo_code_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type XpReason =
  | 'first_try_correct'
  | 'mastery_passed'
  | 'review_passed'
  | 'quest_completed'
  | 'admin_adjustment';

export interface XpLedgerTable {
  id: string;
  user_id: string;
  amount: number;
  reason: XpReason;
  /** What earned it: `attempt_item`, `topic`, `attempt` or `quest`. */
  source_type: string;
  source_id: string;
  /** The Tashkent calendar day, for the daily cap. */
  day: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface UserStatsTable {
  user_id: string;
  xp_total: ColumnType<number, number | undefined, number>;
  level: ColumnType<number, number | undefined, number>;
  current_streak: ColumnType<number, number | undefined, number>;
  longest_streak: ColumnType<number, number | undefined, number>;
  last_active_day: ColumnType<string | null, string | null | undefined, string | null>;
  streak_freezes: ColumnType<number, number | undefined, number>;
  /** The league tier the learner joins next week (6.6b). */
  league_tier: ColumnType<number, number | undefined, number>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface LeaguesTable {
  id: string;
  /** Monday of the Tashkent week, `YYYY-MM-DD`. */
  week_start: string;
  tier: number;
  /** Grade band index from config (`leagues.gradeBands`). */
  band: number;
  cohort: number;
  closed_at: NullableTimestamp;
  created_at: CreatedAt;
}

export type LeagueOutcome = 'promoted' | 'stayed' | 'demoted';

export interface LeagueMembersTable {
  league_id: string;
  user_id: string;
  week_start: string;
  weekly_xp: ColumnType<number, number | undefined, number>;
  joined_at: CreatedAt;
  final_rank: ColumnType<number | null, number | null | undefined, number | null>;
  outcome: ColumnType<LeagueOutcome | null, LeagueOutcome | null | undefined, LeagueOutcome | null>;
}

export interface UserBadgesTable {
  user_id: string;
  badge_code: string;
  awarded_at: ColumnType<Date, Date | undefined, never>;
}

export interface UserQuestsTable {
  user_id: string;
  day: string;
  code: string;
  progress: ColumnType<number, number | undefined, number>;
  target: number;
  completed_at: NullableTimestamp;
}

export type DiscountType = 'percent' | 'fixed';

export interface PromoCodesTable {
  id: string;
  /** Upper-case, `[A-Z0-9_-]{4,32}`. */
  code: string;
  discount_type: DiscountType;
  /** Percent (1–100) or tiyin, by `discount_type`. */
  value: Tiyin;
  /** Plans the code applies to; null means every plan. */
  plan_codes: string[] | null;
  max_redemptions: number | null;
  per_user_limit: ColumnType<number, number | undefined, number>;
  valid_from: Timestamp;
  valid_to: Timestamp;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface PromoRedemptionsTable {
  promo_code_id: string;
  order_id: string;
  owner_id: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface TrialsTable {
  id: string;
  owner_id: string;
  /** SHA-256 of the device token, when the app sent one. */
  device_hash: string | null;
  subscription_id: string;
  started_at: Timestamp;
  ends_at: Timestamp;
}

export interface SubscriptionsTable {
  id: string;
  owner_id: string;
  order_id: string | null;
  plan_code: string;
  status: SubscriptionStatus;
  seats: number;
  price_tiyin: Tiyin;
  current_period_start: Timestamp;
  current_period_end: Timestamp;
  cancel_at_period_end: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface SubscriptionMembersTable {
  subscription_id: string;
  student_id: string;
}

export interface PaymentsTable {
  id: string;
  order_id: string;
  subscription_id: string | null;
  provider: PaymentProviderCode;
  provider_txn_id: string;
  amount_tiyin: Tiyin;
  status: ColumnType<PaymentStatus, PaymentStatus | undefined, PaymentStatus>;
  provider_created_at: NullableTimestamp;
  created_at: ColumnType<Date, Date | undefined, never>;
  paid_at: NullableTimestamp;
  cancelled_at: NullableTimestamp;
  /** The provider's cancel reason code (Payme: 1–5, 10). */
  cancel_reason: number | null;
  fiscal_receipt: Json<Record<string, unknown>> | null;
  /** A number from a sequence, for providers that want an integer ID (Click). */
  merchant_ref: ColumnType<string, never, never>;
}

export type RefundStatus = 'requested' | 'succeeded' | 'failed';

export interface RefundsTable {
  id: string;
  payment_id: string;
  amount_tiyin: Tiyin;
  status: ColumnType<RefundStatus, RefundStatus | undefined, RefundStatus>;
  reason: string;
  /** The admin who asked; null for a refund the provider started on its side. */
  requested_by: string | null;
  idempotency_key: string | null;
  /** The provider's reference for the refund, when it gives one. */
  provider_ref: string | null;
  /** Why the provider refused; set exactly when the status is `failed`. */
  failure: string | null;
  created_at: ColumnType<Date, Date | undefined, never>;
  completed_at: NullableTimestamp;
}

export interface PaymentCallbacksTable {
  id: string;
  provider: string;
  /** For example `CreateTransaction`, `prepare`, `complete`. */
  method: string;
  external_id: string | null;
  auth_valid: boolean;
  payload: Json<Record<string, unknown>>;
  response: Json<Record<string, unknown>>;
  received_at: ColumnType<Date, Date | undefined, never>;
}

export interface TopicPrerequisitesTable {
  topic_id: string;
  prerequisite_id: string;
  strength: ColumnType<'required' | 'helpful', 'required' | 'helpful' | undefined, never>;
}

export interface TopicMappingsTable {
  topic_id: string;
  mapped_topic_id: string;
  relation: 'equivalent' | 'partial' | 'extends';
}

export interface ContentReviewsTable {
  id: string;
  entity_type: 'topic_version' | 'question_template_version';
  entity_id: string;
  reviewer_id: string;
  decision: 'approved' | 'changes_requested';
  comments: Json<{ anchor?: string; text: string }[]>;
  created_at: CreatedAt;
}

export type MediaKind = 'video' | 'image' | 'subtitle';
export type MediaStatus = 'awaiting_upload' | 'uploaded' | 'processing' | 'ready' | 'failed';

/** One HLS rendition of a video; `height` is null for the audio-only fallback. */
export interface Rendition {
  name: string;
  height: number | null;
  bandwidth: number;
}

export interface MediaAssetsTable {
  id: string;
  kind: MediaKind;
  locale: Locale | null;
  parent_id: string | null;
  content_type: string;
  /** bigint: drivers return a string, number or BigInt, so read it with Number(). */
  size_bytes: ColumnType<string | number | bigint, number, never>;
  source_key: string;
  status: ColumnType<MediaStatus, MediaStatus | undefined, MediaStatus>;
  hls_manifest_key: string | null;
  duration_s: number | null;
  renditions: ColumnType<Rendition[] | null, string | null | undefined, string | null>;
  error: string | null;
  uploaded_by: string;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface MediaKeysTable {
  media_id: string;
  /** AES-128 key sealed by MediaKeyVault (IV + tag + ciphertext). */
  sealed_key: Buffer;
  iv: Buffer;
  created_at: CreatedAt;
  rotated_at: NullableTimestamp;
}

/** All tables, keyed by table name. */
export interface Database {
  users: UsersTable;
  user_roles: UserRolesTable;
  student_profiles: StudentProfilesTable;
  family_codes: FamilyCodesTable;
  consents: ConsentsTable;
  parent_child_links: ParentChildLinksTable;
  mfa_factors: MfaFactorsTable;
  mfa_recovery_codes: MfaRecoveryCodesTable;
  devices: DevicesTable;
  sessions: SessionsTable;
  refresh_tokens: RefreshTokensTable;
  otp_challenges: OtpChallengesTable;
  risk_events: RiskEventsTable;
  risk_reviews: RiskReviewsTable;
  blocked_prefixes: BlockedPrefixesTable;
  audit_log: AuditLogTable;
  outbox_events: OutboxEventsTable;
  processed_events: ProcessedEventsTable;
  idempotency_keys: IdempotencyKeysTable;
  tracks: TracksTable;
  courses: CoursesTable;
  chapters: ChaptersTable;
  topics: TopicsTable;
  topic_versions: TopicVersionsTable;
  topic_prerequisites: TopicPrerequisitesTable;
  topic_mappings: TopicMappingsTable;
  content_reviews: ContentReviewsTable;
  question_templates: QuestionTemplatesTable;
  question_template_versions: QuestionTemplateVersionsTable;
  media_assets: MediaAssetsTable;
  media_keys: MediaKeysTable;
  assessments: AssessmentsTable;
  attempts: AttemptsTable;
  attempt_items: AttemptItemsTable;
  daily_usage: DailyUsageTable;
  topic_progress: TopicProgressTable;
  learning_detours: LearningDetoursTable;
  learning_events: LearningEventsTable;
  orders: OrdersTable;
  subscriptions: SubscriptionsTable;
  subscription_members: SubscriptionMembersTable;
  payments: PaymentsTable;
  payment_callbacks: PaymentCallbacksTable;
  refunds: RefundsTable;
  promo_codes: PromoCodesTable;
  promo_redemptions: PromoRedemptionsTable;
  trials: TrialsTable;
  xp_ledger: XpLedgerTable;
  user_stats: UserStatsTable;
  user_badges: UserBadgesTable;
  user_quests: UserQuestsTable;
  leagues: LeaguesTable;
  league_members: LeagueMembersTable;
}

export type TableName = keyof Database;
export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type Session = Selectable<SessionsTable>;
