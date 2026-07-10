import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight session probe for the client-side header: lets static
 * marketing pages show the right auth affordance without making every page
 * dynamic. Returns only the login, never session or profile internals.
 */
export async function GET(): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({ authenticated: true, login: user.login });
}
