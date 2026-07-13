import { and, eq } from "drizzle-orm";

import { getDb, schema } from "@/lib/db";
import {
  formatRemainingGateBlockers,
  getReviewApprovalState,
  hasNewerCompletedReviewForHead,
  lockReviewApprovalState,
  parseEnvelopeForApprovals,
  updateStoredEffectiveGate,
  type GateStateSyncJobPayload,
  type ReviewForApproval,
} from "@/lib/finding-approvals";
import { getInstallationToken } from "@/lib/github/app-auth";
import { completeCheckRun, getPullRequestHeadSha } from "@/lib/github/checks";

export async function runGateStateSyncJob(
  payload: GateStateSyncJobPayload,
  options: { githubTimeoutMs?: number } = {},
): Promise<void> {
  validatePayload(payload);
  const db = getDb();
  await db.transaction(async (tx) => {
    // Multiple web drains and workers may claim sync jobs for the same review.
    // Recompute under one transaction-scoped lock so an older job can never
    // publish stale gate state after a newer approval or revocation.
    await lockReviewApprovalState(tx, payload.reviewId);
    const row = (
      await tx
        .select({
          id: schema.reviews.id,
          publicId: schema.reviews.publicId,
          repositoryId: schema.reviews.repositoryId,
          prNumber: schema.reviews.prNumber,
          headSha: schema.reviews.headSha,
          status: schema.reviews.status,
          envelope: schema.reviews.envelope,
          engineGateFailing: schema.reviews.engineGateFailing,
          gateFailing: schema.reviews.gateFailing,
          gateCheckRunId: schema.reviews.gateCheckRunId,
          repoFullName: schema.repositories.fullName,
          orgId: schema.installations.orgId,
          githubInstallationId: schema.installations.githubInstallationId,
        })
        .from(schema.reviews)
        .innerJoin(
          schema.repositories,
          eq(schema.repositories.id, schema.reviews.repositoryId),
        )
        .innerJoin(
          schema.installations,
          eq(schema.installations.id, schema.repositories.installationId),
        )
        .where(
          and(
            eq(schema.reviews.id, payload.reviewId),
            eq(schema.reviews.publicId, payload.reviewPublicId),
          ),
        )
        .limit(1)
    )[0];
    if (!row || row.status !== "completed") return;
    const envelope = parseEnvelopeForApprovals(row.envelope);
    const gateCheckRunId = row.gateCheckRunId;
    if (!envelope || !gateCheckRunId) {
      throw new Error("gate state sync review is incomplete");
    }
    const review: ReviewForApproval = { ...row, envelope };
    const signal = AbortSignal.timeout(options.githubTimeoutMs ?? 10_000);
    const token = await getInstallationToken(review.githubInstallationId, signal);
    const currentHeadSha = await getPullRequestHeadSha(
      token,
      review.repoFullName,
      review.prNumber,
      signal,
    );
    if (currentHeadSha !== review.headSha) return;
    if (await hasNewerCompletedReviewForHead(tx, review)) return;

    const state = await getReviewApprovalState(tx, review);
    const failing = state.effectiveGate.failing;
    await updateStoredEffectiveGate(tx, review.id, failing);
    await completeCheckRun(
      token,
      review.repoFullName,
      gateCheckRunId,
      failing ? "failure" : "success",
      failing ? "Postil gate still failing" : "Postil gate approved",
      failing
        ? `One or more blocking findings remain after this decision.\n\n${formatRemainingGateBlockers(state.effectiveGate)}`
        : "An organization admin approved every eligible human judgment finding for this reviewed commit.",
      signal,
    );
  });
}

function validatePayload(payload: GateStateSyncJobPayload): void {
  if (
    !Number.isSafeInteger(payload.reviewId) ||
    payload.reviewId <= 0 ||
    typeof payload.reviewPublicId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.reviewPublicId,
    )
  ) {
    throw new Error("gate state sync job payload is malformed");
  }
}
