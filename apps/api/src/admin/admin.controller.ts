/**
 * Admin endpoints (docs/api/openapi.yaml, tag Admin). Studio only; every
 * permission here is a staff one, so it needs a session that passed 2FA.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { pageLimit } from '../common/cursor';
import { parseInput } from '../common/validation';
import type { AuthedRequest } from '../identity/auth.guard';
import { clientOf } from '../identity/http';
import { Access } from '../identity/permissions';
import { AdminService, MANAGED_ROLES } from './admin.service';

const id = z.uuid();
const reason = z.string().trim().min(5).max(500);
const cursor = z.string().min(1).max(200).optional();

const searchQuery = z.object({
  q: z.string().trim().min(3).max(64),
  cursor,
  limit: pageLimit,
});

const userChange = z
  .object({
    status: z.enum(['active', 'locked', 'suspended']).optional(),
    addRoles: z.array(z.enum(MANAGED_ROLES)).max(5).optional(),
    removeRoles: z.array(z.enum(MANAGED_ROLES)).max(5).optional(),
    reason,
  })
  .strict()
  .refine((b) => b.status !== undefined || b.addRoles?.length || b.removeRoles?.length, {
    message: 'change the status or a role',
    path: ['status'],
  });

const reviewsQuery = z.object({
  status: z.enum(['open', 'cleared', 'restricted', 'banned']).default('open'),
  cursor,
  limit: pageLimit,
});

const decisionBody = z
  .object({
    decision: z.enum(['cleared', 'restricted', 'banned']),
    notes: z.string().trim().min(5).max(1000),
  })
  .strict();

const auditQuery = z.object({
  actorId: id.optional(),
  targetId: id.optional(),
  action: z
    .string()
    .regex(/^[a-z_]+(\.[a-z_]+)*$/)
    .max(64)
    .optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor,
  limit: pageLimit,
});

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  @Access('admin:users')
  searchUsers(@Req() req: AuthedRequest, @Query() query: unknown) {
    const q = parseInput(searchQuery, query);
    return this.admin.searchUsers(req.auth!, clientOf(req), q.q, q.limit, q.cursor);
  }

  @Patch('users/:userId')
  @Access('admin:users')
  updateUser(@Req() req: AuthedRequest, @Param('userId') userId: unknown, @Body() body: unknown) {
    return this.admin.updateUser(
      req.auth!,
      clientOf(req),
      parseInput(id, userId),
      parseInput(userChange, body),
    );
  }

  @Get('risk-reviews')
  @Access('admin:risk')
  riskReviews(@Query() query: unknown) {
    const q = parseInput(reviewsQuery, query);
    return this.admin.riskReviews(q.status, q.limit, q.cursor);
  }

  @Post('risk-reviews/:reviewId/decision')
  @HttpCode(200)
  @Access('admin:risk')
  decide(@Req() req: AuthedRequest, @Param('reviewId') reviewId: unknown, @Body() body: unknown) {
    const b = parseInput(decisionBody, body);
    return this.admin.decide(
      req.auth!,
      clientOf(req),
      parseInput(id, reviewId),
      b.decision,
      b.notes,
    );
  }

  @Get('audit-log')
  @Access('admin:audit')
  auditLog(@Query() query: unknown) {
    const { cursor: after, limit, ...filter } = parseInput(auditQuery, query);
    return this.admin.auditLog(filter, limit, after);
  }
}
