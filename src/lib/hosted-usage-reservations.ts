import { and, eq, gt, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  evaluateRepositoryInferenceAccess,
  type OrganizationEntitlementSnapshot,
} from "@/lib/private-repository-entitlement";
import { enqueueRespondDeliveryJob } from "@/lib/respond-delivery";

/**
 * Conservative upper bound for one hosted review using the checked-in model
 * roster, prompt/diff caps, generation caps, fallbacks, and scorer. A model
 * promotion must update this bound before deployment.
 */
export const HOSTED_REVIEW_RESERVATION_MICROS = 1_000_000;
export const HOSTED_RESPOND_RESERVATION_MICROS = 1_000_000;
export const HOSTED_REVIEW_RESERVATION_TTL_MS = 15 * 60 * 1_000;

export interface HostedUsageReservationDecision {
  allowed: boolean;
  reservationId: string | null;
  reason: "not_hosted" | "reserved" | "usage_cap_reached" | "inactive";
  committedMicros: number;
  activeReservedMicros: number;
  usageLimitMicros: number | null;
}

export function hasHostedReservationCapacity(input: {
  committedMicros: number;
  activeReservedMicros: number;
  requestedMicros: number;
  usageLimitMicros: number;
}): boolean {
  return (
    input.committedMicros + input.activeReservedMicros + input.requestedMicros <=
    input.usageLimitMicros
  );
}

/**
 * Reserve hosted spend under the entitlement row lock. The lock serializes all
 * reservations for an organization, so concurrent workers cannot both observe
 * the same remaining balance. Expired holds are released before accounting.
 */
export async function reserveHostedReviewSpend(
  db: Database,
  input: { orgId: number | null; reviewId: number; usesByok: boolean; now?: Date },
): Promise<HostedUsageReservationDecision> {
  return reserveHostedSpend(db, {
    ...input,
    operation: "review",
    requestedMicros: HOSTED_REVIEW_RESERVATION_MICROS,
  });
}

export async function reserveHostedRespondSpend(
  db: Database,
  input: { orgId: number | null; usesByok: boolean; now?: Date },
): Promise<HostedUsageReservationDecision> {
  return reserveHostedSpend(db, {
    ...input,
    reviewId: null,
    operation: "respond",
    requestedMicros: HOSTED_RESPOND_RESERVATION_MICROS,
  });
}

