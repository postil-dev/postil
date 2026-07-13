import { NextResponse } from "next/server";

import { publicOrigin } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub redirects here after an installation is created or updated. The
 * installation_id query parameter is attacker-controlled, so it is never used
 * as authorization. A fresh user OAuth flow reconciles the accounts and
 * installations GitHub says the user can administer, then lands on reports.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const origin = publicOrigin(request);
  if (!url.searchParams.has("installation_id")) {
    return NextResponse.redirect(new URL("/install?error=github_setup", origin), 303);
  }
  return NextResponse.redirect(new URL("/api/auth/login", origin), 303);
}
