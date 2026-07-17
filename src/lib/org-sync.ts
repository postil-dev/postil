import { and, eq, inArray, notInArray } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

type OrgMembershipDatabase = Pick<Database, "delete" | "insert" | "select">;

/**
 * One GitHub account (an org or the user's personal account) the signed-in
 * user currently belongs to, paired with the role they should hold.
 */
export interface GithubAccountMembership {
  githubOrgId: number;
  role: string;
}

/**
 * Reconcile a user's org_members rows against the set of GitHub accounts they
 * currently belong to.
 *
 * org_members is the single source of truth for dashboard read and write
 * access. The `role` column authorizes organization-wide write actions, while
 * read access requires a row. Sign-in and periodic session verification source
 * every row from GitHub and reconcile in both directions:
 *
 *   - insert/keep a membership (with its current role) for every GitHub
 *     account the user still has, and
 *   - delete memberships for orgs the user no longer belongs to.
 *
 * Deletions are scoped to this user only; other users' rows are never touched.
 * Memberships in orgs the user still belongs to are preserved (we only delete
 * rows whose org is NOT in the current set).
 */
export async function reconcileOrgMemberships(
  db: OrgMembershipDatabase,
  userId: number,
  accounts: GithubAccountMembership[],
): Promise<void> {
  // Resolve the GitHub account ids onto organizations we actually know about.
  // Accounts with no matching organization row simply contribute nothing.
  const byGithubId = new Map(accounts.map((a) => [a.githubOrgId, a.role]));
  const githubOrgIds = [...byGithubId.keys()];

  const knownOrgs =
    githubOrgIds.length === 0
      ? []
      : await db
          .select({ id: schema.organizations.id, githubOrgId: schema.organizations.githubOrgId })
          .from(schema.organizations)
          .where(inArray(schema.organizations.githubOrgId, githubOrgIds));

  const currentOrgIds = knownOrgs.map((o) => o.id);

  // Insert missing memberships and apply the current GitHub role to existing
  // rows. Organization-wide writes authorize on org_members.role.
  for (const org of knownOrgs) {
    if (org.githubOrgId === null) continue;
    const role = byGithubId.get(org.githubOrgId) ?? "member";
    await db
      .insert(schema.orgMembers)
      .values({ orgId: org.id, userId, role })
      .onConflictDoUpdate({
        target: [schema.orgMembers.orgId, schema.orgMembers.userId],
        set: { role },
      });
  }

  // Revoke memberships for orgs the user no longer belongs to. Scoped to this
  // user; only rows whose org is NOT in the current set are removed, so an org
  // the user still belongs to is never affected.
  if (currentOrgIds.length === 0) {
    await db.delete(schema.orgMembers).where(eq(schema.orgMembers.userId, userId));
  } else {
    await db
      .delete(schema.orgMembers)
      .where(
        and(
          eq(schema.orgMembers.userId, userId),
          notInArray(schema.orgMembers.orgId, currentOrgIds),
        ),
      );
  }
}
