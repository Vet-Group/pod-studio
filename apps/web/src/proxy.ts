import { NextResponse, type NextRequest } from 'next/server';
import { PASSWORD_CHANGE_REQUIRED, resolveRequestAccess } from '@pod-studio/core';
import { getAuth } from '@/lib/auth';

/**
 * Temporary-password gate, first line (ADR 0002). A signed-in account whose password is still the
 * one an admin issued sees only the change-password page; app APIs answer 403. The second line runs
 * inside better-auth, so the auth API stays closed even if this proxy is skipped.
 */
export async function proxy(request: NextRequest) {
  if (!request.cookies.getAll().some((cookie) => cookie.name.endsWith('session_token'))) return NextResponse.next();

  const session = await getAuth().api.getSession({ headers: request.headers });
  const access = resolveRequestAccess(request.nextUrl.pathname, session?.user);
  switch (access.kind) {
    case 'allow':
      return NextResponse.next();
    case 'redirect':
      return NextResponse.redirect(new URL(access.location, request.url));
    case 'forbidden':
      return NextResponse.json(
        { code: access.code, message: PASSWORD_CHANGE_REQUIRED.message },
        { status: 403 },
      );
  }
}

export const config = {
  // Static assets never carry account data.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js|map)$).*)'],
};
