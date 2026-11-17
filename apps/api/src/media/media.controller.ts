/**
 * Media endpoints (docs/api/openapi.yaml, tags Media and Studio).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { parseInput } from '../common/validation';
import type { AuthedRequest } from '../identity/auth.guard';
import { Access } from '../identity/permissions';
import { RENDITION_NAME } from './hls';
import { type MediaActor, MediaService } from './media.service';

const id = z.uuid();
const token = z.string().min(10).max(512);
const playlistName = z
  .string()
  .regex(new RegExp(`^(?:master|${RENDITION_NAME.source.slice(1, -1)})\\.m3u8$`));

const uploadBody = z
  .object({
    kind: z.enum(['video', 'image', 'subtitle']),
    contentType: z.enum(['video/mp4', 'image/png', 'image/jpeg', 'image/svg+xml', 'text/vtt']),
    sizeBytes: z.number().int().min(1).max(2_147_483_648),
    locale: z.enum(['uz-Latn', 'ru', 'en']).optional(),
    videoId: z.uuid().optional(),
  })
  .strict();

function actorOf(req: AuthedRequest): MediaActor {
  return req.auth!;
}

/** Playlists and keys must never be stored by a shared cache. */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, private');
}

@Controller('studio/media')
export class StudioMediaController {
  constructor(private readonly media: MediaService) {}

  /** POST /studio/media/uploads */
  @Post('uploads')
  @HttpCode(201)
  @Access('content:author')
  async createUpload(@Body() raw: unknown, @Req() req: AuthedRequest) {
    return this.media.createUpload(actorOf(req), parseInput(uploadBody, raw));
  }

  /** POST /studio/media/{mediaId}/complete */
  @Post(':mediaId/complete')
  @HttpCode(200)
  @Access('content:author')
  async complete(@Param('mediaId') mediaId: string, @Req() req: AuthedRequest) {
    return this.media.completeUpload(actorOf(req), parseInput(id, mediaId));
  }

  /** GET /studio/media/{mediaId} */
  @Get(':mediaId')
  @Access('content:author')
  async asset(@Param('mediaId') mediaId: string) {
    return this.media.asset(parseInput(id, mediaId));
  }
}

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** GET /media/{mediaId}/playback */
  @Get(':mediaId/playback')
  @Access('content:read')
  async playback(
    @Param('mediaId') mediaId: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    noStore(res);
    return this.media.playback(actorOf(req), parseInput(id, mediaId));
  }

  /** GET /media/{mediaId}/hls/{name}.m3u8?token= */
  @Get(':mediaId/hls/:playlist')
  @Access('content:read')
  async playlist(
    @Param('mediaId') mediaId: string,
    @Param('playlist') playlist: string,
    @Query('token') rawToken: unknown,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    const file = parseInput(playlistName, playlist);
    const body = await this.media.playlist(
      actorOf(req),
      parseInput(id, mediaId),
      file.slice(0, -'.m3u8'.length),
      parseInput(token, rawToken),
    );
    noStore(res);
    res.type('application/vnd.apple.mpegurl').send(body);
  }

  /** GET /media/{mediaId}/key?token= */
  @Get(':mediaId/key')
  @Access('content:read')
  async key(
    @Param('mediaId') mediaId: string,
    @Query('token') rawToken: unknown,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    const key = await this.media.key(
      actorOf(req),
      parseInput(id, mediaId),
      parseInput(token, rawToken),
    );
    noStore(res);
    res.type('application/octet-stream').send(key);
  }
}
