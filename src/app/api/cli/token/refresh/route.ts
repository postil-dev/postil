import { NextResponse } from "next/server";

import {
  isCliRefreshToken,
  readCliJsonBody,
  refreshCliSession,
} from "@/lib/cli-auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Exchange a one-time CLI refresh credential for a new access and refresh pair. */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = await readCliJsonBody(request);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error: { message: "invalid refresh request", type: "invalid_request" },
      },
      {
        status: parsed.status,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
  if (
    typeof parsed.body !== "object" ||
    parsed.body === null ||
    Array.isArray(parsed.body)
  ) {
    return NextResponse.json(
      {
        error: { message: "invalid refresh request", type: "invalid_request" },
      },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  const refreshToken = (parsed.body as Record<string, unknown>).refreshToken;
  if (!isCliRefreshToken(refreshToken)) {
    return NextResponse.json(
      { error: { message: "postil login required", type: "invalid_token" } },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }

  const result = await refreshCliSession(getDb(), refreshToken);
  if (result.status === "rate_limited") {
    return NextResponse.json(
      {
        error: {
          message: "CLI session refresh is not available yet",
          type: "rate_limited",
        },
      },
      {
        status: 429,
        headers: {
          "cache-control": "private, no-store",
          "retry-after": String(result.retryAfterSeconds),
        },
      },
    );
  }
  if (result.status !== "approved") {
    return NextResponse.json(
      { error: { message: "postil login required", type: "invalid_token" } },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }
  return NextResponse.json(
    {
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      refreshToken: result.refreshToken,
      refreshExpiresAt: result.refreshExpiresAt.toISOString(),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
