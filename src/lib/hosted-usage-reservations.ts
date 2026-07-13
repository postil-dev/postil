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

    const usageFilters = [eq(schema.usageEvents.orgId, orgId)];
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
        requestedMicros: HOSTED_REVIEW_RESERVATION_MICROS,
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
        reservedMicros: HOSTED_REVIEW_RESERVATION_MICROS,
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

export async function releaseHostedReviewSpend(
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
