import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { getDb, schema, type Database } from "@/lib/db";
import {
  formatRemainingGateBlockers,
  getReviewApprovalState,
  lockReviewApprovalState,
  parseEnvelopeForApprovals,
  updateStoredEffectiveGate,
  type GateStateSyncJobPayload,
  type OrganizationGateStateSyncJobPayload,
  type ReviewForApproval,
  type ReviewGateStateSyncJobPayload,
} from "@/lib/finding-approvals";
import { lockOrganizationGateMode } from "@/lib/gate-mode";
import { getInstallationToken } from "@/lib/github/app-auth";
import { completeCheckRun, getPullRequestHeadSha } from "@/lib/github/checks";

interface DesiredGateState {
  review: ReviewForApproval;
  gateCheckRunId: number;
  enforced: boolean;
  failing: boolean;
  title: string;
  summary: string;
  generation: string;
}

export async function runGateStateSyncJob(
  payload: GateStateSyncJobPayload,
  options: { githubTimeoutMs?: number } = {},
): Promise<void> {
  if (isOrganizationPayload(payload)) {
    validateOrganizationPayload(payload);
    await runOrganizationGateStateSyncBatch(payload);
    return;
  }
  validateReviewPayload(payload);
  const db = getDb();
  const leaseId = randomUUID();
  if (!(await acquireGatePublisherLease(db, payload, leaseId))) return;
  try {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      if (!(await renewGatePublisherLease(db, payload.reviewId, leaseId))) return;
      const desired = await db.transaction((tx) => loadDesiredGateState(tx, payload));
      if (!desired) return;
      if (!(await renewGatePublisherLease(db, payload.reviewId, leaseId))) return;
      const signal = AbortSignal.timeout(options.githubTimeoutMs ?? 10_000);
      const token = await getInstallationToken(
        desired.review.githubInstallationId,
        signal,
      );
      const currentHeadSha = await getPullRequestHeadSha(
        token,
        desired.review.repoFullName,
        desired.review.prNumber,
        signal,
      );
      if (currentHeadSha !== desired.review.headSha) return;
      await completeCheckRun(
        token,
        desired.review.repoFullName,
        desired.gateCheckRunId,
        desired.enforced ? (desired.failing ? "failure" : "success") : "neutral",
        desired.title,
        desired.summary,
        signal,
      );
      if (!(await renewGatePublisherLease(db, payload.reviewId, leaseId))) return;
      const converged = await db.transaction(async (tx) => {
        const latest = await loadDesiredGateState(tx, payload);
        if (!latest) return true;
        if (latest.generation !== desired.generation) return false;
        await updateStoredEffectiveGate(
          tx,
          latest.review.id,
          latest.failing,
          latest.enforced,
        );
        return true;
      });
      if (converged) return;
    }
    throw new Error("gate state changed too frequently to publish a stable verdict");
  } catch (error) {
    if (isTerminalGithubAbsence(error)) return;
    throw error;
  } finally {
    await releaseGatePublisherLease(db, payload.reviewId, leaseId).catch(
      () => undefined,
    );
  }
}

function isOrganizationPayload(
  payload: GateStateSyncJobPayload,
): payload is OrganizationGateStateSyncJobPayload {
  return typeof payload.orgId === "number";
}

async function loadDesiredGateState(
  tx: Database,
  payload: ReviewGateStateSyncJobPayload,
): Promise<DesiredGateState | null> {
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
        repositoryEnabled: schema.repositories.enabled,
        orgId: schema.installations.orgId,
        installationSuspended: schema.installations.suspended,
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
  if (
    !row ||
    row.orgId === null ||
    (row.status !== "completed" && row.status !== "failed") ||
    !row.repositoryEnabled ||
    row.installationSuspended ||
    !row.gateCheckRunId
  ) return null;

  const latest = (
    await tx
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.repositoryId, row.repositoryId),
          eq(schema.reviews.prNumber, row.prNumber),
          sql`${schema.reviews.status} IN ('completed', 'failed')`,
          sql`${schema.reviews.gateCheckRunId} IS NOT NULL`,
        ),
      )
      .orderBy(sql`${schema.reviews.queuedAt} DESC`, sql`${schema.reviews.id} DESC`)
      .limit(1)
  )[0];
  if (latest?.id !== row.id) return null;

  const enforced = await lockOrganizationGateMode(tx, row.orgId);
  const envelope = parseEnvelopeForApprovals(row.envelope);
  if (row.status === "completed" && !envelope) {
    throw new Error("gate state sync review is incomplete");
  }
  const review: ReviewForApproval = { ...row, envelope };
  const failing = row.status === "failed"
    ? true
    : (await getReviewApprovalState(tx, review)).effectiveGate.failing;
  const title = enforced
    ? row.status === "failed"
      ? "Review unavailable"
      : failing
        ? "Postil gate still failing"
        : "Postil gate approved"
    : "Postil gate is advisory";
  const summary = !enforced
    ? row.status === "failed"
      ? "Merge blocking is disabled. The incomplete review remains advisory."
      : "Merge blocking is disabled. Review findings remain advisory."
    : row.status === "failed"
      ? "Postil could not complete this review. Open the Postil run for details."
      : failing
        ? `One or more blocking findings remain.\n\n${formatRemainingGateBlockers(
            (await getReviewApprovalState(tx, review)).effectiveGate,
          )}`
        : "An organization admin approved every eligible human judgment finding for this commit.";
  const generation = JSON.stringify({
    status: row.status,
    gateCheckRunId: row.gateCheckRunId,
    enforced,
    failing,
    title,
    summary,
    headSha: row.headSha,
  });
  return {
    review,
    gateCheckRunId: row.gateCheckRunId,
    enforced,
    failing,
    title,
    summary,
    generation,
  };
}

