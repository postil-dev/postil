import { and, eq, gt, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  evaluatePrivateRepositoryAccess,
  type OrganizationEntitlementSnapshot,
} from "@/lib/private-repository-entitlement";

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

    const access = evaluatePrivateRepositoryAccess(true, entitlement, 0, now);
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
    delivery?: {
      jobId: number;
      repoFullName: string;
      issueNumber: number;
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
      costMicros: input.actualMicros,
      billingScope: "private_hosted",
      createdAt: now,
    });
    const unattributedMicros = input.actualMicros === null
      ? 0
      : chargedMicros - input.actualMicros;
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
        createdAt: now,
      });
    }
    if (input.delivery) {
      await tx.insert(schema.respondDeliveries).values({
        jobId: input.delivery.jobId,
        repositoryId: input.repositoryId,
        reservationId: input.reservationId,
        repoFullName: input.delivery.repoFullName,
        issueNumber: input.delivery.issueNumber,
        body: input.delivery.body,
        createdAt: now,
        updatedAt: now,
      });
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
