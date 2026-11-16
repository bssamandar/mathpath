/**
 * Assessment endpoints (docs/api/openapi.yaml, tag Assessment).
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { AppConfig } from '@mathpath/config';
import type { Response } from 'express';
import { z } from 'zod';
import { parseInput } from '../common/validation';
import { BUSINESS_RULES } from '../config/tokens';
import { readerLocale } from '../content/content.controller';
import type { AuthedRequest } from '../identity/auth.guard';
import { Access } from '../identity/permissions';
import { AttemptsService } from './attempts.service';

const id = z.uuid();
const position = z.coerce.number().int().min(1).max(200);
/** The contract's IdempotencyKey parameter: a client-generated UUID. */
const idempotencyKey = z.uuid();

/** The optional Idempotency-Key header, checked when present. */
const readKey = (header: unknown): string | null =>
  header === undefined ? null : parseInput(idempotencyKey, header);

const startBody = z
  .object({
    type: z.enum(['diagnostic', 'practice', 'mastery', 'review', 'chapter', 'mock_exam']),
    topicId: id.optional(),
    chapterId: id.optional(),
    courseId: id.optional(),
    assignmentId: id.optional(),
  })
  .strict();

const choiceId = z.string().min(1).max(16);
const answerBody = z
  .object({
    response: z.union([
      z.object({ choiceIds: z.array(choiceId).min(1).max(10) }).strict(),
      z.object({ value: z.string().max(200) }).strict(),
    ]),
    clientElapsedMs: z.number().int().min(0).optional(),
    offlineQueuedAt: z.iso.datetime().optional(),
  })
  .strict();

@Controller()
export class AttemptsController {
  constructor(
    private readonly attempts: AttemptsService,
    @Inject(BUSINESS_RULES) private readonly rules: AppConfig,
  ) {}

  /** POST /attempts: 201 for a new attempt, 200 when an open one is resumed. */
  @Post('attempts')
  @Access('assessment:take')
  async start(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseInput(startBody, body);
    const { attempt, resumed } = await this.attempts.start(req.auth!.userId, input, readKey(key));
    res.status(resumed ? 200 : 201);
    return attempt;
  }

  /** GET /attempts/{attemptId} */
  @Get('attempts/:attemptId')
  @Access('assessment:take')
  async get(@Req() req: AuthedRequest, @Param('attemptId') attemptId: string) {
    return this.attempts.view(req.auth!.userId, parseInput(id, attemptId));
  }

  /** GET /attempts/{attemptId}/items/{position} */
  @Get('attempts/:attemptId/items/:position')
  @Access('assessment:take')
  async item(
    @Req() req: AuthedRequest,
    @Param('attemptId') attemptId: string,
    @Param('position') pos: string,
    @Query('locale') locale: unknown,
  ) {
    return this.attempts.item(
      req.auth!.userId,
      parseInput(id, attemptId),
      parseInput(position, pos),
      this.locale(req, locale),
    );
  }

  /** POST /attempts/{attemptId}/items/{position}/answer */
  @Post('attempts/:attemptId/items/:position/answer')
  @HttpCode(200)
  @Access('assessment:take')
  async answer(
    @Req() req: AuthedRequest,
    @Param('attemptId') attemptId: string,
    @Param('position') pos: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Query('locale') locale: unknown,
  ) {
    const input = parseInput(answerBody, body);
    return this.attempts.answer(
      req.auth!.userId,
      parseInput(id, attemptId),
      parseInput(position, pos),
      input.response,
      readKey(key),
      this.locale(req, locale),
    );
  }

  /** POST /attempts/{attemptId}/submit */
  @Post('attempts/:attemptId/submit')
  @HttpCode(200)
  @Access('assessment:take')
  async submit(
    @Req() req: AuthedRequest,
    @Param('attemptId') attemptId: string,
    @Query('locale') locale: unknown,
  ) {
    return this.attempts.submit(
      req.auth!.userId,
      parseInput(id, attemptId),
      this.locale(req, locale),
    );
  }

  /** GET /topics/{topicId}/assessment-status */
  @Get('topics/:topicId/assessment-status')
  @Access('assessment:take')
  async status(@Req() req: AuthedRequest, @Param('topicId') topicId: string) {
    return this.attempts.topicStatus(req.auth!.userId, parseInput(id, topicId));
  }

  private locale(req: AuthedRequest, query: unknown): string {
    return readerLocale(req, query, this.rules.content.defaultLocale);
  }
}
