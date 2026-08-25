import { eq } from "drizzle-orm";

import { getDb, schema, type Database } from "@/lib/db";
import type { ApprovalActor } from "@/lib/finding-approvals";
import { apiBase } from "@/lib/github/app-auth";

interface ApprovalReviewAccount {
  orgId: number;
  installationAccountType: string;
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

export type LiveAdminVerification =
  | { outcome: "authorized" }
  | { outcome: "denied" }
  | { outcome: "unavailable" };

/**
 * Verify present GitHub administrator authority without writing local users
 * or membership rows. Feedback observation is authorization-only work.
 */
export async function verifyLiveGithubAdmin(
  review: ApprovalReviewAccount,
  user: ApprovalGithubUser | undefined,
  repoFullName: string,
  installationToken: string,
  signal?: AbortSignal,
): Promise<LiveAdminVerification> {
  if (
    !user?.id ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    !user.login ||
    !isGithubLogin(user.login) ||
    review.orgId == null ||
    !installationToken
  ) return { outcome: "unavailable" };

  let organization: { githubId: number | null } | undefined;
  try {
    organization = (
      await getDb()
        .select({ githubId: schema.organizations.githubOrgId })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, review.orgId))
        .limit(1)
    )[0];
  } catch {
    return { outcome: "unavailable" };
  }
  const repoParts = repoFullName.split("/");
  const ownerLogin = repoParts.length === 2 ? repoParts[0] : undefined;
  if (
    !organization?.githubId ||
    !Number.isSafeInteger(organization.githubId) ||
    organization.githubId <= 0 ||
    !ownerLogin ||
    !isGithubLogin(ownerLogin) ||
    !repoParts[1]
  ) return { outcome: "unavailable" };

  if (review.installationAccountType === "User") {
    return organization.githubId === user.id &&
      ownerLogin.toLowerCase() === user.login.toLowerCase()
      ? { outcome: "authorized" }
      : { outcome: "denied" };
  }
  if (review.installationAccountType !== "Organization") return { outcome: "unavailable" };

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
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return { outcome: "unavailable" };
  }
  if (response.status === 404) return { outcome: "denied" };
  if (!response.ok) return { outcome: "unavailable" };

  let membership: GithubMembershipResponse;
  try {
    membership = (await response.json()) as GithubMembershipResponse;
  } catch {
    return { outcome: "unavailable" };
  }
  if (
    membership.user?.id !== user.id ||
    membership.user.login?.toLowerCase() !== user.login.toLowerCase() ||
    membership.organization?.id !== organization.githubId ||
    membership.organization.login?.toLowerCase() !== ownerLogin.toLowerCase()
  ) return { outcome: "unavailable" };
  if (membership.state !== "active" || membership.role !== "admin") {
    return { outcome: "denied" };
  }
  return { outcome: "authorized" };
}

/** Resolve an approval actor from current GitHub ownership or organization membership. */
export async function loadLiveApprovalActor(
  review: ApprovalReviewAccount,
  user: ApprovalGithubUser | undefined,
  repoFullName: string,
  installationToken: string,
): Promise<ApprovalActor | null> {
  if (
    !user?.id ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    !user.login ||
    !isGithubLogin(user.login) ||
    review.orgId == null ||
    !installationToken
  ) return null;
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
  const repoParts = repoFullName.split("/");
  const ownerLogin = repoParts.length === 2 ? repoParts[0] : undefined;
  if (
    !organization?.githubId ||
    !Number.isSafeInteger(organization.githubId) ||
    organization.githubId <= 0 ||
    !ownerLogin ||
    !isGithubLogin(ownerLogin) ||
    !repoParts[1]
  ) {
    return null;
  }

  // A user-account installation has one owner whose stable GitHub id is the
  // installed account id. No organization membership endpoint applies.
  if (
    review.installationAccountType === "User" &&
    organization.githubId === user.id &&
    ownerLogin.toLowerCase() === user.login.toLowerCase()
  ) {
    const actorUserId = await upsertApprovalActorIdentity(
      db,
      user.id,
      user.login,
    );
    return actorUserId === undefined
      ? null
      : approvalActor(actorUserId, user.id, user.login, "admin");
  }
  if (review.installationAccountType !== "Organization") return null;

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

  if (response.status === 404) return null;
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
  const actorUserId = await upsertApprovalActorIdentity(
    db,
    user.id,
    user.login,
  );
  return actorUserId === undefined
    ? null
    : approvalActor(actorUserId, user.id, user.login, role);
}

async function upsertApprovalActorIdentity(
  db: Database,
  githubId: number,
  login: string,
): Promise<number | undefined> {
  const actorUser = (
    await db
      .insert(schema.users)
      .values({ githubId, login })
      .onConflictDoUpdate({
        target: schema.users.githubId,
        set: { login },
      })
      .returning({ id: schema.users.id })
  )[0];
  return actorUser?.id;
}

function approvalActor(
  userId: number,
  githubId: number,
  login: string,
  role: "member" | "admin",
): ApprovalActor {
  return { userId, githubId: String(githubId), login, role };
}

function isGithubLogin(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);
}