async function runOrganizationGateStateSyncBatch(
  payload: OrganizationGateStateSyncJobPayload,
): Promise<void> {
  const db = getDb();
  const cursorDate = payload.cursor ? new Date(payload.cursor.queuedAt) : null;
  const result = await db.execute(sql<{
    reviewId: string;
    reviewPublicId: string;
    queuedAt: Date;
  }>`
    WITH ranked AS (
      SELECT ${schema.reviews.id} AS "reviewId",
             ${schema.reviews.publicId}::text AS "reviewPublicId",
             ${schema.reviews.queuedAt} AS "queuedAt",
             row_number() OVER (
               PARTITION BY ${schema.reviews.repositoryId}, ${schema.reviews.prNumber}
               ORDER BY ${schema.reviews.queuedAt} DESC, ${schema.reviews.id} DESC
             ) AS latest_rank
      FROM ${schema.reviews}
      INNER JOIN ${schema.repositories}
        ON ${schema.repositories.id} = ${schema.reviews.repositoryId}
      INNER JOIN ${schema.installations}
        ON ${schema.installations.id} = ${schema.repositories.installationId}
      WHERE ${schema.installations.orgId} = ${payload.orgId}
        AND ${schema.reviews.status} IN ('completed', 'failed')
        AND ${schema.reviews.gateCheckRunId} IS NOT NULL
        AND ${schema.repositories.enabled} = true
        AND ${schema.installations.suspended} = false
    )
    SELECT "reviewId"::text, "reviewPublicId", "queuedAt"
    FROM ranked
    WHERE latest_rank = 1
      AND ${cursorDate && payload.cursor ? sql`
        ("queuedAt", "reviewId") < (${cursorDate}, ${payload.cursor.reviewId})
      ` : sql`TRUE`}
    ORDER BY "queuedAt" DESC, "reviewId" DESC
    LIMIT 51
  `);
  const rows = result.rows as unknown as Array<{
    reviewId: string;
    reviewPublicId: string;
    queuedAt: Date;
  }>;
  const page = rows.slice(0, 50);
  if (page.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.insert(schema.jobs).values(
      page.map((row) => ({
        kind: "gate-state-sync",
        payload: {
          reviewId: Number(row.reviewId),
          reviewPublicId: row.reviewPublicId,
          modeVersion: payload.modeVersion,
        } satisfies ReviewGateStateSyncJobPayload,
        maxAttempts: 5,
      })),
    );
    if (rows.length > 50) {
      const last = page[page.length - 1]!;
      await tx.insert(schema.jobs).values({
        kind: "gate-state-sync",
        payload: {
          orgId: payload.orgId,
          modeVersion: payload.modeVersion,
          cursor: {
            queuedAt: last.queuedAt.toISOString(),
            reviewId: Number(last.reviewId),
          },
        } satisfies OrganizationGateStateSyncJobPayload,
        maxAttempts: 5,
      });
    }
  });
}

async function acquireGatePublisherLease(
  db: Database,
  payload: ReviewGateStateSyncJobPayload,
  leaseId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.reviews)
    .set({
      gateSyncLeaseId: leaseId,
      gateSyncLeaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
    })
    .where(
      and(
        eq(schema.reviews.id, payload.reviewId),
        eq(schema.reviews.publicId, payload.reviewPublicId),
        sql`(${schema.reviews.gateSyncLeaseId} IS NULL OR ${schema.reviews.gateSyncLeaseExpiresAt} < clock_timestamp())`,
      ),
    )
    .returning({ id: schema.reviews.id });
  return rows.length === 1;
}

async function renewGatePublisherLease(
  db: Database,
  reviewId: number,
  leaseId: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.reviews)
    .set({ gateSyncLeaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'` })
    .where(
      and(
        eq(schema.reviews.id, reviewId),
        eq(schema.reviews.gateSyncLeaseId, leaseId),
      ),
    )
    .returning({ id: schema.reviews.id });
  return rows.length === 1;
}

async function releaseGatePublisherLease(
  db: Database,
  reviewId: number,
  leaseId: string,
): Promise<void> {
  await db
    .update(schema.reviews)
    .set({ gateSyncLeaseId: null, gateSyncLeaseExpiresAt: null })
    .where(
      and(
        eq(schema.reviews.id, reviewId),
        eq(schema.reviews.gateSyncLeaseId, leaseId),
      ),
    );
}

function validateReviewPayload(payload: ReviewGateStateSyncJobPayload): void {
  if (
    !Number.isSafeInteger(payload.reviewId) ||
    payload.reviewId <= 0 ||
    typeof payload.reviewPublicId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.reviewPublicId,
    )
  ) throw new Error("gate state sync job payload is malformed");
}

function validateOrganizationPayload(
  payload: OrganizationGateStateSyncJobPayload,
): void {
  if (
    !Number.isSafeInteger(payload.orgId) ||
    payload.orgId <= 0 ||
    !Number.isSafeInteger(payload.modeVersion) ||
    payload.modeVersion <= 0 ||
    (payload.cursor !== undefined &&
      (!Number.isFinite(Date.parse(payload.cursor.queuedAt)) ||
        !Number.isSafeInteger(payload.cursor.reviewId) ||
        payload.cursor.reviewId <= 0))
  ) throw new Error("gate state sync job payload is malformed");
}

function isTerminalGithubAbsence(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (404|410)(?:\s|$)/.test(message);
}
