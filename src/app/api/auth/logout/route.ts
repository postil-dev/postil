import { NextResponse } from "next/server";

import { destroySessionByToken, SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const header = request.headers.get("cookie") ?? "";
  let token: string | undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) token = decodeURIComponent(rest.join("="));
  }
  await destroySessionByToken(token);
  const response = NextResponse.redirect(new URL("/", new URL(request.url).origin), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
