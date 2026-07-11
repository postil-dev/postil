import { NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { getDb, schema } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight session probe for the client-side header: lets static
 * marketing pages show the right auth affordance without making every page
 * dynamic. Returns only the login and dashboard route, never session or
 * profile internals.
 */
export async function GET(): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const memberships = await getDb()
    .select({ slug: schema.organizations.slug })
    .from(schema.orgMembers)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.orgMembers.orgId),
    )
    .where(eq(schema.orgMembers.userId, user.id))
    .limit(2);

  const onlyMembership = memberships.length === 1 ? memberships[0] : undefined;
  const dashboardHref = onlyMembership
    ? `/orgs/${encodeURIComponent(onlyMembership.slug)}`
    : "/reports";

  return NextResponse.json({
    authenticated: true,
    login: user.login,
    dashboardHref,
  });
}
