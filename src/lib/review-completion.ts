import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  computeEffectiveGate,
  envelopeSchema,
  isEnvelopeOperationallyUnavailable,
  type Envelope,
} from "@/lib/envelope";
import type { ReviewConfigProvenance } from "@/lib/github/contents";
import { lockReviewDecisionScopeById } from "@/lib/finding-approvals";
import { lockOrganizationGateMode } from "@/lib/gate-mode";
import {
  COALESCED_REVIEW_PAYLOAD_KEY,
  type CheckRunCleanupJobPayload,
  type JobLease,
  type ReviewJobPayload,
} from "@/lib/queue";
import {
  persistPublicationReceipt,
  type PublicationReceipt,
} from "@/lib/publication-receipt";

export const OPERATIONAL_NO_VERDICT_MESSAGE =
  "Review execution did not produce a reviewer verdict.";

export interface ReviewCompletionAccountingInput {
  reviewId: number;
  usage: Array<{
    orgId: number | null;
    repositoryId: number;
    promptTokens: number;
    completionTokens: number;
    modelUsed: string;
    costMicros: number | null;
    billingScope: "analytics" | "private_hosted";
  }>;
  hostedUsageReservationId?: string | null;
  usageAccountingComplete: boolean;
  terminalStatus?: "completed" | "failed";
  errorMessage?: string | null;
}

export interface ReviewCompletionInput extends ReviewCompletionAccountingInput {
  envelope: Envelope;
  configFiles: string[];
  configProvenance?: ReviewConfigProvenance;
  silent: boolean;
  gateFailing: boolean;
  publicationReceipt?: PublicationReceipt;
}

export interface ReviewCompletionWithGateModeResult {
  completed: boolean;
  gateEnabled: boolean;
  gateFailing: boolean;
  superseded?: boolean;
  promoted?: boolean;
}

export interface StaleReviewCleanupIdentity extends CheckRunCleanupJobPayload {
  reviewId: number;
  headSha: string;
  advisoryCheckExternalId: string;
  gateCheckExternalId: string;
  intent: "neutralize";
}

export interface StagedReviewFinalizationInput
  extends ReviewCompletionAccountingInput {
  reviewJobLease: JobLease;
  expectedReviewInput: ReviewJobPayload;
  staleCleanup: StaleReviewCleanupIdentity;
}

export interface StagedReviewCompletionInput extends Pick<
  ReviewCompletionInput,
  | "reviewId"
  | "envelope"
  | "configFiles"
  | "configProvenance"
  | "silent"
  | "gateFailing"
  | "publicationReceipt"
> {
  reviewJobLease: JobLease;
  deferPublicationReceipt?: false;
}

export interface ControllerStagedReviewCompletionInput extends Omit<
  StagedReviewCompletionInput,
  "publicationReceipt" | "deferPublicationReceipt"
> {
  publicationReceipt?: never;
  deferPublicationReceipt: true;
}

class ReviewCompletionJobLeaseLostError extends Error {
  constructor(
    readonly gateEnabled: boolean,
    readonly gateFailing: boolean,
  ) {
    super("review completion lost its exact job lease");
    this.name = "ReviewCompletionJobLeaseLostError";
  }
}

function exactReviewInputMatches(
  current: ReviewJobPayload,
  expected: ReviewJobPayload,
): boolean {
  return current.installationId === expected.installationId &&
    current.sourceInstallationId === expected.sourceInstallationId &&
    current.sourceOrgId === expected.sourceOrgId &&
    current.githubRepoId === expected.githubRepoId &&
    current.repoFullName === expected.repoFullName &&
    current.prNumber === expected.prNumber &&
    current.headSha === expected.headSha &&
    current.baseSha === expected.baseSha &&
    current.expectedPullRequestUpdatedAt ===
      expected.expectedPullRequestUpdatedAt &&
    current.reviewInputSequence === expected.reviewInputSequence &&
    current.sourceDeliveryId === expected.sourceDeliveryId;
}

