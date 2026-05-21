import { NextResponse, type NextRequest } from "next/server";

const AUTH_COOKIE_NAME = "access_token";
const PUBLIC_PATHS = ["/login", "/set-password"];

/**
 * Server-side auth gate. Authoritative validation happens at the API
 * layer (the JWT may have expired even if the cookie is present); this
 * middleware just blocks navigation to authed pages without a cookie
 * so users don't see a flash of empty dashboard before being bounced.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const hasAuthCookie = Boolean(request.cookies.get(AUTH_COOKIE_NAME));
  if (hasAuthCookie) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Skip Next internals + static assets so middleware only runs on
  // page requests.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|vayada-logo.png).*)"],
};
