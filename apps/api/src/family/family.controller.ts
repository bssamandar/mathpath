/**
 * /api/v1/children and child sign-in endpoints (docs/api/openapi.yaml, tag Family).
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Clock } from '../common/clock';
import { parseInput, personName } from '../common/validation';
import type { AuthedRequest } from '../identity/auth.guard';
import { clientOf, sendSession } from '../identity/http';
import { Access } from '../identity/permissions';
import { FamilyService } from './family.service';

// Mirrors the nickname CHECK in the database: letters, digits, space, _ and -.
// Nicknames are shown to other children, so no markup characters (C-13).
const nickname = z
  .string()
  .trim()
  .regex(/^[\p{L}\p{N} _-]{2,24}$/u, '2–24 letters, digits, spaces, _ or -');
const pin = z.string().regex(/^[0-9]{4,6}$/, '4–6 digits');
const grade = z.number().int().min(1).max(11);

const consentBody = z
  .object({
    policyVersion: z.string().min(1).max(32),
    scopes: z
      .array(z.enum(['learning', 'leaderboard', 'teacher_sharing', 'marketing_to_parent']))
      .min(1)
      .max(4),
    otpChallengeId: z.uuid(),
    otpCode: z.string().regex(/^[0-9]{4,8}$/),
  })
  .strict();

const addChildBody = z
  .object({
    firstName: personName,
    nickname,
    grade,
    birthYear: z.number().int().min(2005).max(2025).optional(),
    pin,
    consent: consentBody,
  })
  .strict();

const updateChildBody = z
  .object({
    nickname: nickname.optional(),
    grade: grade.optional(),
    pin: pin.optional(),
    dailyTimeLimitMin: z.number().int().min(10).max(240).nullable().optional(),
  })
  .strict();

const childIdParam = z.uuid();

@Controller('children')
export class ChildrenController {
  constructor(private readonly family: FamilyService) {}

  /** GET /children */
  @Get()
  @Access('family:read')
  async list(@Req() req: AuthedRequest) {
    return this.family.listChildren(req.auth!.userId);
  }

  /** POST /children: needs a `confirm_action` SMS code for consent. */
  @Post()
  @HttpCode(201)
  @Access('family:manage')
  async add(@Body() raw: unknown, @Req() req: AuthedRequest) {
    const body = parseInput(addChildBody, raw);
    return this.family.addChild(req.auth!, body, clientOf(req));
  }

  /** PATCH /children/{childId} */
  @Patch(':childId')
  @Access('family:manage')
  async update(@Param('childId') id: string, @Body() raw: unknown, @Req() req: AuthedRequest) {
    const childId = parseInput(childIdParam, id);
    const body = parseInput(updateChildBody, raw);
    return this.family.updateChild(req.auth!, childId, body, clientOf(req));
  }

  /** GET /children/{childId}/consents */
  @Get(':childId/consents')
  @Access('family:read')
  async consents(@Param('childId') id: string, @Req() req: AuthedRequest) {
    const childId = parseInput(childIdParam, id);
    return { items: await this.family.listConsents(req.auth!.userId, childId) };
  }

  /** POST /children/{childId}/consents */
  @Post(':childId/consents')
  @HttpCode(201)
  @Access('family:manage')
  async updateConsent(
    @Param('childId') id: string,
    @Body() raw: unknown,
    @Req() req: AuthedRequest,
  ) {
    const childId = parseInput(childIdParam, id);
    const body = parseInput(consentBody, raw);
    return this.family.updateConsent(req.auth!, childId, body, clientOf(req));
  }
}

const childLoginBody = z
  .object({
    familyCode: z.string().regex(/^[A-Za-z0-9]{6,8}$/),
    nickname: z.string().min(1).max(32),
    pin,
    deviceToken: z.string().max(512).optional(),
  })
  .strict();

const switchBody = z.object({ childId: z.uuid() }).strict();

@Controller('auth')
export class ChildAuthController {
  constructor(
    private readonly family: FamilyService,
    private readonly clock: Clock,
  ) {}

  /** POST /auth/child-login */
  @Post('child-login')
  @HttpCode(200)
  @Access('public')
  async childLogin(
    @Body() raw: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = parseInput(childLoginBody, raw);
    const session = await this.family.childLogin(body, clientOf(req));
    return sendSession(req, res, session, this.clock.now());
  }

  /** POST /auth/switch-profile */
  @Post('switch-profile')
  @HttpCode(200)
  @Access('family:switch_profile')
  async switchProfile(
    @Body() raw: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = parseInput(switchBody, raw);
    const session = await this.family.switchProfile(req.auth!, body.childId, clientOf(req));
    return sendSession(req, res, session, this.clock.now());
  }
}
