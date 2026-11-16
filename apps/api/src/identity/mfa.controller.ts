/**
 * /api/v1/auth/mfa endpoints (docs/api/openapi.yaml, tag Auth; C-08).
 */
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Clock } from '../common/clock';
import { parseInput } from '../common/validation';
import type { AuthedRequest } from './auth.guard';
import { clientOf, sendSession } from './http';
import { MfaService } from './mfa.service';
import { Access } from './permissions';

const verifyBody = z
  .union([
    z
      .object({
        factorId: z.uuid().optional(),
        code: z.string().regex(/^[0-9]{6}$/),
      })
      .strict(),
    z.object({ recoveryCode: z.string().min(10).max(32) }).strict(),
  ])
  .transform((body) =>
    'recoveryCode' in body
      ? { kind: 'recovery' as const, recoveryCode: body.recoveryCode }
      : { kind: 'totp' as const, code: body.code, factorId: body.factorId },
  );

@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly clock: Clock,
  ) {}

  /** POST /auth/mfa/totp: starts enrolment and returns the otpauth URI for a QR code. */
  @Post('totp')
  @HttpCode(200)
  @Access('authenticated')
  async enrol(@Req() req: AuthedRequest) {
    return this.mfa.enrol(req.auth!);
  }

  /** POST /auth/mfa/verify: confirms enrolment or a sign-in waiting for 2FA. */
  @Post('verify')
  @HttpCode(200)
  @Access('authenticated')
  async verify(
    @Body() raw: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const proof = parseInput(verifyBody, raw);
    const result = await this.mfa.verify(req.auth!, proof, clientOf(req));
    const session = sendSession(req, res, result.session, this.clock.now());
    return result.recoveryCodes ? { session, recoveryCodes: result.recoveryCodes } : { session };
  }
}
