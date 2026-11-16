/**
 * Gamification endpoints (docs/api/openapi.yaml, tag Gamification).
 */
import { Controller, Get, Req } from '@nestjs/common';
import type { AuthedRequest } from '../identity/auth.guard';
import { Access } from '../identity/permissions';
import { GamificationService } from './gamification.service';

@Controller()
export class GamificationController {
  constructor(private readonly gamification: GamificationService) {}

  /** GET /me/gamification: XP, level, streak, badges and today's quests. */
  @Get('me/gamification')
  @Access('gamification:read')
  summary(@Req() req: AuthedRequest) {
    return this.gamification.summary(req.auth!.userId);
  }
}
