import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  computeEffectiveGate,
  envelopeSchema,
  type Envelope,
} from "@/lib/envelope";
import type { ReviewConfigProvenance } from "@/lib/github/contents";
import { lockReviewDecisionScopeById } from "@/lib/finding-approvals";
import { lockOrganizationGateMode } from "@/lib/gate-mode";
import {
  persistPublicationReceipt,
  type PublicationReceipt,
} from "@/lib/publication-receipt";

interface ReviewCompletionAccountingInput {
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
  queueGateStateSync?: boolean;
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
  reviewJobId?: number;
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

async function persistReviewCompletionAccounting(
  db: Database,
  input: ReviewCompletionAccountingInput,
  review: { publicId: string; triggerSource: string },
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
          eq(schema.hostedUsageReservations.status, "active"),
        ),
      )
      .returning({ id: schema.hostedUsageReservations.id });
    if (reconciled.length !== 1) {
      throw new Error("hosted usage reservation is not active");
    }
  }
  await db.insert(schema.usageEvents).values(persistedUsageRows);
  if (input.queueGateStateSync !== false) {
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
  return db.transaction(async (tx) => {
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

    await persistPublicationReceipt(tx as Database, {
      reviewId: input.reviewId,
      envelope: gateTruth.envelope,
      receipt: input.publicationReceipt,
    });
    if (input.reviewJobId !== undefined) {
      await tx
        .update(schema.jobs)
        .set({
          payload: sql`${schema.jobs.payload} || jsonb_build_object(
            'recoveryReviewId', ${input.reviewId}::bigint
          )`,
        })
        .where(eq(schema.jobs.id, input.reviewJobId));
    }

    return {
      staged: true,
      completed: false,
      gateEnabled,
      gateFailing: effectiveGateFailing,
    };
  });
}

/** Finalize an already-staged review without repeating any GitHub write. */
export async function finalizeStagedReviewCompletionWithGateMode(
  db: Database,
  input: ReviewCompletionAccountingInput,
  orgId: number | null,
): Promise<ReviewCompletionWithGateModeResult> {
  return db.transaction(async (tx) => {
    await lockReviewDecisionScopeById(tx, input.reviewId);
    const gateEnabled =
      orgId === null ? false : await lockOrganizationGateMode(tx, orgId);
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
    const effectiveGateFailing = gateEnabled && gateTruth.gateFailing;

    const rows = await tx
      .update(schema.reviews)
      .set({
        status: "completed",
        gateFailing: effectiveGateFailing,
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

/** Record successful forge lifecycle reconciliation and queue its gate atomically. */
export async function completeReviewPublicationLifecycle(
  db: Database,
  input: { reviewId: number; reviewPublicId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockReviewDecisionScopeById(tx, input.reviewId);
    const rows = await tx
      .update(schema.reviews)
      .set({
        publicationLifecycleReconciledAt:
          sql`COALESCE(${schema.reviews.publicationLifecycleReconciledAt}, now())`,
      })
      .where(
        and(
          eq(schema.reviews.id, input.reviewId),
          eq(schema.reviews.publicId, input.reviewPublicId),
          eq(schema.reviews.status, "completed"),
        ),
      )
      .returning({ id: schema.reviews.id });
    if (rows.length !== 1) {
      throw new Error("completed review is unavailable for publication lifecycle reconciliation");
    }
    // The gate-job trigger takes the shared lifecycle release lock for this
    // insert and parks it at infinity when deactivation owns the boundary.
    await tx.insert(schema.jobs).values({
      kind: "gate-state-sync",
      payload: {
        reviewId: input.reviewId,
        reviewPublicId: input.reviewPublicId,
      },
      maxAttempts: 5,
    });
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
    const effectiveGateFailing = gateEnabled && gateTruth.gateFailing;
    const rows = await tx
      .update(schema.reviews)
      .set({
        status: "completed",
        envelope: gateTruth.envelope,
        configFiles: input.configFiles,
        configProvenance: input.configProvenance ?? {
          entries: [],
          degraded: false,
        },
        silent: input.silent,
        engineGateFailing: gateTruth.gateFailing,
        gateFailing: effectiveGateFailing,
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
