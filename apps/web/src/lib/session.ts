// Server-only: reads the better-auth session for server components and route handlers.
import type { Route } from 'next';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { PASSWORD_CHANGE_PATH, loginLocation } from '@pod-studio/core';
import { getAuth } from '@/lib/auth';

export type CurrentSession = NonNullable<Awaited<ReturnType<ReturnType<typeof getAuth>['api']['getSession']>>>;

/** The signed-in session for this request, or null. Cached per request. */
export const getCurrentSession = cache(async (): Promise<CurrentSession | null> => {
  // Read the request headers first: during `next build` this marks the route as dynamic before
  // getAuth() would need runtime env vars (DATABASE_URL, BETTER_AUTH_SECRET) that a build lacks.
  const requestHeaders = await headers();
  return getAuth().api.getSession({ headers: requestHeaders });
});

/**
 * Second line behind proxy.ts for app pages: an anonymous request goes to sign-in, a temporary
 * password goes to the change-password page. Returns the session otherwise.
 */
export async function requireAppSession(path: string): Promise<CurrentSession> {
  const session = await getCurrentSession();
  // loginLocation only builds same-site paths (safeNextPath), so the cast is sound.
  if (!session) redirect(loginLocation(path) as Route);
  if (session.user.mustChangePassword) redirect(PASSWORD_CHANGE_PATH);
  return session;
}
