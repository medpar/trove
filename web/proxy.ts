import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';

/** Pages require a session; APIs authenticate themselves (session cookie or API key). */
export function proxy(request: NextRequest) {
  if (verifySession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!api|login|_next|icons|manifest.webmanifest|sw.js|llms.txt|openapi.json|trove.shortcut|shortcuts|favicon.ico|robots.txt|install).*)'],
};
