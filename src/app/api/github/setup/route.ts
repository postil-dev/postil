import { NextResponse } from "next/server";

import { publicOrigin } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub includes an installation_id after installation, but documents that
 * the value can be spoofed. Ignore every incoming parameter and start Postil's
 * independently state-protected sign-in flow, which reconciles only accounts
 * available to the authenticated GitHub user.
 */
export function GET(request: Request): NextResponse {
  return NextResponse.redirect(new URL("/api/auth/login", publicOrigin(request)), 303);
}
