/** The shared browser client (packages/client), plus where the web app sends people. */
export {
  api,
  ApiError,
  API_BASE,
  currentSession,
  forgetSession,
  refreshSession,
  rememberSession,
  type SessionInfo,
} from '@mathpath/client';

/** Where a newly signed-in user starts. */
export function homeFor(roles: readonly string[]): string {
  return roles.includes('student') && !roles.includes('parent') ? '/student' : '/parent';
}