async function reserveHostedSpend(
  db: Database,
  input: {
    orgId: number | null;
    reviewId: number | null;
    operation: "review" | "respond";
    requestedMicros: number;
    usesByok: boolean;
    now?: Date;
  },
): Promise<HostedUsageReservationDecision> {
  if (input.orgId === null) return emptyDecision("inactive");
  const orgId = input.orgId;
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + HOSTED_REVIEW_RESERVATION_TTL_MS);

  return db.transaction(async (tx) => {
    const lock = await tx.execute(sql`
      SELECT "org_id"
      FROM "organization_entitlements"
      WHERE "org_id" = ${orgId}
      FOR UPDATE
    `);
    if (lock.rows.length === 0) return emptyDecision("inactive");

    const entitlement = (
      await tx
        .select({
          subscriptionMode: schema.organizationEntitlements.subscriptionMode,
          status: schema.organizationEntitlements.status,
          trialEndsAt: schema.organizationEntitlements.trialEndsAt,
          pastDueGraceEndsAt: schema.organizationEntitlements.pastDueGraceEndsAt,
          periodStartsAt: schema.organizationEntitlements.periodStartsAt,
          periodEndsAt: schema.organizationEntitlements.periodEndsAt,
          includedUsageMicros: schema.organizationEntitlements.includedUsageMicros,
          overageHardCapMicros: schema.organizationEntitlements.overageHardCapMicros,
          promotionalEligible: schema.organizationEntitlements.promotionalEligible,
          promotionalEndsAt: schema.organizationEntitlements.promotionalEndsAt,
          billingContactEmail: schema.organizationEntitlements.billingContactEmail,
          billingContactVerifiedAt:
            schema.organizationEntitlements.billingContactVerifiedAt,
        })
        .from(schema.organizationEntitlements)
        .where(eq(schema.organizationEntitlements.orgId, orgId))
        .limit(1)
    )[0] as OrganizationEntitlementSnapshot | undefined;
    if (!entitlement) return emptyDecision("inactive");
    if (input.usesByok) {
      return entitlement.subscriptionMode === "byok"
        ? emptyDecision("not_hosted")
        : emptyDecision("inactive");
    }
    if (entitlement.subscriptionMode !== "hosted") return emptyDecision("inactive");

    const access = evaluateRepositoryInferenceAccess(true, entitlement, 0, now);
    if (!access.allowed || access.usageLimitMicros === null) {
      return {
        ...emptyDecision(access.reason === "usage_cap_reached" ? "usage_cap_reached" : "inactive"),
        usageLimitMicros: access.usageLimitMicros,
      };
    }

    await tx
      .update(schema.hostedUsageReservations)
      .set({ status: "released", updatedAt: now })
      .where(
        and(
          eq(schema.hostedUsageReservations.orgId, orgId),
          eq(schema.hostedUsageReservations.status, "active"),
          sql`${schema.hostedUsageReservations.expiresAt} <= ${now}`,
        ),
      );

    const usageFilters = [
      eq(schema.usageEvents.orgId, orgId),
      eq(schema.usageEvents.billingScope, "private_hosted"),
    ];
    if (entitlement.periodStartsAt) {
      usageFilters.push(sql`${schema.usageEvents.createdAt} >= ${entitlement.periodStartsAt}`);
    }
    if (entitlement.periodEndsAt) {
      usageFilters.push(sql`${schema.usageEvents.createdAt} < ${entitlement.periodEndsAt}`);
    }
    const committed = (
      await tx
        .select({
          micros: sql<number>`COALESCE(SUM(${schema.usageEvents.costMicros}), 0)::bigint`,
          unpriced: sql<number>`COUNT(*) FILTER (WHERE ${schema.usageEvents.costMicros} IS NULL)::int`,
        })
        .from(schema.usageEvents)
        .where(and(...usageFilters))
    )[0] ?? { micros: 0, unpriced: 0 };
    const activeReserved = (
      await tx
        .select({
          micros: sql<number>`COALESCE(SUM(${schema.hostedUsageReservations.reservedMicros}), 0)::bigint`,
        })
        .from(schema.hostedUsageReservations)
        .where(
          and(
            eq(schema.hostedUsageReservations.orgId, orgId),
            eq(schema.hostedUsageReservations.status, "active"),
            gt(schema.hostedUsageReservations.expiresAt, now),
          ),
        )
    )[0]?.micros ?? 0;
    const committedMicros = committed.unpriced > 0
      ? access.usageLimitMicros
      : Number(committed.micros);
    const activeReservedMicros = Number(activeReserved);
    if (
      !hasHostedReservationCapacity({
        committedMicros,
        activeReservedMicros,
        requestedMicros: input.requestedMicros,
        usageLimitMicros: access.usageLimitMicros,
      })
    ) {
      return {
        allowed: false,
        reservationId: null,
        reason: "usage_cap_reached",
        committedMicros,
        activeReservedMicros,
        usageLimitMicros: access.usageLimitMicros,
      };
    }

    const inserted = await tx
      .insert(schema.hostedUsageReservations)
      .values({
        orgId,
        reviewId: input.reviewId,
        operation: input.operation,
        reservedMicros: input.requestedMicros,
        expiresAt,
        updatedAt: now,
      })
      .returning({ id: schema.hostedUsageReservations.id });
    const reservationId = inserted[0]?.id;
    if (!reservationId) throw new Error("hosted usage reservation insert returned no row");
    return {
      allowed: true,
      reservationId,
      reason: "reserved",
      committedMicros,
      activeReservedMicros,
      usageLimitMicros: access.usageLimitMicros,
    };
  });
}

export async function releaseHostedSpend(
  db: Database,
  reservationId: string | null,
  now = new Date(),
): Promise<void> {
  if (!reservationId) return;
  await db
    .update(schema.hostedUsageReservations)
    .set({ status: "released", updatedAt: now })
    .where(
      and(
        eq(schema.hostedUsageReservations.id, reservationId),
        eq(schema.hostedUsageReservations.status, "active"),
      ),
    );
}

export const releaseHostedReviewSpend = releaseHostedSpend;
export const releaseHostedRespondSpend = releaseHostedSpend;

type HostedReviewTriggerSource =
  | "unknown"
  | "automatic_pull_request"
  | "requested_review"
  | "github_check_rerun"
  | "github_mention";

interface HostedReviewReceiptUsage {
  promptTokens: number;
  completionTokens: number;
  modelUsed: string;
  costMicros: number | null;
}