function promotedReviewInput(
  parent: ReviewJobPayload,
  pending: ReviewJobPayload,
  parentJobId: number,
): ReviewJobPayload {
  const {
    [COALESCED_REVIEW_PAYLOAD_KEY]: _nestedPending,
    recoveryReviewId: _recoveryReviewId,
    privateWorkerRehearsalNonce: _privateWorkerRehearsalNonce,
    privateWorkerRehearsalLockedBy: _privateWorkerRehearsalLockedBy,
    privateWorkerRehearsalLockGeneration: _privateWorkerRehearsalLockGeneration,
    ...ordinary
  } = pending as ReviewJobPayload & Record<string, unknown>;
  const lineage = [pending.providerRetryLineage, parent.providerRetryLineage]
    .find((value) => typeof value === "string" && value.length > 0 && value.length <= 200) ??
    `review-job:${parentJobId}`;
  return { ...ordinary, providerRetryLineage: lineage } as ReviewJobPayload;
}

async function markReviewStaleWithDurableCleanupInTransaction(
  db: Database,
  input: StaleReviewCleanupIdentity,
): Promise<boolean> {
  const locked = await db
    .select({ status: schema.reviews.status })
    .from(schema.reviews)
    .where(eq(schema.reviews.id, input.reviewId))
    .for("update")
    .limit(1);
  const status = locked[0]?.status;
  if (status !== "queued" && status !== "running" && status !== "stale") {
    return false;
  }
  if (status !== "stale") {
    await db
      .update(schema.reviews)
      .set({
        status: "stale",
        errorMessage: input.message,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(schema.reviews.id, input.reviewId),
          inArray(schema.reviews.status, ["queued", "running"]),
        ),
      );
  }
  await db.execute(sql`
    INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
    SELECT 'check-run-cleanup', ${JSON.stringify(input)}::jsonb,
           'queued', clock_timestamp(), 5
    WHERE NOT EXISTS (
      SELECT 1
        FROM jobs
       WHERE kind = 'check-run-cleanup'
         AND status IN ('queued', 'running', 'done')
         AND payload->>'reviewId' = ${String(input.reviewId)}
         AND payload->>'headSha' = ${input.headSha}
         AND payload->>'advisoryCheckExternalId' = ${input.advisoryCheckExternalId}
         AND payload->>'gateCheckExternalId' = ${input.gateCheckExternalId}
         AND payload->>'intent' = 'neutralize'
    )
  `);
  return true;
}

export async function markReviewStaleWithDurableCleanup(
  db: Database,
  input: StaleReviewCleanupIdentity,
): Promise<boolean> {
  return db.transaction((tx) =>
    markReviewStaleWithDurableCleanupInTransaction(tx as Database, input)
  );
}

function requireEnvelopeGateTruth(
  envelopeValue: unknown,
  claimedGateFailing?: boolean | null,
): { envelope: Envelope; gateFailing: boolean } {
  const parsed = envelopeSchema.safeParse(envelopeValue);
  if (!parsed.success) {
    throw new Error("review completion envelope is invalid");
  }
  const gateFailing = computeEffectiveGate(parsed.data, new Set()).failing;
  if (
    claimedGateFailing !== undefined &&
    claimedGateFailing !== null &&
    claimedGateFailing !== gateFailing
  ) {
    throw new Error("review completion gate truth does not match its envelope");
  }
  return { envelope: parsed.data, gateFailing };
}

function terminalReviewState(
  input: Pick<ReviewCompletionAccountingInput, "terminalStatus" | "errorMessage">,
  envelope: Envelope,
): { status: "completed" | "failed"; errorMessage: string | null } {
  const operationalNoVerdict = isEnvelopeOperationallyUnavailable(envelope);
  const status = operationalNoVerdict
    ? "failed"
    : input.terminalStatus ?? "completed";
  if (status === "completed") return { status, errorMessage: null };
  const errorMessage =
    input.errorMessage?.trim() ||
    (operationalNoVerdict ? OPERATIONAL_NO_VERDICT_MESSAGE : "");
  if (!errorMessage) {
    throw new Error("failed review completion requires an error message");
  }
  return { status, errorMessage };
}

