/**
 * The identity module (docs/architecture.md §4): users, OTP, passwords,
 * sessions and tokens.
 *
 * Services are plain classes wired here with factories, so they can be unit
 * tested without Nest, and so swapping an implementation (Redis instead of
 * memory, Eskiz instead of the console) is a one-line change in this file.
 */
import { type AppConfig } from '@mathpath/config';
import type { Database } from '@mathpath/db';
import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { Redis } from 'ioredis';
import { Clock } from '../common/clock';
import { RateLimiter } from '../common/rate-limiter';
import { REDIS } from '../redis/redis.module';
import { RiskService } from '../risk/risk.service';
import { SmsBudget } from '../risk/sms-budget';
import type { Env } from '../config/env';
import { BUSINESS_RULES, ENV } from '../config/tokens';
import { DB } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import {
  BreachedPasswordChecker,
  DisabledBreachedPasswordChecker,
  HibpBreachedPasswordChecker,
} from './breached-passwords';
import { AuthKeys } from './keys';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';
import { MemoryRevokedSessions, RedisRevokedSessions, RevokedSessions } from './revoked-sessions';
import { EskizSmsSender } from './sms/eskiz-sms-sender';
import { SessionService } from './session.service';
import { LogSmsSender, SmsSender } from './sms/sms-sender';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController, MfaController],
  providers: [
    { provide: AuthKeys, inject: [ENV], useFactory: (env: Env) => AuthKeys.fromEnv(env) },
    {
      provide: SmsSender,
      inject: [ENV],
      useFactory: (env: Env): SmsSender =>
        env.SMS_PROVIDER === 'eskiz'
          ? new EskizSmsSender({
              email: env.ESKIZ_EMAIL!,
              password: env.ESKIZ_PASSWORD!,
              sender: env.ESKIZ_SENDER,
              log: (line) => new Logger('EskizSmsSender').log(line),
            })
          : new LogSmsSender(),
    },
    {
      provide: RevokedSessions,
      inject: [REDIS, Clock],
      useFactory: (redis: Redis | null, clock: Clock) =>
        redis ? new RedisRevokedSessions(redis) : new MemoryRevokedSessions(clock),
    },
    {
      provide: BreachedPasswordChecker,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.BREACHED_PASSWORD_CHECK === 'hibp'
          ? new HibpBreachedPasswordChecker()
          : new DisabledBreachedPasswordChecker(),
    },
    {
      provide: TokenService,
      inject: [AuthKeys, Clock, BUSINESS_RULES],
      useFactory: (keys: AuthKeys, clock: Clock, rules: AppConfig) =>
        new TokenService(keys, clock, rules.auth.tokens),
    },
    {
      provide: PasswordService,
      inject: [BUSINESS_RULES, BreachedPasswordChecker],
      useFactory: (rules: AppConfig, breached: BreachedPasswordChecker) =>
        new PasswordService(rules.auth.password, breached),
    },
    {
      provide: SessionService,
      inject: [DB, TokenService, AuthKeys, RevokedSessions, Clock, BUSINESS_RULES, AuditService],
      useFactory: (
        db: Kysely<Database>,
        tokens: TokenService,
        keys: AuthKeys,
        revoked: RevokedSessions,
        clock: Clock,
        rules: AppConfig,
        audit: AuditService,
      ) =>
        new SessionService(db, tokens, keys, revoked, clock, rules.auth.tokens, audit, {
          maxStudentSessions: rules.limits.sessions.maxConcurrentPerStudent,
          staffSession: rules.auth.staffSession,
        }),
    },
    {
      provide: OtpService,
      inject: [DB, SmsSender, RateLimiter, AuthKeys, Clock, BUSINESS_RULES, RiskService, SmsBudget],
      useFactory: (
        db: Kysely<Database>,
        sms: SmsSender,
        limiter: RateLimiter,
        keys: AuthKeys,
        clock: Clock,
        rules: AppConfig,
        risk: RiskService,
        budget: SmsBudget,
      ) =>
        new OtpService(
          db,
          sms,
          limiter,
          keys,
          clock,
          rules.risk.otp,
          rules.auth.otp.resendAfterSeconds,
          risk,
          budget,
        ),
    },
    {
      provide: AuthService,
      inject: [
        DB,
        OtpService,
        PasswordService,
        SessionService,
        TokenService,
        RateLimiter,
        Clock,
        BUSINESS_RULES,
        AuditService,
        RiskService,
        SmsSender,
      ],
      useFactory: (
        db: Kysely<Database>,
        otp: OtpService,
        passwords: PasswordService,
        sessions: SessionService,
        tokens: TokenService,
        limiter: RateLimiter,
        clock: Clock,
        rules: AppConfig,
        audit: AuditService,
        risk: RiskService,
        sms: SmsSender,
      ) =>
        new AuthService(
          db,
          otp,
          passwords,
          sessions,
          tokens,
          limiter,
          clock,
          rules.limits.rateLimits,
          audit,
          risk,
          sms,
        ),
    },
    {
      provide: MfaService,
      inject: [DB, AuthKeys, SessionService, RateLimiter, AuditService, Clock, BUSINESS_RULES],
      useFactory: (
        db: Kysely<Database>,
        keys: AuthKeys,
        sessions: SessionService,
        limiter: RateLimiter,
        audit: AuditService,
        clock: Clock,
        rules: AppConfig,
      ) => new MfaService(db, keys, sessions, limiter, audit, clock, rules.auth.mfa),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  // Used by the family module for child accounts, consent and child sign-in.
  exports: [SessionService, OtpService, PasswordService, SmsSender, MfaService, AuthKeys],
})
export class IdentityModule {}