async function reconcileHostedReviewSpendAfterCompletionRace(
  db: Database,
  input: {
    reservationId: string;
    repositoryId: number;
    reviewId: number;
    triggerSource: HostedReviewTriggerSource;
    usage: HostedReviewReceiptUsage[];
    usageAccountingComplete: boolean;
    largeReviewRunKey?: string;
    now?: Date;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const reservation = (
      await tx
        .select({
          orgId: schema.hostedUsageReservations.orgId,
          operation: schema.hostedUsageReservations.operation,
          status: schema.hostedUsageReservations.status,
          reviewId: schema.hostedUsageReservations.reviewId,
          reservedMicros: schema.hostedUsageReservations.reservedMicros,
        })
        .from(schema.hostedUsageReservations)
        .where(eq(schema.hostedUsageReservations.id, input.reservationId))
        .limit(1)
    )[0];
    if (!reservation || reservation.operation !== "review" || reservation.reviewId !== input.reviewId) {
      throw new Error("hosted review usage reservation does not match the review");
    }
    if (reservation.status !== "active") return 0;

    const hasTrustedReceipt = input.usage.length > 0;
    const priced = hasTrustedReceipt && input.usage.every((usage) => usage.costMicros !== null);
    const knownMicros = input.usage.reduce(
      (total, usage) => total + (usage.costMicros ?? 0),
      0,
    );
    const actualMicros = input.usageAccountingComplete && priced
      ? knownMicros
      : Math.max(reservation.reservedMicros, knownMicros);
    const reconciled = await tx
      .update(schema.hostedUsageReservations)
      .set({
        status: "reconciled",
        actualMicros,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.hostedUsageReservations.id, input.reservationId),
          eq(schema.hostedUsageReservations.status, "active"),
          eq(schema.hostedUsageReservations.operation, "review"),
        ),
      )
      .returning({ id: schema.hostedUsageReservations.id });
    if (reconciled.length !== 1) return 0;

    const usageRows = input.usage.map((usage) => ({
      orgId: reservation.orgId,
      repositoryId: input.repositoryId,
      reviewId: input.reviewId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      modelUsed: usage.modelUsed,
      costMicros: usage.costMicros ?? 0,
      billingScope: "private_hosted" as const,
      triggerSource: input.triggerSource,
      createdAt: now,
    }));
    const unattributedMicros = actualMicros - knownMicros;
    if (unattributedMicros > 0) {
      usageRows.push({
        orgId: reservation.orgId,
        repositoryId: input.repositoryId,
        reviewId: input.reviewId,
        promptTokens: 0,
        completionTokens: 0,
        modelUsed: "unattributed provider usage",
        costMicros: unattributedMicros,
        billingScope: "private_hosted",
        triggerSource: input.triggerSource,
        createdAt: now,
      });
    }
    if (usageRows.length > 0) await tx.insert(schema.usageEvents).values(usageRows);
    if (input.largeReviewRunKey) {
      const settledRun = await tx
        .update(schema.largeReviewRuns)
        .set({ billingState: "conservative", conservativelySettledAt: now })
        .where(
          and(
            eq(schema.largeReviewRuns.runKey, input.largeReviewRunKey),
            eq(schema.largeReviewRuns.currentReviewId, input.reviewId),
            eq(schema.largeReviewRuns.hostedReservationId, input.reservationId),
            eq(schema.largeReviewRuns.billingState, "active"),
          ),
        )
        .returning({ runKey: schema.largeReviewRuns.runKey });
      if (settledRun.length !== 1) {
        throw new Error("large-review run does not own the conservative settlement");
      }
    }
    return actualMicros;
  });
}

/** Charge the full hold when a review may have reached the provider but has no trusted receipt. */
export async function reconcileConservativeHostedReviewSpend(
  db: Database,
  input: {
    reservationId: string;
    repositoryId: number;
    reviewId: number;
    triggerSource: HostedReviewTriggerSource;
    largeReviewRunKey?: string;
    now?: Date;
  },
): Promise<number> {
  return reconcileHostedReviewSpendAfterCompletionRace(db, {
    ...input,
    usage: [],
    usageAccountingComplete: false,
  });
}

/** Use a complete trusted CLI receipt when terminal review state wins the completion race. */
export async function reconcileHostedReviewSpendFromReceipt(
  db: Database,
  input: {
    reservationId: string;
    repositoryId: number;
    reviewId: number;
    triggerSource: HostedReviewTriggerSource;
    usage: HostedReviewReceiptUsage[];
    usageAccountingComplete: boolean;
    now?: Date;
  },
): Promise<number> {
  return reconcileHostedReviewSpendAfterCompletionRace(db, input);
}

