import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

import { publicOrigin } from "@/lib/oauth";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session-token";

/**
 * Gate private dashboards. Session signatures are checked here (edge-compatible
 * Web Crypto); the session row itself is checked in the page, which redirects
 * on expiry.
 */
export async function middleware(request: NextRequest, _event?: NextFetchEvent) {
  if (isWwwHost(request)) {
    const canonicalUrl = request.nextUrl.clone();
    canonicalUrl.protocol = "https:";
    canonicalUrl.hostname = "postil.dev";
    canonicalUrl.port = "";
    return NextResponse.redirect(canonicalUrl, 308);
  }

  const protectedRoute = isProtectedRoute(request.nextUrl.pathname);
  let response = NextResponse.next();

  if (protectedRoute) {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const secret = process.env.POSTIL_SESSION_SECRET;
    const sessionId = secret ? await verifySessionToken(token, secret) : null;
    if (sessionId) {
      return responseWithCrawlerHeaders(request, response);
    }

    const login = new URL("/login", publicOrigin(request));
    login.searchParams.set("next", request.nextUrl.pathname);
    response = NextResponse.redirect(login);
  }

  return responseWithCrawlerHeaders(request, response);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};

function responseWithCrawlerHeaders(request: NextRequest, response: NextResponse): NextResponse {
  if (isNoindexRoute(request.nextUrl.pathname)) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  if (isVerificationRoute(request.nextUrl.pathname)) {
    response.headers.set("Referrer-Policy", "no-referrer");
  }
  return response;
}

function isProtectedRoute(pathname: string): boolean {
  return (
    pathname === "/operator" ||
    pathname.startsWith("/operator/") ||
    pathname === "/reports" ||
    pathname.startsWith("/reports/") ||
    pathname.startsWith("/orgs/")
  );
}

function isWwwHost(request: NextRequest): boolean {
  const headerHost = request.headers.get("host")?.split(":")[0]?.toLowerCase();
  return headerHost === "www.postil.dev" || request.nextUrl.hostname === "www.postil.dev";
}

function isNoindexRoute(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/operator" ||
    pathname.startsWith("/operator/") ||
    pathname === "/reports" ||
    pathname.startsWith("/reports/") ||
    isVerificationRoute(pathname) ||
    pathname.startsWith("/orgs/") ||
    pathname.startsWith("/api/")
  );
}

function isVerificationRoute(pathname: string): boolean {
  return pathname === "/verify" || pathname.startsWith("/verify/");
}
