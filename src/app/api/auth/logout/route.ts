import { NextResponse } from "next/server";

import { publicOrigin } from "@/lib/oauth";
import { destroySessionByToken, SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const origin = request.headers.get("origin");
  const expectedOrigin = publicOrigin(request);

  // Reject cross-origin form posts (CSRF protection).
  if (!origin || origin !== expectedOrigin) {
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
