import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { claimDeviceAuthorizationToken } from "@/lib/cli-auth";
import { resolveHostedGatewayDefaultModel } from "@/lib/cli-gateway";
import { getDb, schema } from "@/lib/db";
import { publicOrigin } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Poll a `postil login` device authorization for its outcome. No session required. */
export async function POST(request: Request): Promise<NextResponse> {
  const deviceCode = await readDeviceCode(request);
  if (!deviceCode) {
    return NextResponse.json({ status: "expired" }, { status: 410 });
  }

  const db = getDb();
  const result = await claimDeviceAuthorizationToken(db, deviceCode);

  if (result.status === "pending") {
    return NextResponse.json({ status: "pending" }, { status: 428 });
  }
  if (result.status === "denied") {
    return NextResponse.json({ status: "denied" }, { status: 403 });
  }
  if (result.status === "expired") {
    return NextResponse.json({ status: "expired" }, { status: 410 });
  }

  const org = (
    await db
      .select({ slug: schema.organizations.slug, name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, result.orgId))
      .limit(1)
  )[0];
  if (!org) {
    // The granting organization vanished between approval and claim (e.g. the
    // account was deleted). The token still exists, but there is nothing
    // usable to hand back.
    return NextResponse.json({ status: "expired" }, { status: 410 });
  }
  const model = await resolveHostedGatewayDefaultModel();

  return NextResponse.json(
    {
      status: "approved",
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      apiBase: new URL("/api/inference/v1", publicOrigin(request)).toString(),
      org: { slug: org.slug, name: org.name },
      model: model ?? "",
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

async function readDeviceCode(request: Request): Promise<string | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const deviceCode = (body as Record<string, unknown>).deviceCode;
  return typeof deviceCode === "string" && deviceCode.length > 0 ? deviceCode : null;
}
