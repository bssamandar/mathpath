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
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { Clock, SystemClock } from '../common/clock';
import { MemoryRateLimiter, RateLimiter } from '../common/rate-limiter';
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
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';
import { MemoryRevokedSessions, RevokedSessions } from './revoked-sessions';
import { SessionService } from './session.service';
import { LogSmsSender, SmsSender } from './sms/sms-sender';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: AuthKeys, inject: [ENV], useFactory: (env: Env) => AuthKeys.fromEnv(env) },
    { provide: SmsSender, useClass: LogSmsSender },
    {
      provide: RateLimiter,
      inject: [Clock],
      useFactory: (clock: Clock) => new MemoryRateLimiter(clock),
    },
    {
      provide: RevokedSessions,
      inject: [Clock],
      useFactory: (clock: Clock) => new MemoryRevokedSessions(clock),
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
      ) => new SessionService(db, tokens, keys, revoked, clock, rules.auth.tokens, audit),
    },
    {
      provide: OtpService,
      inject: [DB, SmsSender, RateLimiter, AuthKeys, Clock, BUSINESS_RULES],
      useFactory: (
        db: Kysely<Database>,
        sms: SmsSender,
        limiter: RateLimiter,
        keys: AuthKeys,
        clock: Clock,
        rules: AppConfig,
      ) =>
        new OtpService(
          db,
          sms,
          limiter,
          keys,
          clock,
          rules.risk.otp,
          rules.auth.otp.resendAfterSeconds,
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
        ),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class IdentityModule {}
