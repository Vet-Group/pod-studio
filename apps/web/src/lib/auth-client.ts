/**
 * Thin client for the better-auth endpoints the auth pages use. Same-origin fetch, so the session
 * cookie travels automatically and better-auth's origin check sees this site's Origin header.
 */
export interface AuthFailure {
  status: number;
  code: string | undefined;
  message: string;
}

export type AuthResult<T> = { ok: true; data: T } | { ok: false; error: AuthFailure };

const FALLBACK = 'Something went wrong. Check your connection and try again.';

/** Messages for codes better-auth produces itself; codes from @pod-studio/core carry their own. */
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'That email and password do not match an account.',
  INVALID_EMAIL: 'Enter a valid email address.',
  PASSWORD_TOO_SHORT: 'Password must be 10 to 128 characters.',
  PASSWORD_TOO_LONG: 'Password must be 10 to 128 characters.',
};

export async function authRequest<T = unknown>(path: string, body: Record<string, unknown>): Promise<AuthResult<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, error: { status: 0, code: undefined, message: FALLBACK } };
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return { ok: true, data: payload as T };

  const code = typeof payload?.code === 'string' ? payload.code : undefined;
  if (response.status === 429) {
    return { ok: false, error: { status: 429, code, message: 'Too many attempts. Wait a minute, then try again.' } };
  }
  const message =
    (code && MESSAGES[code]) || (typeof payload?.message === 'string' && payload.message) || FALLBACK;
  return { ok: false, error: { status: response.status, code, message } };
}

/** Full navigation, so server components and the proxy see the new session cookie at once. */
export function navigate(path: string) {
  window.location.assign(path);
}
