import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";
import { verifyEscalationEmailToken } from "@/lib/escalation-email-verification";
import { publicOrigin } from "@/lib/oauth";

export async function GET(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const orgId = Number(requestUrl.searchParams.get("org"));
  const token = requestUrl.searchParams.get("token") ?? "";
  const result = Number.isSafeInteger(orgId) && orgId > 0
    ? await verifyEscalationEmailToken(getDb(), orgId, token)
    : { verified: false, slug: null };

  const destination = result.slug
    ? `/orgs/${encodeURIComponent(result.slug)}/settings?emailVerification=${result.verified ? "success" : "invalid"}`
    : "/";
  return NextResponse.redirect(new URL(destination, publicOrigin(request)));
}
