import { NextResponse } from "next/server";

import {
  bearerCliToken,
  isCliRefreshToken,
  readCliJsonBody,
  revokeCliCredentials,
} from "@/lib/cli-auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revoke a CLI access token, refresh token, or both without exposing their state. */
export async function POST(request: Request): Promise<NextResponse> {
  const accessToken = bearerCliToken(request.headers.get("authorization"));
  const parsed = await readCliJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: { message: "invalid logout request", type: "invalid_request" } },
      {
        status: parsed.status,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
  if (
    parsed.body !== null &&
    (typeof parsed.body !== "object" || Array.isArray(parsed.body))
  ) {
    return NextResponse.json(
      { error: { message: "invalid logout request", type: "invalid_request" } },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  const suppliedRefreshToken =
    parsed.body === null
      ? undefined
      : (parsed.body as Record<string, unknown>).refreshToken;
  if (
    suppliedRefreshToken !== undefined &&
    !isCliRefreshToken(suppliedRefreshToken)
  ) {
    return NextResponse.json(
      { error: { message: "postil login required", type: "invalid_token" } },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }
  const refreshToken = isCliRefreshToken(suppliedRefreshToken)
    ? suppliedRefreshToken
    : undefined;
  if (!accessToken && !refreshToken) {
    return NextResponse.json(
      { error: { message: "postil login required", type: "invalid_token" } },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }

  const db = getDb();
  await revokeCliCredentials(db, {
    accessToken: accessToken ?? undefined,
    refreshToken,
  });

  return new NextResponse(null, {
    status: 204,
    headers: { "cache-control": "private, no-store" },
  });
}
