import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session-token";
import {
  isPublicTelemetryPath,
  publicTelemetryProperties,
  removeEmpty,
} from "@/lib/telemetry";

/**
 * Gate private dashboards and capture lightweight request telemetry.
 * Session signatures are checked here (edge-compatible Web Crypto); the
 * session row itself is checked in the page, which redirects on expiry.
 */
export async function middleware(request: NextRequest, event: NextFetchEvent) {
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
      return responseWithTelemetry(request, event, responseWithCrawlerHeaders(request, response));
    }

    const login = new URL("/login", request.url);
    login.searchParams.set("next", request.nextUrl.pathname);
    response = NextResponse.redirect(login);
  }

  return responseWithTelemetry(request, event, responseWithCrawlerHeaders(request, response));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};

function responseWithTelemetry(
  request: NextRequest,
  event: NextFetchEvent,
  response: NextResponse,
): NextResponse {
  if (shouldCaptureTraffic(request)) {
    event.waitUntil(captureTraffic(request));
  }
  return response;
}

function responseWithCrawlerHeaders(request: NextRequest, response: NextResponse): NextResponse {
  if (isNoindexRoute(request.nextUrl.pathname)) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}

function isProtectedRoute(pathname: string): boolean {
  return pathname === "/reports" || pathname.startsWith("/reports/") || pathname.startsWith("/orgs/");
}

function isWwwHost(request: NextRequest): boolean {
  const headerHost = request.headers.get("host")?.split(":")[0]?.toLowerCase();
  return headerHost === "www.postil.dev" || request.nextUrl.hostname === "www.postil.dev";
}

function isNoindexRoute(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/reports" ||
    pathname.startsWith("/reports/") ||
    pathname.startsWith("/orgs/") ||
    pathname.startsWith("/api/")
  );
}

function shouldCaptureTraffic(request: NextRequest): boolean {
  if (!posthogProjectToken()) return false;
  if (process.env.POSTHOG_SERVER_CAPTURE === "0") return false;
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const pathname = request.nextUrl.pathname;
  if (!isPublicTelemetryPath(pathname)) return false;
  if (pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  if (pathname.startsWith("/brand/")) return false;
  if (pathname.startsWith("/images/")) return false;
  if (/\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|map|woff2?)$/i.test(pathname)) return false;

  return true;
}

async function captureTraffic(request: NextRequest): Promise<void> {
  const key = posthogProjectToken();
  if (!key) return;

  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com";
  const endpoint = `${host.replace(/\/+$/, "")}/i/v0/e/`;
  const publicProperties = publicTelemetryProperties(
    request.nextUrl,
    request.headers.get("referer"),
  );
  if (!publicProperties) return;
  const properties = removeEmpty({
    $process_person_profile: false,
    ...publicProperties,
    $raw_user_agent: request.headers.get("user-agent"),
    cf_country: request.headers.get("cf-ipcountry"),
    cf_ray: request.headers.get("cf-ray"),
    cf_bot_score: numericHeader(request, "cf-bot-score"),
    method: request.method,
  });

  await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event: "postil_http_request",
      distinct_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      properties,
    }),
  }).catch(() => undefined);
}

function posthogProjectToken(): string | undefined {
  return process.env.POSTHOG_PROJECT_TOKEN ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
}

function numericHeader(request: NextRequest, name: string): number | undefined {
  const value = request.headers.get(name);
  if (!value) return undefined;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}
