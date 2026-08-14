import { NextResponse } from "next/server";

import { and, eq } from "drizzle-orm";

import { getDb, schema } from "@/lib/db";
import { membershipRetryAfterHeader } from "@/lib/auth-navigation";
import { getVerifiedSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight session probe for the client-side header: lets static
 * marketing pages show the right auth affordance without making every page
 * dynamic. Returns only the login, dashboard route, and whether an install CTA
 * is useful, never session or profile internals.
 */
export async function GET(): Promise<NextResponse> {
  const verification = await getVerifiedSessionUser();
  if (!verification.ok) {
    return NextResponse.json(
      {
        authenticated: false,
        ...(verification.reason === "verification_unavailable"
          ? { reason: "membership_verification_unavailable" }
          : {}),
      },
      {
        status: verification.reason === "unauthenticated" ? 401 : 503,
        headers:
          verification.reason === "verification_unavailable"
            ? {
                "retry-after": membershipRetryAfterHeader(
                  verification.retryAvailableAt,
                ),
              }
            : undefined,
      },
    );
  }
  const user = verification.user;

  const db = getDb();
  const memberships = await db
    .select({ slug: schema.organizations.slug })
    .from(schema.orgMembers)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.orgMembers.orgId),
    )
    .where(eq(schema.orgMembers.userId, user.id))
    .limit(2);

  const activeInstallation = (
    await db
      .select({ id: schema.installations.id })
      .from(schema.installations)
      .innerJoin(
        schema.orgMembers,
        eq(schema.orgMembers.orgId, schema.installations.orgId),
      )
      .where(
        and(
          eq(schema.orgMembers.userId, user.id),
          eq(schema.installations.suspended, false),
        ),
      )
      .limit(1)
  )[0];

  const onlyMembership = memberships.length === 1 ? memberships[0] : undefined;
  const dashboardHref = onlyMembership
    ? `/orgs/${encodeURIComponent(onlyMembership.slug)}`
    : "/reports";

  return NextResponse.json({
    authenticated: true,
    login: user.login,
    dashboardHref,
    hasActiveInstallation: Boolean(activeInstallation),
  });
}
