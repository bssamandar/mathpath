/**
 * Learning endpoints (docs/api/openapi.yaml, tag Learning).
 */
import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { AppConfig } from '@mathpath/config';
import { z } from 'zod';
import { parseInput } from '../common/validation';
import { BUSINESS_RULES } from '../config/tokens';
import { readerLocale } from '../content/content.controller';
import type { AuthedRequest } from '../identity/auth.guard';
import { Access } from '../identity/permissions';
import { LearningService } from './learning.service';

const id = z.uuid();
const stepIndex = z.coerce.number().int().min(0).max(100);

@Controller()
export class LearningController {
  constructor(
    private readonly learning: LearningService,
    @Inject(BUSINESS_RULES) private readonly rules: AppConfig,
  ) {}

  /** GET /students/{studentId}/learning-path?courseId= */
  @Get('students/:studentId/learning-path')
  @Access('progress:read')
  async path(
    @Req() req: AuthedRequest,
    @Param('studentId') studentId: string,
    @Query('courseId') courseId: unknown,
    @Query('locale') locale: unknown,
  ) {
    const student = parseInput(id, studentId);
    await this.learning.assertCanRead(req.auth!.userId, student);
    return this.learning.learningPath(student, parseInput(id, courseId), this.locale(req, locale));
  }

  /** GET /students/{studentId}/progress?courseId= */
  @Get('students/:studentId/progress')
  @Access('progress:read')
  async progress(
    @Req() req: AuthedRequest,
    @Param('studentId') studentId: string,
    @Query('courseId') courseId: unknown,
    @Query('locale') locale: unknown,
  ) {
    const student = parseInput(id, studentId);
    await this.learning.assertCanRead(req.auth!.userId, student);
    return this.learning.progress(student, parseInput(id, courseId), this.locale(req, locale));
  }

  /** POST /topics/{topicId}/steps/{stepIndex}/complete */
  @Post('topics/:topicId/steps/:stepIndex/complete')
  @HttpCode(204)
  @Access('learning:write')
  async complete(
    @Req() req: AuthedRequest,
    @Param('topicId') topicId: string,
    @Param('stepIndex') index: string,
  ): Promise<void> {
    await this.learning.completeStep(
      req.auth!.userId,
      parseInput(id, topicId),
      parseInput(stepIndex, index),
    );
  }

  /** GET /me/reviews/due */
  @Get('me/reviews/due')
  @Access('learning:write')
  async due(@Req() req: AuthedRequest, @Query('locale') locale: unknown) {
    return this.learning.dueReviews(req.auth!.userId, this.locale(req, locale));
  }

  private locale(req: AuthedRequest, query: unknown): string {
    return readerLocale(req, query, this.rules.content.defaultLocale);
  }
}
