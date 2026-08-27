import { NextResponse } from "next/server";

import { runCliGatewayChatCompletion } from "@/lib/cli-gateway";
import { getDb, getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OpenAI-compatible chat completions gateway that spends the caller's
 * organization's hosted-inference entitlement through Postil's own
 * credential. See `runCliGatewayChatCompletion` for the fail-closed check
 * ordering; this handler only wires the request into it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const result = await runCliGatewayChatCompletion(
    getDb(),
    getPool(),
    request.headers.get("authorization"),
    rawBody,
  );
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
