import { NextResponse } from "next/server";

import { verifyBillingContactToken } from "@/lib/billing-contact-verification";
import { getDb } from "@/lib/db";
import {
  verificationConfirmationPage,
  verificationFormValues,
  verificationResultPage,
} from "@/lib/email-verification-route";
import { publicOrigin } from "@/lib/oauth";

export async function GET(request: Request): Promise<NextResponse> {
  const result = new URL(request.url).searchParams.get("result");
  if (result === "processed") {
    return verificationResultPage();
  }
  return verificationConfirmationPage(request, {
    action: "/verify/billing-contact",
    heading: "Confirm billing email",
    description: "Confirm that Postil may send billing notices to this address.",
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  // The sealed, expiring, one-time token is the authority for this public
  // action. It is bound to the organization and normalized email, so browser
  // session cookies and optional Origin/Referer headers are neither required
  // nor trusted as a substitute.
  const values = await verificationFormValues(request);
  if (values) {
    await verifyBillingContactToken(getDb(), values.orgId, values.token);
  }
  const destination = "/verify/billing-contact?result=processed";
  return NextResponse.redirect(new URL(destination, publicOrigin(request)), 303);
}
