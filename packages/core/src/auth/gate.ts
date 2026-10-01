/** The only page a temporary-password account may open. */
export const PASSWORD_CHANGE_PATH = '/change-password';

/** Mount point of the better-auth router in the web app. */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * Auth endpoints a temporary-password account may still call: read its session, leave, change the
 * password, or sign in again (signing in never acts on the current session).
 */
export const PASSWORD_CHANGE_AUTH_PATHS: readonly string[] = ['/get-session', '/sign-out', '/password/change', '/sign-in/email'];

/** Paths that never carry account data and stay reachable for anyone (liveness probes). */
const PUBLIC_API_PATHS = ['/api/health'];

export type RequestAccess =
  | { kind: 'allow' }
  | { kind: 'redirect'; location: string }
  | { kind: 'forbidden'; code: 'PASSWORD_CHANGE_REQUIRED' };

const ALLOW: RequestAccess = { kind: 'allow' };
const PASSWORD_CHANGE_FORBIDDEN: RequestAccess = { kind: 'forbidden', code: 'PASSWORD_CHANGE_REQUIRED' };

function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Decides whether a signed-in user may reach `pathname` (a full app path such as `/orders` or
 * `/api/auth/list-sessions`). Only the temporary-password gate (ADR 0002) lives here; anonymous
 * access and store permissions are separate gates.
 */
export function resolveRequestAccess(
  pathname: string,
  user: { mustChangePassword?: boolean | null } | null | undefined,
): RequestAccess {
  if (!user?.mustChangePassword) return ALLOW;
  if (within(pathname, PASSWORD_CHANGE_PATH) || PUBLIC_API_PATHS.some((path) => within(pathname, path))) return ALLOW;
  if (within(pathname, AUTH_BASE_PATH)) {
    return PASSWORD_CHANGE_AUTH_PATHS.includes(pathname.slice(AUTH_BASE_PATH.length)) ? ALLOW : PASSWORD_CHANGE_FORBIDDEN;
  }
  if (within(pathname, '/api')) return PASSWORD_CHANGE_FORBIDDEN;
  return { kind: 'redirect', location: PASSWORD_CHANGE_PATH };
}