async function persistReviewCompletionAccounting(
  db: Database,
  input: ReviewCompletionAccountingInput,
  review: { publicId: string; triggerSource: string },
  options: { enqueueGateStateSync?: boolean } = {},
): Promise<void> {
  const persistedUsageRows = input.usage.map((usage) => ({
    ...usage,
    reviewId: input.reviewId,
    triggerSource: review.triggerSource,
  }));
  if (input.hostedUsageReservationId) {
    const reservation = (
      await db
        .select({ reservedMicros: schema.hostedUsageReservations.reservedMicros })
        .from(schema.hostedUsageReservations)
        .where(eq(schema.hostedUsageReservations.id, input.hostedUsageReservationId))
        .limit(1)
    )[0];
    if (!reservation) throw new Error("hosted usage reservation not found");
    const priced = input.usage.every((usage) => usage.costMicros !== null);
    const knownMicros = input.usage.reduce(
      (total, usage) => total + (usage.costMicros ?? 0),
      0,
    );
    // A private hosted event must never retain NULL cost: reservation
    // accounting interprets any NULL as an unknown full-period spend. Keep
    // the model/token analytics at zero and charge uncertainty explicitly.
    for (const usage of persistedUsageRows) {
      if (usage.billingScope === "private_hosted" && usage.costMicros === null) {
        usage.costMicros = 0;
      }
    }
    const actualMicros = input.usageAccountingComplete && priced
      ? knownMicros
      : Math.max(reservation.reservedMicros, knownMicros);
    const unattributedMicros = actualMicros - knownMicros;
    if (unattributedMicros > 0) {
      const first = input.usage[0];
      if (!first) throw new Error("hosted review usage is empty");
      persistedUsageRows.push({
        ...first,
        promptTokens: 0,
        completionTokens: 0,
        modelUsed: "unattributed provider usage",
        costMicros: unattributedMicros,
        reviewId: input.reviewId,
        triggerSource: review.triggerSource,
      });
    }
    const reconciled = await db
      .update(schema.hostedUsageReservations)
      .set({ status: "reconciled", actualMicros, updatedAt: new Date() })
      .where(
        and(
          eq(schema.hostedUsageReservations.id, input.hostedUsageReservationId),
          inArray(schema.hostedUsageReservations.status, ["active", "released"]),
        ),
      )
      .returning({ id: schema.hostedUsageReservations.id });
    if (reconciled.length !== 1) {
      throw new Error("hosted usage reservation is not active");
    }
  }
  if (persistedUsageRows.length > 0) {
    await db.insert(schema.usageEvents).values(persistedUsageRows);
  }
  if (options.enqueueGateStateSync !== false) {
    await db.insert(schema.jobs).values({
      kind: "gate-state-sync",
      payload: {
        reviewId: input.reviewId,
        reviewPublicId: review.publicId,
      },
      maxAttempts: 5,
    });
  }
}

/** Persist receipt-backed usage without scheduling publication for a failed review. */
export async function persistFailedStagedReviewAccounting(
  db: Database,
  input: ReviewCompletionAccountingInput,
  review: { publicId: string; triggerSource: string },
): Promise<void> {
  await persistReviewCompletionAccounting(db, input, review, {
    enqueueGateStateSync: false,
  });
}

/**
 * Commit the CLI result and immutable publication receipt before any
 * post-publication GitHub reads. The owning review job receives the recovery
 * pointer in the same transaction, so a worker restart resumes verification
 * instead of running the model or posting the review again.
 */
export async function stageReviewCompletionCandidate(
  db: Database,
  input: StagedReviewCompletionInput,
  orgId: number | null,
): Promise<ReviewCompletionWithGateModeResult & { staged: boolean }> {
  if ((input as { deferPublicationReceipt?: boolean }).deferPublicationReceipt === true) {
    throw new Error(
      "publication receipt deferral requires atomic controller staging",
    );
  }
  try {
    return await db.transaction((tx) =>
      stageReviewCompletionCandidateInTransaction(
        tx as Database,
        input,
        orgId,
      )
    );
  } catch (error) {
    if (error instanceof ReviewCompletionJobLeaseLostError) {
      return {
        staged: false,
        completed: false,
        gateEnabled: error.gateEnabled,
        gateFailing: error.gateFailing,
      };
    }
    throw error;
  }
}

