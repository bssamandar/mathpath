/**
 * Catalogue (docs/api/openapi.yaml, tag Catalogue) and Studio (tag Studio) endpoints.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { AppConfig } from '@mathpath/config';
import { Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { parseInput } from '../common/validation';
import { BUSINESS_RULES } from '../config/tokens';
import type { AuthedRequest } from '../identity/auth.guard';
import { Access } from '../identity/permissions';
import { CatalogueService } from './catalogue.service';
import { topicVersionInput } from './documents';
import { StudioService } from './studio.service';

const id = z.uuid();
const LOCALES = ['uz-Latn', 'ru', 'en'];

/**
 * The reader's language: `?locale=` if given (the web app sends the one the
 * user chose), else the first supported Accept-Language entry, else the default.
 */
export function readerLocale(req: Request, query: unknown, fallback: string): string {
  if (typeof query === 'string' && LOCALES.includes(query)) return query;
  for (const part of (req.get('accept-language') ?? '').split(',')) {
    const tag = part.split(';')[0]!.trim().toLowerCase();
    if (tag.startsWith('uz')) return 'uz-Latn';
    if (tag.startsWith('ru')) return 'ru';
    if (tag.startsWith('en')) return 'en';
  }
  return fallback;
}

@Controller()
export class CatalogueController {
  constructor(
    private readonly catalogue: CatalogueService,
    @Inject(BUSINESS_RULES) private readonly rules: AppConfig,
  ) {}

  /** GET /tracks */
  @Get('tracks')
  @Access('public')
  async tracks(@Req() req: Request, @Query('locale') locale: unknown) {
    return { items: await this.catalogue.tracks(this.locale(req, locale)) };
  }

  /** GET /courses/{courseId}: public; `locked` reflects the caller's access when signed in. */
  @Get('courses/:courseId')
  @Access('public')
  async course(
    @Param('courseId') courseId: string,
    @Req() req: AuthedRequest,
    @Query('locale') locale: unknown,
  ) {
    return this.catalogue.courseTree(
      parseInput(id, courseId),
      this.locale(req, locale),
      req.auth?.userId ?? null,
    );
  }

  /** GET /topics/{topicId}/lesson */
  @Get('topics/:topicId/lesson')
  @Access('content:read')
  async lesson(
    @Param('topicId') topicId: string,
    @Req() req: AuthedRequest,
    @Query('locale') locale: unknown,
  ) {
    return this.catalogue.lesson(
      parseInput(id, topicId),
      this.locale(req, locale),
      req.auth!.userId,
    );
  }

  private locale(req: Request, query: unknown): string {
    return readerLocale(req, query, this.rules.content.defaultLocale);
  }
}

const reviewBody = z
  .object({
    decision: z.enum(['approved', 'changes_requested']),
    comments: z
      .array(
        z
          .object({
            anchor: z.string().max(200).optional(),
            text: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();

@Controller('studio')
export class StudioController {
  constructor(private readonly studio: StudioService) {}

  /** GET /studio/topics/{topicId}/versions */
  @Get('topics/:topicId/versions')
  @Access('content:author')
  async versions(@Param('topicId') topicId: string) {
    return { items: await this.studio.listVersions(parseInput(id, topicId)) };
  }

  /** POST /studio/topics/{topicId}/versions */
  @Post('topics/:topicId/versions')
  @HttpCode(201)
  @Access('content:author')
  async createDraft(
    @Param('topicId') topicId: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const version = await this.studio.createDraft(req.auth!, parseInput(id, topicId));
    res.setHeader('ETag', version.etag);
    return version;
  }

  /** GET /studio/topic-versions/{versionId} */
  @Get('topic-versions/:versionId')
  @Access('content:author')
  async version(@Param('versionId') versionId: string, @Res({ passthrough: true }) res: Response) {
    const version = await this.studio.getVersion(parseInput(id, versionId));
    res.setHeader('ETag', version.etag);
    return version;
  }

  /** PUT /studio/topic-versions/{versionId}: needs If-Match (lost-update protection). */
  @Put('topic-versions/:versionId')
  @Access('content:author')
  async save(
    @Param('versionId') versionId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() raw: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseInput(topicVersionInput, raw);
    const version = await this.studio.saveDraft(
      req.auth!,
      parseInput(id, versionId),
      ifMatch,
      input,
    );
    res.setHeader('ETag', version.etag);
    return version;
  }

  /** POST /studio/versions/{versionId}/submit */
  @Post('versions/:versionId/submit')
  @HttpCode(200)
  @Access('content:author')
  async submit(@Param('versionId') versionId: string, @Req() req: AuthedRequest) {
    return this.studio.submit(req.auth!, parseInput(id, versionId));
  }

  /** POST /studio/versions/{versionId}/review */
  @Post('versions/:versionId/review')
  @HttpCode(200)
  @Access('content:review')
  async review(
    @Param('versionId') versionId: string,
    @Body() raw: unknown,
    @Req() req: AuthedRequest,
  ) {
    const body = parseInput(reviewBody, raw);
    return this.studio.review(req.auth!, parseInput(id, versionId), body.decision, body.comments);
  }

  /** POST /studio/versions/{versionId}/publish */
  @Post('versions/:versionId/publish')
  @HttpCode(200)
  @Access('content:publish')
  async publish(@Param('versionId') versionId: string, @Req() req: AuthedRequest) {
    return this.studio.publish(req.auth!, parseInput(id, versionId));
  }
}
