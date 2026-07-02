import { and, eq, inArray, notInArray } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

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
 * access (see orgs/[slug]/page.tsx and orgs/[slug]/actions.ts), and every row
 * is sourced from GitHub membership at login — nothing else inserts into the
 * table. Login previously only ever INSERTed, so a user removed from a GitHub
 * org kept dashboard access until their (up to 30-day) session expired. This
 * reconciles in both directions:
 *
 *   - insert/keep a membership for every GitHub account the user still has, and
 *   - delete memberships for orgs the user no longer belongs to.
 *
 * Deletions are scoped to this user only; other users' rows are never touched.
 * Memberships in orgs the user still belongs to are preserved (we only delete
 * rows whose org is NOT in the current set).
 */
export async function reconcileOrgMemberships(
  db: Database,
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

  // Insert any memberships the user is missing for orgs they currently belong
  // to, and update the role on ones that already exist: nothing else
  // authorizes on org_members.role today, but this is the only writer of the
  // table and "reconcile in both directions" means a GitHub-side demotion
  // must land here too, not just new/removed memberships.
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
