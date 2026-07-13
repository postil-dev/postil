import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";
import {
  isSameOriginVerificationPost,
  verificationConfirmationPage,
  verificationFormValues,
} from "@/lib/email-verification-route";
import { verifyEscalationEmailToken } from "@/lib/escalation-email-verification";
import { publicOrigin } from "@/lib/oauth";

export async function GET(request: Request): Promise<NextResponse> {
  return verificationConfirmationPage(request, {
    action: "/verify/escalation-email",
    heading: "Confirm notification email",
    description: "Confirm that Postil may send human escalation notifications to this address.",
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginVerificationPost(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const values = await verificationFormValues(request);
  const result = values
    ? await verifyEscalationEmailToken(getDb(), values.orgId, values.token)
    : { verified: false, slug: null };

  const destination = result.slug
    ? `/orgs/${encodeURIComponent(result.slug)}/settings?emailVerification=${result.verified ? "success" : "invalid"}`
    : "/";
  return NextResponse.redirect(new URL(destination, publicOrigin(request)), 303);
}
