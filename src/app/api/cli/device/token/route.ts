import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { claimDeviceAuthorizationToken, readCliJsonBody } from "@/lib/cli-auth";
import { resolveHostedGatewayDefaultModel } from "@/lib/cli-gateway";
import { getDb, schema } from "@/lib/db";
import { publicOrigin } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Poll a `postil login` device authorization for its outcome. No session required. */
export async function POST(request: Request): Promise<NextResponse> {
  const parsed = await readDeviceCode(request);
  if (!parsed.ok) {
    return NextResponse.json(
      { status: "invalid_request" },
      { status: parsed.status },
    );
  }
  if (!parsed.deviceCode) {
    return NextResponse.json({ status: "expired" }, { status: 410 });
  }

  const db = getDb();
  const issuer = publicOrigin(request);
  const result = await claimDeviceAuthorizationToken(
    db,
    parsed.deviceCode,
    issuer,
  );

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
      .select({
        slug: schema.organizations.slug,
        name: schema.organizations.name,
      })
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
      refreshToken: result.refreshToken,
      refreshExpiresAt: result.refreshExpiresAt.toISOString(),
      apiBase: new URL("/api/inference/v1", issuer).toString(),
      org: { slug: org.slug, name: org.name },
      model: model ?? "",
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

async function readDeviceCode(
  request: Request,
): Promise<
  { ok: true; deviceCode: string | null } | { ok: false; status: 400 | 413 }
> {
  const parsed = await readCliJsonBody(request);
  if (!parsed.ok) return parsed;
  const { body } = parsed;
  if (typeof body !== "object" || body === null) {
    return { ok: true, deviceCode: null };
  }
  const deviceCode = (body as Record<string, unknown>).deviceCode;
  return {
    ok: true,
    deviceCode:
      typeof deviceCode === "string" && deviceCode.length > 0
        ? deviceCode
        : null,
  };
}
