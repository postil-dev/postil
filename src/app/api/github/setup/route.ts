import { NextResponse } from "next/server";

import {
  GITHUB_SETUP_INSTALLATION_COOKIE,
  publicOrigin,
} from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub redirects here after an installation is created or updated. The
 * installation_id query parameter is attacker-controlled, so it is never used
 * as authorization. A fresh user OAuth flow reconciles the accounts and
 * installations GitHub says the user can administer, then resolves the
 * accessible installed account or falls back to the account index.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const origin = publicOrigin(request);
  const installationId = url.searchParams.get("installation_id");
  const numericInstallationId = Number(installationId);
  if (
    !installationId ||
    !/^[1-9]\d*$/.test(installationId) ||
    !Number.isSafeInteger(numericInstallationId)
  ) {
    return NextResponse.redirect(new URL("/install?error=github_setup", origin), 303);
  }
  const response = NextResponse.redirect(new URL("/api/auth/login", origin), 303);
  // GitHub supplies this value, but callers can forge the setup URL. The OAuth
  // callback uses it only after joining the installation to the authenticated
  // user's refreshed organization memberships.
  response.cookies.set(GITHUB_SETUP_INSTALLATION_COOKIE, installationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
  });
  return response;
}
