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
}

export type TableName = keyof Database;
export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type Session = Selectable<SessionsTable>;
