import { NextResponse } from "next/server";

import {
  createDeviceAuthorization,
  DEVICE_AUTHORIZATION_POLL_INTERVAL_SECONDS,
  DEVICE_AUTHORIZATION_TTL_MS,
} from "@/lib/cli-auth";
import { getDb } from "@/lib/db";
import { publicOrigin } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start a `postil login` device authorization. No session required. */
export async function POST(request: Request): Promise<NextResponse> {
  // The body carries only an informational client version that this endpoint
  // does not otherwise act on, so a missing or malformed body is tolerated.
  await request.text().catch(() => undefined);

  const { deviceCode, userCode } = await createDeviceAuthorization(getDb());
  const origin = publicOrigin(request);
  const verificationUri = new URL("/cli/authorize", origin).toString();
  const verificationUriComplete = new URL(
    `/cli/authorize?code=${encodeURIComponent(userCode)}`,
    origin,
  ).toString();

  return NextResponse.json(
    {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresIn: Math.round(DEVICE_AUTHORIZATION_TTL_MS / 1_000),
      interval: DEVICE_AUTHORIZATION_POLL_INTERVAL_SECONDS,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
