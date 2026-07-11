import { desc, eq } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { computeEffectiveGate } from "@/lib/envelope";
import { getActiveApprovalIds, parseEnvelopeForApprovals } from "@/lib/finding-approvals";

export type OrgReviewStatus = "queued" | "running" | "completed" | "failed" | "stale";

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
      silent: schema.reviews.silent,
      gateFailing: schema.reviews.gateFailing,
      engineGateFailing: schema.reviews.engineGateFailing,
      envelope: schema.reviews.envelope,
      startedAt: schema.reviews.startedAt,
      finishedAt: schema.reviews.finishedAt,
      repoFullName: schema.repositories.fullName,
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

  // The table needs only the finding count and model name; keep the full
  // envelope (finding bodies, summaries) out of the RSC payload and the
  // polling responses.
  return Promise.all(
    rows.map(async ({ envelope: rawEnvelope, engineGateFailing, ...row }) => {
      const envelope = parseEnvelopeForApprovals(rawEnvelope);
      const approvalIds = await getActiveApprovalIds(db, row.id);
      return {
        ...row,
        gateFailing: envelope
          ? computeEffectiveGate(
              envelope,
              approvalIds,
              engineGateFailing ?? row.gateFailing ?? false,
            ).failing
          : row.gateFailing,
        findingsCount: envelope?.findings.length ?? null,
        modelUsed: envelope?.modelUsed ?? null,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
      };
    }),
  );
}