/** Stage one review completion candidate inside an existing transaction. */
export async function stageReviewCompletionCandidateInTransaction(
  tx: Database,
  input: StagedReviewCompletionInput | ControllerStagedReviewCompletionInput,
  orgId: number | null,
): Promise<ReviewCompletionWithGateModeResult & { staged: boolean }> {
  await lockReviewDecisionScopeById(tx, input.reviewId);
  const gateTruth = requireEnvelopeGateTruth(
    input.envelope,
    input.gateFailing,
  );
  const gateEnabled =
    orgId === null ? false : await lockOrganizationGateMode(tx, orgId);
  const effectiveGateFailing = gateEnabled && gateTruth.gateFailing;
  const rows = await tx
    .update(schema.reviews)
    .set({
      envelope: gateTruth.envelope,
      configFiles: input.configFiles,
      configProvenance: input.configProvenance ?? {
        entries: [],
        degraded: false,
      },
      silent: input.silent,
      engineGateFailing: gateTruth.gateFailing,
      gateFailing: effectiveGateFailing,
    })
    .where(
      and(
        eq(schema.reviews.id, input.reviewId),
        eq(schema.reviews.status, "running"),
      ),
    )
    .returning({ id: schema.reviews.id });
  if (rows.length === 0) {
    return {
      staged: false,
      completed: false,
      gateEnabled,
      gateFailing: effectiveGateFailing,
    };
  }

  if (input.deferPublicationReceipt === true) {
    if (input.publicationReceipt !== undefined) {
      throw new Error("deferred publication staging cannot include a receipt");
    }
  } else {
    await persistPublicationReceipt(tx, {
      reviewId: input.reviewId,
      envelope: gateTruth.envelope,
      receipt: input.publicationReceipt,
    });
  }
  const recoveryPointer = await tx
    .update(schema.jobs)
    .set({
      payload: sql`${schema.jobs.payload} || jsonb_build_object(
        'recoveryReviewId', ${input.reviewId}::bigint
      )`,
    })
    .where(
      and(
        eq(schema.jobs.id, input.reviewJobLease.id),
        eq(schema.jobs.status, "running"),
        eq(schema.jobs.lockedBy, input.reviewJobLease.lockedBy),
        eq(schema.jobs.lockGeneration, input.reviewJobLease.lockGeneration),
      ),
    )
    .returning({ id: schema.jobs.id });
  if (recoveryPointer.length !== 1) {
    throw new ReviewCompletionJobLeaseLostError(
      gateEnabled,
      effectiveGateFailing,
    );
  }

  return {
    staged: true,
    completed: false,
    gateEnabled,
    gateFailing: effectiveGateFailing,
  };
}

