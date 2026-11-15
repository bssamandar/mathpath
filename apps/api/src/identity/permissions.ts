/**
 * Role-based access control (security plan C-09, C-08, C-14).
 *
 * Every route declares one access level with {@link Access}: `public`,
 * `authenticated`, or a permission such as `progress:read`. The same value is
 * written as `x-permission` in docs/api/openapi.yaml, and a test checks that
 * the two agree. A route without a declaration is refused (deny by default),
 * so forgetting the decorator fails closed instead of exposing the route.
 *
 * Roles map to permissions here, in code and not in config: a change to who
 * may do what is a security change that deserves a reviewed code change and a
 * test, not a YAML edit.
 *
 * Object-level checks ("own children only") are separate policy functions in
 * each module (C-10); a permission only says the kind of action is allowed.
 */
import type { Role } from '@mathpath/db';
import { SetMetadata } from '@nestjs/common';
import { STAFF_ROLES } from './session.service';

/** Every permission named in docs/api/openapi.yaml (`x-permission`). */
export const PERMISSIONS = [
  'learning:write',
  'assessment:take',
  'progress:read',
  'gamification:read',
  'content:read',
  'family:read',
  'family:manage',
  'family:switch_profile',
  'billing:read',
  'billing:purchase',
  'billing:manage',
  'privacy:request',
  'classroom:join',
  'classroom:manage',
  'content:author',
  'content:review',
  'content:publish',
  'admin:users',
  'admin:risk',
  'admin:billing',
  'admin:audit',
  // Payment callbacks: authenticated by the provider's signature, not by a
  // user. The billing module adds that check; until then these are refused.
  'provider:payme',
  'provider:click',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** What a route requires. */
export type RouteAccess = 'public' | 'authenticated' | Permission;

const LEARNER: readonly Permission[] = [
  'learning:write',
  'assessment:take',
  'progress:read',
  'gamification:read',
  'content:read',
  'classroom:join',
];

/**
 * The security plan's role table (§3). `progress:read` is object-checked:
 * a parent reads only their own children, a teacher only consented class members.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  student: LEARNER,
  parent: [
    'progress:read',
    'content:read',
    'family:read',
    'family:manage',
    'family:switch_profile',
    'billing:read',
    'billing:purchase',
    'billing:manage',
    'privacy:request',
  ],
  teacher: ['progress:read', 'content:read', 'classroom:manage', 'privacy:request'],
  author: ['content:read', 'content:author'],
  // A reviewer can also author; the four-eyes rule (C-18) stops them
  // reviewing their own work, in the content module.
  reviewer: ['content:read', 'content:author', 'content:review', 'content:publish'],
  admin: [
    'progress:read',
    'content:read',
    'content:publish',
    'admin:users',
    'admin:risk',
    'admin:billing',
    'admin:audit',
  ],
  // Support gets read-only, masked access when the support console is built
  // (C-14). Until then it has no permissions, which is the safe default.
  support: [],
};

/**
 * Computes what a signed-in user may do.
 *
 * Staff roles count only after TOTP 2FA (C-08): a staff member who has not
 * passed 2FA in this session keeps the permissions of their other roles only.
 */
export function permissionsFor(roles: readonly Role[], mfaVerified: boolean): Set<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    if (STAFF_ROLES.has(role) && !mfaVerified) continue;
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return granted;
}

/** True when a role would grant the permission if 2FA were completed. */
export function needsMfaFor(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((r) => STAFF_ROLES.has(r) && ROLE_PERMISSIONS[r].includes(permission));
}

export const ACCESS_METADATA = 'mathpath:access';

/** Declares what a route requires. Must match the route's `x-permission` in OpenAPI. */
export const Access = (access: RouteAccess): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCESS_METADATA, access);
