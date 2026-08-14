import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { getDb, schema } from "@/lib/db";
import {
  getVerifiedSessionUser,
  handlePageSessionFailure,
  type SessionUser,
} from "@/lib/session";

export type OrgAccessResult =
  | {
      ok: true;
      db: ReturnType<typeof getDb>;
      user: SessionUser;
      org: typeof schema.organizations.$inferSelect;
      membership: { id: number; role: string };
    }
  | {
      ok: false;
      reason: "unauthenticated" | "not_found";
    }
  | {
      ok: false;
      reason: "verification_unavailable";
      retryAvailableAt: Date;
    };

/** Resolve organization access without invoking Next.js page control flow. */
export async function getOrgMembership(slug: string): Promise<OrgAccessResult> {
  const verification = await getVerifiedSessionUser();
  if (!verification.ok) return verification;
  const user = verification.user;

  const db = getDb();
  const org = (
    await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1)
  )[0];
  if (!org) return { ok: false, reason: "not_found" };

  const membership = (
    await db
      .select({ id: schema.orgMembers.id, role: schema.orgMembers.role })
      .from(schema.orgMembers)
      .where(and(eq(schema.orgMembers.orgId, org.id), eq(schema.orgMembers.userId, user.id)))
      .limit(1)
  )[0];
  if (!membership) return { ok: false, reason: "not_found" };

  return { ok: true, db, user, org, membership };
}

/**
 * Require an authenticated member of the organization identified by `slug`.
 * Missing organizations and non-members both return 404 so organization
 * existence is not disclosed across accounts.
 */
export async function requireOrgMembership(slug: string) {
  const access = await getOrgMembership(slug);
  if (!access.ok) {
    if (
      access.reason === "unauthenticated" ||
      access.reason === "verification_unavailable"
    ) {
      await handlePageSessionFailure(
        access.reason,
        access.reason === "verification_unavailable"
          ? access.retryAvailableAt
          : undefined,
      );
    }
    notFound();
  }
  return access;
}
