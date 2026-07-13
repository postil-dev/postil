import { NextResponse } from "next/server";

import { verifyBillingContactToken } from "@/lib/billing-contact-verification";
import { getDb } from "@/lib/db";
import {
  isSameOriginVerificationPost,
  verificationConfirmationPage,
  verificationFormValues,
} from "@/lib/email-verification-route";
import { publicOrigin } from "@/lib/oauth";

export async function GET(request: Request): Promise<NextResponse> {
  return verificationConfirmationPage(request, {
    action: "/verify/billing-contact",
    heading: "Confirm billing email",
    description: "Confirm that Postil may send billing notices to this address.",
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginVerificationPost(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const values = await verificationFormValues(request);
  const result = values
    ? await verifyBillingContactToken(getDb(), values.orgId, values.token)
    : { verified: false, slug: null };
  const destination = result.slug
    ? `/orgs/${encodeURIComponent(result.slug)}/billing?contactVerification=${result.verified ? "success" : "invalid"}`
    : "/";
  return NextResponse.redirect(new URL(destination, publicOrigin(request)), 303);
}
