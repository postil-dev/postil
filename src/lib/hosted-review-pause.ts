import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { checkRunExternalId } from "@/lib/github/checks";
import { HOSTED_REVIEW_UNAVAILABLE_MESSAGE } from "@/lib/review-outcome";

export interface HostedReviewPauseClaim {
  repositoryId: number;
  prNumber: number;
  authorGithubId: number | null;
  authorLogin: string | null;
  headSha: string;
  baseSha: string;
  sinceSha: string | null;
  queuedAt: Date;
  startedAt: Date;
}

/** Atomically record one paused managed review for a repository, PR, and head. */
export async function claimPausedHostedReview(
  db: Database,
  values: HostedReviewPauseClaim,
  publication: { installationId: number; repoFullName: string },
  finishedAt = new Date(),
): Promise<{
  id: number;
  publicId: string;
  advisoryCheckExternalId: string;
  gateCheckExternalId: string;
} | null> {
  return db.transaction(async (tx) => {
    const claimKey = `postil:unavailable-review:${values.repositoryId}:${values.prNumber}:${values.headSha}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claimKey}, 0))`);
    const existing = await tx
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.repositoryId, values.repositoryId),
          eq(schema.reviews.prNumber, values.prNumber),
          eq(schema.reviews.headSha, values.headSha),
          eq(schema.reviews.status, "failed"),
          eq(schema.reviews.errorMessage, HOSTED_REVIEW_UNAVAILABLE_MESSAGE),
        ),
      )
      .limit(1);
    if (existing.length > 0) return null;
    const inserted = await tx
      .insert(schema.reviews)
      .values({
        ...values,
        status: "failed",
        errorMessage: HOSTED_REVIEW_UNAVAILABLE_MESSAGE,
        finishedAt,
      })
      .returning({ id: schema.reviews.id, publicId: schema.reviews.publicId });
    const review = inserted[0];
    if (!review) throw new Error("paused review insert returned no row");
    const advisoryCheckExternalId = checkRunExternalId(review.publicId, "review");
    const gateCheckExternalId = checkRunExternalId(review.publicId, "gate");
    await tx.insert(schema.jobs).values({
      kind: "check-run-cleanup",
      payload: {
        installationId: publication.installationId,
        repoFullName: publication.repoFullName,
        advisoryCheckRunId: null,
        gateCheckRunId: null,
        headSha: values.headSha,
        advisoryCheckExternalId,
        gateCheckExternalId,
        advisoryCheckRunMayExist: true,
        gateCheckRunMayExist: true,
        message: HOSTED_REVIEW_UNAVAILABLE_MESSAGE,
        intent: "neutralize",
      },
      runAfter: new Date(finishedAt.getTime() + 30_000),
      maxAttempts: 5,
    });
    return { ...review, advisoryCheckExternalId, gateCheckExternalId };
  });
}
