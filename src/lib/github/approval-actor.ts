import { and, desc, eq, gt, isNotNull } from "drizzle-orm";

import { getSealingKey, unseal } from "@/lib/crypto/seal";
import { getDb, schema } from "@/lib/db";
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
}

/** Resolve an approval actor from current GitHub ownership or organization membership. */
export async function loadLiveApprovalActor(
  review: ApprovalReviewAccount,
  user: ApprovalGithubUser | undefined,
  repoFullName: string,
): Promise<ApprovalActor | null> {
  if (!user?.id || !user.login || review.orgId == null) return null;
  const db = getDb();
  const row = (
    await db
      .select({
        userId: schema.users.id,
        githubId: schema.users.githubId,
        orgGithubId: schema.organizations.githubOrgId,
      })
      .from(schema.users)
      .innerJoin(schema.orgMembers, eq(schema.orgMembers.userId, schema.users.id))
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgMembers.orgId))
      .where(and(eq(schema.users.githubId, user.id), eq(schema.orgMembers.orgId, review.orgId)))
      .limit(1)
  )[0];
  if (!row) return null;

  if (row.orgGithubId === row.githubId) {
    return approvalActor(row.userId, row.githubId, user.login, "admin");
  }

  const session = (
    await db
      .select({
        id: schema.sessions.id,
        accessTokenCiphertext: schema.sessions.githubAccessTokenCiphertext,
      })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.userId, row.userId),
          gt(schema.sessions.expiresAt, new Date()),
          isNotNull(schema.sessions.githubAccessTokenCiphertext),
        ),
      )
      .orderBy(desc(schema.sessions.createdAt))
      .limit(1)
  )[0];
  if (!session?.accessTokenCiphertext) return null;

  let accessToken: string;
  try {
    accessToken = unseal(session.accessTokenCiphertext, getSealingKey());
  } catch {
    return null;
  }

  const orgLogin = repoFullName.split("/")[0];
  if (!orgLogin) return null;
  let response: Response;
  try {
    response = await fetch(
      `${apiBase()}/user/memberships/orgs/${encodeURIComponent(orgLogin)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
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

  if (response.status === 401) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, session.id));
    return null;
  }
  if (response.status === 404) {
    await db
      .delete(schema.orgMembers)
      .where(
        and(
          eq(schema.orgMembers.orgId, review.orgId),
          eq(schema.orgMembers.userId, row.userId),
        ),
      );
    return null;
  }
  if (!response.ok) return null;

  let membership: GithubMembershipResponse;
  try {
    membership = (await response.json()) as GithubMembershipResponse;
  } catch {
    return null;
  }
  if (membership.state !== "active") return null;
  const role = membership.role === "admin" ? "admin" : "member";
  await db
    .update(schema.orgMembers)
    .set({ role })
    .where(
      and(
        eq(schema.orgMembers.orgId, review.orgId),
        eq(schema.orgMembers.userId, row.userId),
      ),
    );
  return approvalActor(row.userId, row.githubId, user.login, role);
}

function approvalActor(
  userId: number,
  githubId: number,
  login: string,
  role: "member" | "admin",
): ApprovalActor {
  return { userId, githubId: String(githubId), login, role };
}
