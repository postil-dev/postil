import { NextResponse } from "next/server";

import { verifyBillingContactToken } from "@/lib/billing-contact-verification";
import { getDb } from "@/lib/db";
import { publicOrigin } from "@/lib/oauth";

export async function GET(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const orgId = Number(requestUrl.searchParams.get("org"));
  const token = requestUrl.searchParams.get("token") ?? "";
  const result = Number.isSafeInteger(orgId) && orgId > 0
    ? await verifyBillingContactToken(getDb(), orgId, token)
    : { verified: false, slug: null };
  const destination = result.slug
    ? `/orgs/${encodeURIComponent(result.slug)}/billing?contactVerification=${result.verified ? "success" : "invalid"}`
    : "/";
  return NextResponse.redirect(new URL(destination, publicOrigin(request)));
}
