import { NextResponse } from "next/server";

import { bearerCliToken, resolveCliToken, revokeCliToken } from "@/lib/cli-auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revoke the caller's CLI token. Idempotent: always 204 once the token is unusable. */
export async function POST(request: Request): Promise<NextResponse> {
  const token = bearerCliToken(request.headers.get("authorization"));
  if (!token) {
    return NextResponse.json(
      { error: { message: "postil login required", type: "invalid_token" } },
      { status: 401 },
    );
  }

  const db = getDb();
  const resolved = await resolveCliToken(db, token);
  // An unresolvable token (unknown, expired, already revoked) is already
  // logged out from the server's perspective, so this still reports success.
  if (resolved) await revokeCliToken(db, resolved.id);

  return new NextResponse(null, { status: 204 });
}
