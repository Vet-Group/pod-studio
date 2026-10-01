import { NextResponse, type NextRequest } from 'next/server';
import { PASSWORD_CHANGE_REQUIRED, resolveRequestAccess } from '@pod-studio/core';
import { getAuth } from '@/lib/auth';

/**
 * Request gate, first line (ADR 0002). Anonymous visitors see only sign-in and invite pages; a
 * signed-in account whose password is still the one an admin issued sees only the change-password
 * page; app APIs answer 401/403. The second line runs inside better-auth and in each page's server
 * code, so neither the auth API nor the app opens up if this proxy is skipped.
 */
export async function proxy(request: NextRequest) {
  const hasSession = request.cookies.getAll().some((cookie) => cookie.name.endsWith('session_token'));
  const session = hasSession ? await getAuth().api.getSession({ headers: request.headers }) : null;
  const access = resolveRequestAccess(request.nextUrl.pathname, session?.user, request.nextUrl.search);
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
    case 'unauthorized':
      return NextResponse.json({ code: access.code, message: 'Sign in to continue.' }, { status: 401 });
  }
}

export const config = {
  // Static assets never carry account data.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js|map)$).*)'],
};
