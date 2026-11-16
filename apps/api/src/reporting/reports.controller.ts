/**
 * Report endpoints (docs/api/openapi.yaml, tag Reports).
 */
import type { AppConfig } from '@mathpath/config';
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '../common/validation';
import { BUSINESS_RULES } from '../config/tokens';
import { readerLocale } from '../content/content.controller';
import type { AuthedRequest } from '../identity/auth.guard';
import { Access } from '../identity/permissions';
import { LearningService } from '../learning/learning.service';
import { ReportsService } from './reports.service';

const id = z.uuid();
const day = z.iso.date();

@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly learning: LearningService,
    @Inject(BUSINESS_RULES) private readonly rules: AppConfig,
  ) {}

  /** GET /students/{studentId}/reports/weekly?weekStart= (the student or their parent). */
  @Get('students/:studentId/reports/weekly')
  @Access('progress:read')
  async weekly(
    @Req() req: AuthedRequest,
    @Param('studentId') studentId: string,
    @Query('weekStart') weekStart: unknown,
    @Query('locale') locale: unknown,
  ) {
    const student = parseInput(id, studentId);
    await this.learning.assertCanRead(req.auth!.userId, student);
    return this.reports.weekly(
      student,
      weekStart === undefined ? undefined : parseInput(day, weekStart),
      readerLocale(req, locale, this.rules.content.defaultLocale),
    );
  }
}
