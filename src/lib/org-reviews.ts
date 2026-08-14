import { desc, eq } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { computeEffectiveGate } from "@/lib/envelope";
import { getActiveApprovalIds, getActiveDismissalIds, parseEnvelopeForApprovals } from "@/lib/finding-approvals";
import {
  reviewDisplayStatus,
  type ReviewDisplayStatus,
} from "@/lib/review-outcome";
import type { ReviewTriggerSource } from "@/lib/review-trigger";
import {
  getReviewPublicationCounts,
} from "@/lib/publication-receipt";

export type OrgReviewStatus = ReviewDisplayStatus;

export interface OrgReviewRow {
  id: number;
  publicId: string;
  prNumber: number;
  status: OrgReviewStatus;
  silent: boolean | null;
  gateFailing: boolean | null;
  findingsCount: number | null;
  modelUsed: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  repoFullName: string;
  triggerSource: ReviewTriggerSource;
}

/**
 * Return the organization review rows shared by the dashboard and its polling
 * endpoint. Dates are normalized so the initial RSC payload and JSON refreshes
 * have the same client-facing shape.
 */
export async function getOrgReviewRows(
  db: Database,
  orgId: number,
  limit: number,
): Promise<OrgReviewRow[]> {
  const rows = await db
    .select({
      id: schema.reviews.id,
      publicId: schema.reviews.publicId,
      prNumber: schema.reviews.prNumber,
      status: schema.reviews.status,
      errorMessage: schema.reviews.errorMessage,
      silent: schema.reviews.silent,
      gateFailing: schema.reviews.gateFailing,
      envelope: schema.reviews.envelope,
      startedAt: schema.reviews.startedAt,
      finishedAt: schema.reviews.finishedAt,
      repoFullName: schema.repositories.fullName,
      triggerSource: schema.reviews.triggerSource,
    })
    .from(schema.reviews)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .where(eq(schema.installations.orgId, orgId))
    .orderBy(desc(schema.reviews.queuedAt))
    .limit(limit);

  const publicationCounts = await getReviewPublicationCounts(
    db,
    rows.map((row) => row.id),
  );

  // The table needs only the finding count and model name; keep the full
  // envelope (finding bodies, summaries) out of the RSC payload and the
  // polling responses.
  return Promise.all(
    rows.map(async ({ envelope: rawEnvelope, errorMessage, ...row }) => {
      const envelope = parseEnvelopeForApprovals(rawEnvelope);
      const approvalIds = await getActiveApprovalIds(db, row.id);
      const dismissalIds = await getActiveDismissalIds(db, row.id);
      const counts = publicationCounts.get(row.id) ?? null;
      const activePublished = counts
        ? counts.inline +
          counts.checkAnnotation +
          counts.summaryOnly +
          counts.carried +
          counts.inlineRejected
        : null;
      return {
        ...row,
        status: reviewDisplayStatus(row.status, errorMessage),
        triggerSource: row.triggerSource as ReviewTriggerSource,
        gateFailing:
          row.status === "failed"
            ? row.gateFailing
            : envelope
              ? computeEffectiveGate(envelope, approvalIds, dismissalIds).failing
              : row.gateFailing,
        findingsCount: counts && counts.unknown === 0 ? activePublished : null,
        modelUsed: envelope?.modelUsed ?? null,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
      };
    }),
  );
}
