import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session-token";

/**
 * Gate /reports and /orgs/* behind a validly signed session cookie. The
 * cookie signature is checked here (edge-compatible Web Crypto); the
 * session row itself is checked in the page, which redirects on expiry.
 */
export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.POSTIL_SESSION_SECRET;
  const sessionId = secret ? await verifySessionToken(token, secret) : null;
  if (!sessionId) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/reports/:path*", "/reports", "/orgs/:path*"],
};
