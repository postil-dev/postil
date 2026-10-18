import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import {
  appendPreparedReceiptBatch, claimEvent, lockReceiptClaim, prepareReviewObservation,
  transactionReceiptClient, type ReviewClaimLease,
} from "@/lib/job-attempt-receipts";
import { schema } from "@/lib/db";
import {
  computeEffectiveGate,
  envelopeSchema,
  type Envelope,
} from "@/lib/envelope";
import type { ReviewConfigProvenance } from "@/lib/github/contents";
import { lockReviewDecisionScopeById } from "@/lib/finding-approvals";
import { lockOrganizationGateMode } from "@/lib/gate-mode";
import { reconcileHostedReviewSpendFromReceipt } from "@/lib/hosted-usage-reservations";
import {
  persistPublicationReceipt,
  type PublicationReceipt,
} from "@/lib/publication-receipt";

interface ReviewCompletionAccountingInput {
  reviewClaim?: ReviewClaimLease;
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
  reviewClaim?: ReviewClaimLease;
  /** Trusted CLI spend settles atomically when claim or terminal state rejects completion. */
  hostedSpend?: Parameters<typeof reconcileHostedReviewSpendFromReceipt>[1];
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
        .select({ reservedMicros: schema.hostedUsageReservations.reservedMicros,
          status: schema.hostedUsageReservations.status, reviewId: schema.hostedUsageReservations.reviewId })
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
      if (reservation.status !== "reconciled" || reservation.reviewId !== input.reviewId) {
        throw new Error("hosted usage reservation is not active");
      }
      // A late producer can settle this same review before its recovery owner finalizes it.
      persistedUsageRows.length = 0;
    }
  }
  if (persistedUsageRows.length > 0) await db.insert(schema.usageEvents).values(persistedUsageRows);
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
): Promise<ReviewCompletionWithGateModeResult & { staged: boolean; claimOwned?: boolean | null }> {
  return db.transaction(async (tx) => {
    await lockReviewDecisionScopeById(tx, input.reviewId);
    const client = transactionReceiptClient(tx);
    const lease = input.reviewClaim;
    if (lease?.receiptClaim && input.reviewJobId !== undefined
      && (Number.isSafeInteger(input.reviewJobId)
        ? String(input.reviewJobId) !== lease.receiptClaim.jobId : input.reviewJobId !== lease.id)) {
      throw new Error("staging job identity mismatch");
    }
    const job = lease?.receiptClaim ? await lockReceiptClaim(client, lease) : null;
    let alreadyStaged = false;
    if (lease?.receiptClaim) {
      const binding = await client.query(`SELECT EXISTS (SELECT 1 FROM job_attempt_receipts o
          WHERE o.claim_receipt_id = b.claim_receipt_id AND o.review_id = r.id
            AND o.event_kind = 'review_observed' AND o.outcome = 'staged') AS staged,
        r.envelope = $4::jsonb AS same_envelope,
        (SELECT p.receipt_id FROM review_publication_receipts p WHERE p.review_id = r.id) AS publication_id
        FROM job_attempt_receipts b JOIN reviews r
        ON r.id = b.review_id AND r.public_id = b.review_public_id
        WHERE b.claim_receipt_id = $1::bigint AND b.job_id = $2::bigint
          AND b.event_kind = 'review_bound' AND r.id = $3::bigint`,
        [lease.receiptClaim.receiptId, lease.receiptClaim.jobId, String(input.reviewId), JSON.stringify(input.envelope)]);
      if (binding.rows.length !== 1) throw new Error("staging review claim binding is missing");
      alreadyStaged = binding.rows[0]!.staged === true;
      if (alreadyStaged && (binding.rows[0]!.same_envelope !== true
        || (input.publicationReceipt && binding.rows[0]!.publication_id !== input.publicationReceipt.receiptId))) {
        throw new Error("staged review evidence changed");
      }
    }
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
      .returning({ id: schema.reviews.id, repositoryId: schema.reviews.repositoryId,
        triggerSource: schema.reviews.triggerSource });
    if (input.hostedSpend && (rows.length === 0 || (lease?.receiptClaim && !job?.owned))) {
      const review = rows[0] ?? (await tx
        .select({ repositoryId: schema.reviews.repositoryId, triggerSource: schema.reviews.triggerSource })
        .from(schema.reviews).where(eq(schema.reviews.id, input.reviewId)).limit(1))[0];
      if (!review || input.hostedSpend.reviewId !== input.reviewId
        || input.hostedSpend.repositoryId !== review.repositoryId
        || input.hostedSpend.triggerSource !== review.triggerSource) {
        throw new Error("staging hosted spend identity mismatch");
      }
      await reconcileHostedReviewSpendFromReceipt(tx as Database, input.hostedSpend);
    }
    if (rows.length === 0) {
      return {
        staged: false,
        completed: false,
        gateEnabled,
        gateFailing: effectiveGateFailing,
      };
    }

    if (!alreadyStaged) await persistPublicationReceipt(tx as Database, {
      reviewId: input.reviewId,
      envelope: gateTruth.envelope,
      receipt: input.publicationReceipt,
    });
    if (!lease?.receiptClaim && input.reviewJobId !== undefined) {
      await tx
        .update(schema.jobs)
        .set({
          payload: sql`${schema.jobs.payload} || jsonb_build_object(
            'recoveryReviewId', ${input.reviewId}::bigint
          )`,
        })
        .where(eq(schema.jobs.id, input.reviewJobId));
    }

    if (lease?.receiptClaim) {
      if (job?.owned) {
        const updated = await client.query(`UPDATE jobs SET staged_review_id = $3::bigint,
          payload = payload || jsonb_build_object('recoveryReviewId', $3::bigint)
          WHERE id = $1::bigint AND status = 'running' AND active_claim_receipt_id = $2::bigint
            AND locked_by = $4 AND locked_at = $5::timestamptz RETURNING id`,
          [lease.receiptClaim.jobId, lease.receiptClaim.receiptId, String(input.reviewId), lease.lockedBy, lease.lockedAt]);
        if (updated.rows.length !== 1) throw new Error("staging lost its locked claim");
      }
      const events = await prepareReviewObservation(client, input.reviewId, "staged", lease);
      if (events.length) {
        for (const incident of gateTruth.envelope.modelIncidents ?? []) {
          events.push({ ...claimEvent(lease.receiptClaim.jobId, events[0]!.ordinal,
            lease.receiptClaim.receiptId, "incident", "observed", String(input.reviewId),
            events[0]!.reviewPublicId), phase: incident.phase, category: incident.category,
          recovered: incident.recovered, recovery: incident.recovery ?? null });
        }
      }
      await appendPreparedReceiptBatch(client, events);
    }
    return {
      claimOwned: lease?.receiptClaim ? job?.owned === true : null,
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
    const client = transactionReceiptClient(tx);
    let qualified = false;
    if (input.reviewClaim?.receiptClaim && !(await lockReceiptClaim(client, input.reviewClaim))?.owned) {
      return { completed: false, gateEnabled: false, gateFailing: false };
    }
    if (input.reviewClaim?.receiptClaim) {
      const binding = await client.query(`SELECT r.origin_claim_receipt_id::text,
        EXISTS (SELECT 1 FROM job_attempt_receipts b WHERE b.review_id = r.id
          AND b.review_public_id = r.public_id AND b.event_kind = 'review_bound'
          AND b.claim_receipt_id = $1::bigint AND b.job_id = $2::bigint) AS bound
        FROM reviews r WHERE r.id = $3::bigint`,
        [input.reviewClaim.receiptClaim.receiptId, input.reviewClaim.receiptClaim.jobId, String(input.reviewId)]);
      const row = binding.rows[0];
      if (row?.origin_claim_receipt_id !== null) {
        if (!row?.bound) throw new Error("completion review claim binding is missing");
        qualified = true;
      }
    }
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
    if (qualified) {
      const events = await prepareReviewObservation(client, input.reviewId, "completed", input.reviewClaim);
      await appendPreparedReceiptBatch(client, events);
    }
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


/** Create a review and its immutable claim binding in the owning transaction. */
export async function insertReviewForClaim(db: Database,
  values: Omit<typeof schema.reviews.$inferInsert, "originClaimReceiptId">, lease?: ReviewClaimLease) {
  if (!lease?.receiptClaim) {
    return (await db.insert(schema.reviews).values(values)
      .returning({ id: schema.reviews.id, publicId: schema.reviews.publicId }))[0];
  }
  return db.transaction(async (tx) => {
    const client = transactionReceiptClient(tx);
    const job = await lockReceiptClaim(client, lease);
    if (!job?.owned) return undefined;
    const [review] = await tx.insert(schema.reviews)
      .values({ ...values, originClaimReceiptId: lease.receiptClaim!.receiptId })
      .returning({ id: schema.reviews.id, publicId: schema.reviews.publicId, receiptReviewId: sql<string>`${schema.reviews.id}::text` });
    if (!review) throw new Error("review insert returned no row");
    await appendPreparedReceiptBatch(client, [claimEvent(lease.receiptClaim!.jobId,
      Number(job.attempts), lease.receiptClaim!.receiptId, "review_bound", "bound",
      review.receiptReviewId, review.publicId)]);
    return review;
  });
}

/** Only the locked job's genuine staged pointer can authorize a recovery binding. */
export async function bindStagedReviewClaim(db: Database, reviewId: number, lease: ReviewClaimLease) {
  if (!lease.receiptClaim) return false;
  return db.transaction(async (tx) => {
    const client = transactionReceiptClient(tx);
    const job = await lockReceiptClaim(client, lease);
    if (!job?.owned || job.staged_review_id !== String(reviewId)) return false;
    const result = await client.query(`SELECT r.public_id::text, r.origin_claim_receipt_id::text,
      c.job_id::text FROM reviews r JOIN job_attempt_receipts c
      ON c.receipt_id = r.origin_claim_receipt_id AND c.event_kind = 'claim'
      WHERE r.id = $1::bigint AND c.job_id = $2::bigint FOR UPDATE OF r`,
      [String(reviewId), lease.receiptClaim!.jobId]);
    const review = result.rows[0];
    if (!review) return false;
    const existing = await client.query(`SELECT 1 FROM job_attempt_receipts
      WHERE event_kind = 'review_bound' AND claim_receipt_id = $1::bigint AND review_id = $2::bigint`,
      [lease.receiptClaim!.receiptId, String(reviewId)]);
    if (!existing.rows.length) {
      await appendPreparedReceiptBatch(client, [claimEvent(lease.receiptClaim!.jobId,
        Number(job.attempts), lease.receiptClaim!.receiptId, "review_bound", "bound",
        String(reviewId), String(review.public_id))]);
    }
    return true;
  });
}