/** Finalize an already-staged review without repeating any GitHub write. */
export async function finalizeStagedReviewCompletionWithGateMode(
  db: Database,
  input: StagedReviewFinalizationInput,
  orgId: number | null,
): Promise<ReviewCompletionWithGateModeResult> {
  return db.transaction(async (tx) => {
    await lockReviewDecisionScopeById(tx, input.reviewId);
    const gateEnabled =
      orgId === null ? false : await lockOrganizationGateMode(tx, orgId);
    const jobResult = await tx.execute(sql<{
      payload: ReviewJobPayload;
      maxAttempts: number;
    }>`
      SELECT ${schema.jobs.payload} AS payload,
             ${schema.jobs.maxAttempts} AS "maxAttempts"
        FROM ${schema.jobs}
       WHERE ${schema.jobs.id} = ${input.reviewJobLease.id}
         AND ${schema.jobs.kind} = 'review'
         AND ${schema.jobs.status} = 'running'
         AND ${schema.jobs.lockedBy} = ${input.reviewJobLease.lockedBy}
         AND ${schema.jobs.lockGeneration} = ${input.reviewJobLease.lockGeneration}
       FOR UPDATE
    `);
    const jobRow = jobResult.rows[0] as
      | { payload: ReviewJobPayload; maxAttempts: number }
      | undefined;
    const currentPayload = jobRow?.payload;
    if (!currentPayload || !jobRow) {
      return { completed: false, gateEnabled, gateFailing: false };
    }
    const pending = (
      currentPayload as ReviewJobPayload & Record<string, unknown>
    )[COALESCED_REVIEW_PAYLOAD_KEY];
    const pendingInput = pending && typeof pending === "object" && !Array.isArray(pending)
      ? pending as ReviewJobPayload
      : null;
    const currentInputIsExact = exactReviewInputMatches(
      currentPayload,
      input.expectedReviewInput,
    );
    const successorInput = pendingInput ??
      (currentInputIsExact ? null : currentPayload);
    if (
      successorInput !== null
    ) {
      await markReviewStaleWithDurableCleanupInTransaction(
        tx as Database,
        input.staleCleanup,
      );
      const retired = await tx
        .update(schema.jobs)
        .set({
          status: "failed",
          lockedAt: null,
          lockedBy: null,
          lastError: "superseded before staged review completion",
          runAfter: new Date(),
        })
        .where(
          and(
            eq(schema.jobs.id, input.reviewJobLease.id),
            eq(schema.jobs.status, "running"),
            eq(schema.jobs.lockedBy, input.reviewJobLease.lockedBy),
            eq(schema.jobs.lockGeneration, input.reviewJobLease.lockGeneration),
          ),
        )
        .returning({ id: schema.jobs.id });
      if (retired.length !== 1) {
        return { completed: false, gateEnabled, gateFailing: false };
      }
      if (successorInput) {
        await tx.insert(schema.jobs).values({
          kind: "review",
          payload: promotedReviewInput(
            currentPayload,
            successorInput,
            input.reviewJobLease.id,
          ),
          status: "queued",
          runAfter: new Date(),
          maxAttempts: jobRow.maxAttempts,
        });
      }
      return {
        completed: false,
        gateEnabled,
        gateFailing: false,
        superseded: true,
        promoted: successorInput !== null,
      };
    }
    const staged = (
      await tx
        .select({
          envelope: schema.reviews.envelope,
          engineGateFailing: schema.reviews.engineGateFailing,
        })
        .from(schema.reviews)
        .where(
          and(
            eq(schema.reviews.id, input.reviewId),
            eq(schema.reviews.status, "running"),
            isNotNull(schema.reviews.envelope),
          ),
        )
        .limit(1)
    )[0];
    if (!staged) {
      return { completed: false, gateEnabled, gateFailing: false };
    }
    const gateTruth = requireEnvelopeGateTruth(
      staged.envelope,
      staged.engineGateFailing,
    );
    const terminal = terminalReviewState(input, gateTruth.envelope);
    const effectiveGateFailing =
      gateEnabled && (terminal.status === "failed" || gateTruth.gateFailing);

    const rows = await tx
      .update(schema.reviews)
      .set({
        status: terminal.status,
        gateFailing: effectiveGateFailing,
        errorMessage: terminal.errorMessage,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(schema.reviews.id, input.reviewId),
          eq(schema.reviews.status, "running"),
          isNotNull(schema.reviews.envelope),
        ),
      )
      .returning({
        id: schema.reviews.id,
        publicId: schema.reviews.publicId,
        triggerSource: schema.reviews.triggerSource,
      });
    if (rows.length === 0) {
      return { completed: false, gateEnabled, gateFailing: effectiveGateFailing };
    }

    await persistReviewCompletionAccounting(tx as Database, input, rows[0]!);
    return { completed: true, gateEnabled, gateFailing: effectiveGateFailing };
  });
}

/** Persist the terminal review, effective gate state, and accounting atomically. */
export async function persistReviewCompletionWithGateMode(
  db: Database,
  input: ReviewCompletionInput,
  orgId: number | null,
): Promise<ReviewCompletionWithGateModeResult> {
  return db.transaction(async (tx) => {
    await lockReviewDecisionScopeById(tx, input.reviewId);
    const gateTruth = requireEnvelopeGateTruth(
      input.envelope,
      input.gateFailing,
    );
    const gateEnabled =
      orgId === null ? false : await lockOrganizationGateMode(tx, orgId);
    const terminal = terminalReviewState(input, gateTruth.envelope);
    const effectiveGateFailing =
      gateEnabled && (terminal.status === "failed" || gateTruth.gateFailing);
    const rows = await tx
      .update(schema.reviews)
      .set({
        status: terminal.status,
        envelope: gateTruth.envelope,
        configFiles: input.configFiles,
        configProvenance: input.configProvenance ?? {
          entries: [],
          degraded: false,
        },
        silent: input.silent,
        engineGateFailing: gateTruth.gateFailing,
        gateFailing: effectiveGateFailing,
        errorMessage: terminal.errorMessage,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(schema.reviews.id, input.reviewId),
          eq(schema.reviews.status, "running"),
        ),
      )
      .returning({
        id: schema.reviews.id,
        publicId: schema.reviews.publicId,
        triggerSource: schema.reviews.triggerSource,
      });
    if (rows.length === 0) {
      return { completed: false, gateEnabled, gateFailing: effectiveGateFailing };
    }

    await persistPublicationReceipt(tx as Database, {
      reviewId: input.reviewId,
      envelope: gateTruth.envelope,
      receipt: input.publicationReceipt,
    });

    await persistReviewCompletionAccounting(tx as Database, input, rows[0]!);
    return { completed: true, gateEnabled, gateFailing: effectiveGateFailing };
  });
}
