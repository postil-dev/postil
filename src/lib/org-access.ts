import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { getDb, schema } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

/**
 * Require an authenticated member of the organization identified by `slug`.
 * Missing organizations and non-members both return 404 so organization
 * existence is not disclosed across accounts.
 */
export async function requireOrgMembership(slug: string) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const db = getDb();
  const org = (
    await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1)
  )[0];
  if (!org) notFound();

  const membership = (
    await db
      .select({ id: schema.orgMembers.id, role: schema.orgMembers.role })
      .from(schema.orgMembers)
      .where(and(eq(schema.orgMembers.orgId, org.id), eq(schema.orgMembers.userId, user.id)))
      .limit(1)
  )[0];
  if (!membership) notFound();

  return { db, org, membership };
}
