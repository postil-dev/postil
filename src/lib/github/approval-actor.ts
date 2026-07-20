import { and, eq } from "drizzle-orm";

import { getDb, schema, type Database } from "@/lib/db";
import type { ApprovalActor } from "@/lib/finding-approvals";
import { apiBase } from "@/lib/github/app-auth";

interface ApprovalReviewAccount {
  orgId: number | null;
}

interface ApprovalGithubUser {
  id?: number;
  login?: string;
}

interface GithubMembershipResponse {
  state?: string;
  role?: string;
  user?: { id?: number; login?: string };
  organization?: { id?: number; login?: string };
}

/** Resolve an approval actor from current GitHub ownership or organization membership. */
export async function loadLiveApprovalActor(
  review: ApprovalReviewAccount,
  user: ApprovalGithubUser | undefined,
  repoFullName: string,
  installationToken: string,
): Promise<ApprovalActor | null> {
  if (!user?.id || !user.login || review.orgId == null || !installationToken) return null;
  const db = getDb();
  const organization = (
    await db
      .select({
        githubId: schema.organizations.githubOrgId,
      })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, review.orgId))
      .limit(1)
  )[0];
  const ownerLogin = repoFullName.split("/")[0];
  if (!organization?.githubId || !ownerLogin) {
    return null;
  }

  // A user-account installation has one owner whose stable GitHub id is the
  // installed account id. No organization membership endpoint applies.
  if (organization.githubId === user.id) {
    return persistApprovalActor(db, review.orgId, user.id, user.login, "admin");
  }

  let response: Response;
  try {
    response = await fetch(
      `${apiBase()}/orgs/${encodeURIComponent(ownerLogin)}/memberships/${encodeURIComponent(user.login)}`,
      {
        headers: {
          Authorization: `Bearer ${installationToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "postil-control-plane",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return null;
  }

  if (response.status === 404) {
    await removeCachedMembership(db, review.orgId, user.id);
    return null;
  }
  if (!response.ok) return null;

  let membership: GithubMembershipResponse;
  try {
    membership = (await response.json()) as GithubMembershipResponse;
  } catch {
    return null;
  }
  const role = membership.role;
  if (
    membership.state !== "active" ||
    (role !== "admin" && role !== "member") ||
    membership.user?.id !== user.id ||
    membership.user.login?.toLowerCase() !== user.login.toLowerCase() ||
    membership.organization?.id !== organization.githubId ||
    membership.organization.login?.toLowerCase() !== ownerLogin.toLowerCase()
  ) {
    return null;
  }

  return persistApprovalActor(db, review.orgId, user.id, user.login, role);
}

async function persistApprovalActor(
  db: Database,
  orgId: number,
  githubId: number,
  login: string,
  role: "member" | "admin",
): Promise<ApprovalActor> {
  return db.transaction(async (tx) => {
    const row = (
      await tx
        .insert(schema.users)
        .values({ githubId, login })
        .onConflictDoUpdate({
          target: schema.users.githubId,
          set: { login },
        })
        .returning({ id: schema.users.id })
    )[0];
    if (!row) throw new Error("approval actor could not be persisted");
    await tx
      .insert(schema.orgMembers)
      .values({ orgId, userId: row.id, role })
      .onConflictDoUpdate({
        target: [schema.orgMembers.orgId, schema.orgMembers.userId],
        set: { role },
      });
    return approvalActor(row.id, githubId, login, role);
  });
}

async function removeCachedMembership(
  db: Database,
  orgId: number,
  githubId: number,
): Promise<void> {
  const row = (
    await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.githubId, githubId))
      .limit(1)
  )[0];
  if (!row) return;
  await db
    .delete(schema.orgMembers)
    .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, row.id)));
}

function approvalActor(
  userId: number,
  githubId: number,
  login: string,
  role: "member" | "admin",
): ApprovalActor {
  return { userId, githubId: String(githubId), login, role };
}
