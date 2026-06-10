/**
 * Dispatch: webhook handler → review row + check-run + queued job.
 *
 * Idempotent on (repo, pr, sha): replaying a delivery never produces a second
 * review row or a second check-run for the same head SHA.
 */

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { reviews } from "@/db/schema";
import { sealToken } from "./crypto";
import { createCheckRun, mintInstallationToken } from "./github-app";
import { enqueue, type ReviewJobPayload } from "./jobs";

const DEFAULT_CHECK_NAME = "postil/review";

export async function dispatchReview(input: {
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  installationId: number;
  checkName?: string;
}) {
  const checkName = input.checkName ?? DEFAULT_CHECK_NAME;

  // Insert the review row, idempotent on (repo, pr, sha).
  const reviewId = randomUUID();
  const inserted = await db
    .insert(reviews)
    .values({
      id: reviewId,
      repoFullName: input.repoFullName,
      pullNumber: input.pullNumber,
      headSha: input.headSha,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [reviews.repoFullName, reviews.pullNumber, reviews.headSha],
    })
    .returning({ id: reviews.id });

  if (inserted.length === 0) {
    // Already exists — fetch its id, and if it's pending we will still attempt
    // to create the check-run + enqueue.
    const existing = await db
      .select({ id: reviews.id, status: reviews.status, checkRunId: reviews.checkRunId })
      .from(reviews)
      .where(
        and(
          eq(reviews.repoFullName, input.repoFullName),
          eq(reviews.pullNumber, input.pullNumber),
          eq(reviews.headSha, input.headSha),
        ),
      )
      .limit(1);
    if (existing[0]?.status !== "pending") {
      return { reviewId: existing[0]?.id, alreadyHandled: true as const };
    }
  }

  const finalReviewId = inserted[0]?.id ?? reviewId;

  // Pre-create the check-run so the PR shows `in_progress` immediately.
  let checkRunId: number;
  try {
    checkRunId = await createCheckRun(
      input.installationId,
      input.repoFullName,
      input.headSha,
      checkName,
    );
  } catch (e) {
    await db
      .update(reviews)
      .set({ status: "failed", errorMessage: `check-run create failed: ${String(e)}` })
      .where(eq(reviews.id, finalReviewId));
    throw e;
  }

  // Mint a short-lived installation token and encrypt it for the worker.
  const { token, expiresAt } = await mintInstallationToken(input.installationId);
  const encryptedToken = await sealToken(token);

  const payload: ReviewJobPayload = {
    reviewId: finalReviewId,
    repoFullName: input.repoFullName,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    installationId: input.installationId,
    encryptedToken,
    tokenExpiresAt: expiresAt,
    checkRunId,
    checkName,
  };
  const jobId = `review:${finalReviewId}`;
  await enqueue(db, jobId, "review", payload as unknown as Record<string, unknown>);

  await db
    .update(reviews)
    .set({ checkRunId, jobId, status: "pending" })
    .where(eq(reviews.id, finalReviewId));

  return { reviewId: finalReviewId, jobId, checkRunId, alreadyHandled: false as const };
}
