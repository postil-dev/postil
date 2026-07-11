import { NextResponse } from "next/server";

import { publicOrigin } from "@/lib/oauth";
import { destroySessionByToken, SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const expectedOrigin = publicOrigin(request);

  // Reject cross-origin form posts (CSRF protection).
  if (!isSameOriginLogoutRequest(request, expectedOrigin)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const header = request.headers.get("cookie") ?? "";
  let token: string | undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) token = decodeURIComponent(rest.join("="));
  }
  await destroySessionByToken(token);
  const response = NextResponse.redirect(new URL("/", expectedOrigin), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

function isSameOriginLogoutRequest(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin) return origin === expectedOrigin;

  const referer = request.headers.get("referer");
  if (referer) return originFromUrl(referer) === expectedOrigin;

  return request.headers.get("sec-fetch-site") === "same-origin";
}

function originFromUrl(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