export async function reconcileHostedRespondSpend(
  db: Database,
  input: {
    reservationId: string;
    repositoryId: number;
    promptTokens: number;
    completionTokens: number;
    modelUsed: string;
    actualMicros: number | null;
    usageAccountingComplete: boolean;
    triggerSource?: "github_mention" | "unknown";
    delivery?: {
      jobId: number;
      sourceOrgId?: number;
      sourceInstallationId?: number;
      sourceGithubInstallationId?: number;
      sourceGithubRepoId?: number;
      repoFullName: string;
      issueNumber: number;
      isPr?: boolean;
      sourceHeadSha?: string;
      body: string;
    };
    now?: Date;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const reservation = (
      await tx
        .select({
          orgId: schema.hostedUsageReservations.orgId,
          operation: schema.hostedUsageReservations.operation,
          status: schema.hostedUsageReservations.status,
          reservedMicros: schema.hostedUsageReservations.reservedMicros,
        })
        .from(schema.hostedUsageReservations)
        .where(eq(schema.hostedUsageReservations.id, input.reservationId))
        .limit(1)
    )[0];
    if (!reservation || reservation.operation !== "respond" || reservation.status !== "active") {
      throw new Error("hosted respond usage reservation is not active");
    }
    const chargedMicros = input.usageAccountingComplete && input.actualMicros !== null
      ? input.actualMicros
      : Math.max(reservation.reservedMicros, input.actualMicros ?? 0);
    if (!Number.isSafeInteger(chargedMicros) || chargedMicros < 0) {
      throw new Error("hosted respond usage cost is invalid");
    }
    const reconciled = await tx
      .update(schema.hostedUsageReservations)
      .set({ status: "reconciled", actualMicros: chargedMicros, updatedAt: now })
      .where(
        and(
          eq(schema.hostedUsageReservations.id, input.reservationId),
          eq(schema.hostedUsageReservations.status, "active"),
          eq(schema.hostedUsageReservations.operation, "respond"),
        ),
      )
      .returning({ id: schema.hostedUsageReservations.id });
    if (reconciled.length !== 1) {
      throw new Error("hosted respond usage reservation changed during reconciliation");
    }
    await tx.insert(schema.usageEvents).values({
      orgId: reservation.orgId,
      repositoryId: input.repositoryId,
      reviewId: null,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      modelUsed: input.modelUsed,
      costMicros: input.actualMicros ?? 0,
      billingScope: "private_hosted",
      triggerSource: input.triggerSource ?? "unknown",
      createdAt: now,
    });
    const unattributedMicros = chargedMicros - (input.actualMicros ?? 0);
    if (unattributedMicros > 0) {
      await tx.insert(schema.usageEvents).values({
        orgId: reservation.orgId,
        repositoryId: input.repositoryId,
        reviewId: null,
        promptTokens: 0,
        completionTokens: 0,
        modelUsed: "unattributed provider usage",
        costMicros: unattributedMicros,
        billingScope: "private_hosted",
        triggerSource: input.triggerSource ?? "unknown",
        createdAt: now,
      });
    }
    if (input.delivery) {
      await tx.insert(schema.respondDeliveries).values({
        jobId: input.delivery.jobId,
        repositoryId: input.repositoryId,
        reservationId: input.reservationId,
        sourceOrgId: input.delivery.sourceOrgId,
        sourceInstallationId: input.delivery.sourceInstallationId,
        sourceGithubInstallationId: input.delivery.sourceGithubInstallationId,
        sourceGithubRepoId: input.delivery.sourceGithubRepoId,
        repoFullName: input.delivery.repoFullName,
        issueNumber: input.delivery.issueNumber,
        isPr: input.delivery.isPr,
        sourceHeadSha: input.delivery.sourceHeadSha,
        body: input.delivery.body,
        createdAt: now,
        updatedAt: now,
      });
      await enqueueRespondDeliveryJob(tx, input.delivery.jobId);
    }
    return chargedMicros;
  });
}

function emptyDecision(
  reason: HostedUsageReservationDecision["reason"],
): HostedUsageReservationDecision {
  return {
    allowed: reason === "not_hosted",
    reservationId: null,
    reason,
    committedMicros: 0,
    activeReservedMicros: 0,
    usageLimitMicros: null,
  };
}
