/**
 * /api/v1/auth endpoints (docs/api/openapi.yaml, tag Auth).
 *
 * Web clients receive tokens only as HttpOnly cookies. Native apps (later)
 * send `X-Client-Type: mobile` and receive tokens in the body instead, because
 * they keep them in the device's secure storage.
 */
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Clock } from '../common/clock';
import { ProblemException } from '../common/problem';
import { deviceToken, locale, parseInput, personName, phoneE164 } from '../common/validation';
import { AuthService } from './auth.service';
import { type AuthedRequest, SkipCsrf } from './auth.guard';
import { Access } from './permissions';
import { clearSessionCookies, REFRESH_COOKIE } from './cookies';
import { clientOf, sendSession, type SessionInfo } from './http';
import { OtpService } from './otp.service';
import { type IssuedSession, SessionService } from './session.service';

const otpRequestBody = z
  .object({
    // Optional for confirm_action: the code then goes to the account's own number.
    phone: phoneE164.optional(),
    purpose: z.enum(['signup', 'login', 'reset_password', 'confirm_action']),
    captchaToken: z.string().max(4096).optional(),
    deviceToken: deviceToken.optional(),
  })
  .strict()
  .refine((body) => body.phone !== undefined || body.purpose === 'confirm_action', {
    path: ['phone'],
    message: 'required',
  });

const otpVerifyBody = z
  .object({
    challengeId: z.uuid(),
    code: z.string().regex(/^[0-9]{4,8}$/),
    deviceToken: deviceToken.optional(),
  })
  .strict();

const passwordResetBody = z
  .object({
    resetToken: z.string().min(1).max(2048),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();

const registerBody = z
  .object({
    registrationToken: z.string().min(1).max(2048),
    firstName: personName,
    lastName: personName.optional(),
    // Length rules come from config/auth.yaml; this only caps the input size.
    password: z.string().min(1).max(1024),
    // Teachers sign up once the teacher role is in scope (after the MVP).
    role: z.literal('parent'),
    locale: locale.optional(),
    // Accepted for forward compatibility; referrals are handled by billing later.
    referralCode: z.string().max(32).optional(),
    acceptedTermsVersion: z.string().min(1).max(32),
  })
  .strict();

const loginBody = z
  .object({
    phone: phoneE164,
    password: z.string().min(1).max(1024),
    captchaToken: z.string().max(4096).optional(),
    deviceToken: deviceToken.optional(),
  })
  .strict();

const refreshBody = z.object({ refreshToken: z.string().min(1).max(256).optional() }).strict();

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly clock: Clock,
  ) {}

  /** POST /auth/otp: always 202 for a well-formed request (no phone enumeration). */
  @Post('otp')
  @Access('public')
  @HttpCode(202)
  async requestOtp(@Body() raw: unknown, @Req() req: AuthedRequest) {
    const body = parseInput(otpRequestBody, raw);
    const client = clientOf(req);
    if (body.purpose === 'confirm_action') {
      // Only for a signed-in user, and only to their own number.
      if (!req.auth) throw new ProblemException(401, 'UNAUTHENTICATED', 'Please sign in.');
      body.phone = await this.auth.ownPhone(req.auth.userId, body.phone);
    }
    return this.otp.request({
      phone: body.phone!,
      purpose: body.purpose,
      ipPrefix: client.ipPrefix,
      automationSuspected: client.automationSuspected,
      captchaToken: body.captchaToken,
    });
  }

  /**
   * POST /auth/otp/verify: a registration ticket (signup), a reset ticket
   * (reset_password) or a session (login).
   */
  @Post('otp/verify')
  @Access('public')
  @HttpCode(200)
  async verifyOtp(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = parseInput(otpVerifyBody, raw);
    const result = await this.auth.verifyOtp(body.challengeId, body.code, clientOf(req));
    if (result.kind === 'registration') {
      return {
        registrationToken: result.ticket.token,
        expiresAt: result.ticket.expiresAt.toISOString(),
      };
    }
    if (result.kind === 'password_reset') {
      return {
        resetToken: result.ticket.token,
        expiresAt: result.ticket.expiresAt.toISOString(),
      };
    }
    return this.respond(req, res, result.session);
  }

  /** POST /auth/register: creates a parent account and signs it in. */
  @Post('register')
  @Access('public')
  @HttpCode(201)
  async register(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = parseInput(registerBody, raw);
    const session = await this.auth.register(body, clientOf(req));
    return this.respond(req, res, session);
  }

  /** POST /auth/password/reset: new password with a reset ticket; signs out everywhere. */
  @Post('password/reset')
  @Access('public')
  @HttpCode(204)
  async resetPassword(@Body() raw: unknown, @Req() req: Request): Promise<void> {
    const body = parseInput(passwordResetBody, raw);
    await this.auth.resetPassword(body.resetToken, body.newPassword, clientOf(req));
  }

  /** POST /auth/login: phone and password. */
  @Post('login')
  @Access('public')
  @HttpCode(200)
  async login(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = parseInput(loginBody, raw);
    const session = await this.auth.login(
      body.phone,
      body.password,
      clientOf(req),
      body.captchaToken,
    );
    return this.respond(req, res, session);
  }

  /** POST /auth/refresh: rotates the refresh token (cookie, or body for mobile). */
  @Post('refresh')
  @Access('public')
  @HttpCode(200)
  @SkipCsrf()
  async refresh(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = parseInput(refreshBody, raw);
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const token = body.refreshToken ?? cookies[REFRESH_COOKIE];
    try {
      if (!token) throw new ProblemException(401, 'SESSION_EXPIRED', 'Please sign in again.');
      return this.respond(req, res, await this.sessions.rotate(token, clientOf(req)));
    } catch (error) {
      // A dead refresh cookie is useless; remove it so the client stops sending it.
      clearSessionCookies(res);
      throw error;
    }
  }

  /** POST /auth/logout: revokes the current session and clears the cookies. */
  @Post('logout')
  @HttpCode(204)
  @Access('authenticated')
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { sessionId, userId, roles } = req.auth!;
    await this.sessions.revoke(sessionId, 'logout', { userId, roles }, clientOf(req));
    clearSessionCookies(res);
  }

  private respond(req: Request, res: Response, session: IssuedSession): SessionInfo {
    return sendSession(req, res, session, this.clock.now());
  }
}
