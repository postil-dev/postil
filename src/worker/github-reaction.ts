import { and, eq } from "drizzle-orm";

import { getDb, getPool, schema } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { addCommentReaction } from "@/lib/github/checks";
import { fetchRepositorySummary } from "@/lib/github/installation-sync";
import {
  externalSideEffectLeaseActive,
  type ExternalSideEffectLease,
  type GithubReactionJobPayload,
} from "@/lib/queue";

/** Deliver a durable, prose-free reaction for one admitted request. */
export async function runGithubReactionJob(
  payload: GithubReactionJobPayload,
  lease: ExternalSideEffectLease,
): Promise<void> {
  if (
    !Number.isSafeInteger(payload.installationId) ||
    !Number.isSafeInteger(payload.sourceInstallationId) ||
    !Number.isSafeInteger(payload.sourceOrgId) ||
    !Number.isSafeInteger(payload.githubRepoId) ||
    !Number.isSafeInteger(payload.commentId) ||
    payload.installationId <= 0 ||
    payload.sourceInstallationId <= 0 ||
    payload.sourceOrgId <= 0 ||
    payload.githubRepoId <= 0 ||
    payload.commentId <= 0 ||
    typeof payload.repoFullName !== "string" ||
    payload.repoFullName.trim() === "" ||
    !["issue_comment", "pull_request_review_comment"].includes(payload.commentKind) ||
    !["+1", "eyes"].includes(payload.content) ||
    typeof payload.sourceDeliveryId !== "string" ||
    payload.sourceDeliveryId.trim() === ""
  ) {
    throw new Error("github reaction job payload is malformed");
  }

  const db = getDb();
  const authority = (
    await db
      .select({
        installationId: schema.installations.id,
        orgId: schema.installations.orgId,
        suspended: schema.installations.suspended,
        githubRepoId: schema.repositories.githubRepoId,
        repoFullName: schema.repositories.fullName,
        enabled: schema.repositories.enabled,
      })
      .from(schema.installations)
      .innerJoin(
        schema.repositories,
        eq(schema.repositories.installationId, schema.installations.id),
      )
      .where(
        and(
          eq(schema.installations.githubInstallationId, payload.installationId),
          eq(schema.repositories.githubRepoId, payload.githubRepoId),
        ),
      )
      .limit(1)
  )[0];
  if (
    !authority ||
    authority.suspended ||
    !authority.enabled ||
    authority.installationId !== payload.sourceInstallationId ||
    authority.orgId !== payload.sourceOrgId ||
    authority.githubRepoId !== payload.githubRepoId ||
    authority.repoFullName !== payload.repoFullName
  ) {
    console.warn(`github reaction skipped: authority changed for ${payload.repoFullName}`);
    return;
  }

  const token = await getInstallationToken(payload.installationId);
  let repository: Awaited<ReturnType<typeof fetchRepositorySummary>>;
  try {
    repository = await fetchRepositorySummary(token, payload.repoFullName);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "GitHubHttpError" &&
      Reflect.get(error, "status") === 404
    ) return;
    throw error;
  }
  if (
    repository.id !== payload.githubRepoId ||
    repository.full_name !== payload.repoFullName
  ) {
    console.warn(`github reaction skipped: repository identity changed for ${payload.repoFullName}`);
    return;
  }
  if (!(await externalSideEffectLeaseActive(getPool(), lease))) return;

  await addCommentReaction(
    token,
    payload.repoFullName,
    payload.commentId,
    payload.commentKind,
    payload.content,
  );
}
