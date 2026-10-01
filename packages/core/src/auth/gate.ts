/** The only page a temporary-password account may open. */
export const PASSWORD_CHANGE_PATH = '/change-password';

/** Sign-in page; anonymous visitors of any other page land here. */
export const LOGIN_PATH = '/login';

/** Invite links: `/invite/<token>`. Reachable without an account, since that is their purpose. */
export const INVITE_PATH = '/invite';

/** Mount point of the better-auth router in the web app. */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * Auth endpoints a temporary-password account may still call: read its session, leave, change the
 * password, or sign in again (signing in never acts on the current session).
 */
export const PASSWORD_CHANGE_AUTH_PATHS: readonly string[] = ['/get-session', '/sign-out', '/password/change', '/sign-in/email'];

/** Paths that never carry account data and stay reachable for anyone (liveness probes). */
const PUBLIC_API_PATHS = ['/api/health'];

/** Pages an anonymous visitor may open. better-auth guards its own endpoints under AUTH_BASE_PATH. */
const PUBLIC_PAGES = [LOGIN_PATH, INVITE_PATH];

export type RequestAccess =
  | { kind: 'allow' }
  | { kind: 'redirect'; location: string }
  | { kind: 'forbidden'; code: 'PASSWORD_CHANGE_REQUIRED' }
  | { kind: 'unauthorized'; code: 'UNAUTHORIZED' };

const ALLOW: RequestAccess = { kind: 'allow' };
const PASSWORD_CHANGE_FORBIDDEN: RequestAccess = { kind: 'forbidden', code: 'PASSWORD_CHANGE_REQUIRED' };
const UNAUTHORIZED: RequestAccess = { kind: 'unauthorized', code: 'UNAUTHORIZED' };

function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Returns `value` when it is a path on this site, otherwise `/`. Guards the `next` parameter of the
 * sign-in page against open redirects (`//evil.example`, `/\evil.example`, `https://...`).
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
  if (value.startsWith('//') || value.startsWith('/\\') || /[\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
}

/** Sign-in URL that returns to `path` afterwards. */
export function loginLocation(path: string): string {
  const next = safeNextPath(path);
  return next === '/' ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

/**
 * Decides whether a request for `pathname` (a full app path such as `/orders` or
 * `/api/auth/list-sessions`) may proceed. `user` is the signed-in user or null; `search` is the query
 * string, kept so sign-in can return to the exact page. Store permissions are a separate gate.
 */
export function resolveRequestAccess(
  pathname: string,
  user: { mustChangePassword?: boolean | null } | null | undefined,
  search = '',
): RequestAccess {
  const publicApi = PUBLIC_API_PATHS.some((path) => within(pathname, path));

  if (!user) {
    if (publicApi || within(pathname, AUTH_BASE_PATH) || PUBLIC_PAGES.some((path) => within(pathname, path))) return ALLOW;
    if (within(pathname, '/api')) return UNAUTHORIZED;
    return { kind: 'redirect', location: loginLocation(`${pathname}${search}`) };
  }

  if (user.mustChangePassword) {
    if (within(pathname, PASSWORD_CHANGE_PATH) || publicApi) return ALLOW;
    if (within(pathname, AUTH_BASE_PATH)) {
      return PASSWORD_CHANGE_AUTH_PATHS.includes(pathname.slice(AUTH_BASE_PATH.length)) ? ALLOW : PASSWORD_CHANGE_FORBIDDEN;
    }
    if (within(pathname, '/api')) return PASSWORD_CHANGE_FORBIDDEN;
    return { kind: 'redirect', location: PASSWORD_CHANGE_PATH };
  }

  // Already signed in: the sign-in page has nothing to offer.
  if (within(pathname, LOGIN_PATH)) return { kind: 'redirect', location: '/' };
  return ALLOW;
}
