import { NextResponse } from "next/server";

import { publicOrigin } from "@/lib/oauth";
import { destroySessionByToken, SESSION_COOKIE } from "@/lib/session";
import { isSessionTokenFormat } from "@/lib/session-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const origin = request.headers.get("origin");
  const expectedOrigin = publicOrigin(request);

  // Reject cross-origin form posts (CSRF protection).
  if (origin && origin !== expectedOrigin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const tokenResult = sessionTokenFromCookieHeader(request.headers.get("cookie") ?? "");
  if (!tokenResult.ok) {
    return invalidSessionResponse(tokenResult.reason);
  }

  const token = tokenResult.token;
  await destroySessionByToken(token);
  const response = NextResponse.redirect(new URL("/", expectedOrigin), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

type SessionTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "missing" | "empty" | "undecodable" | "malformed" };
type InvalidSessionTokenReason = Extract<SessionTokenResult, { ok: false }>["reason"];

function sessionTokenFromCookieHeader(header: string): SessionTokenResult {
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k !== SESSION_COOKIE) continue;

    const encodedToken = rest.join("=");
    if (!encodedToken) return { ok: false, reason: "empty" };

    let token: string;
    try {
      token = decodeURIComponent(encodedToken);
    } catch {
      return { ok: false, reason: "undecodable" };
    }

    if (!isSessionTokenFormat(token)) return { ok: false, reason: "malformed" };
    return { ok: true, token };
  }

  return { ok: false, reason: "missing" };
}

function invalidSessionResponse(reason: InvalidSessionTokenReason): NextResponse {
  console.warn("logout rejected invalid session cookie", { reason });
  const response = NextResponse.json({ error: "invalid_session" }, { status: 400 });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
