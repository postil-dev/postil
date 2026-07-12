import { and, eq, gte, lt, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";

export type PrivateRepositoryAccessReason =
  | "public_repository"
  | "active_subscription"
  | "active_trial"
  | "past_due_grace"
  | "operator_promotion"
  | "no_entitlement"
  | "suspended"
  | "inactive"
  | "usage_cap_reached";

export interface OrganizationEntitlementSnapshot {
  subscriptionMode: "hosted" | "byok";
  status: "active" | "trialing" | "past_due" | "suspended";
  trialEndsAt: Date | null;
  pastDueGraceEndsAt: Date | null;
  periodStartsAt: Date | null;
  periodEndsAt: Date | null;
  includedUsageCents: number;
  overageHardCapCents: number | null;
  promotionalEligible: boolean;
  promotionalEndsAt: Date | null;
  billingContactEmail: string | null;
  billingContactVerifiedAt: Date | null;
}

export interface PrivateRepositoryAccessDecision {
  allowed: boolean;
  reason: PrivateRepositoryAccessReason;
  entitlement: OrganizationEntitlementSnapshot | null;
  usageCents: number;
  usageLimitCents: number | null;
}

export function evaluatePrivateRepositoryAccess(
  repositoryPrivate: boolean,
  entitlement: OrganizationEntitlementSnapshot | null,
  usageCents: number,
  now = new Date(),
): PrivateRepositoryAccessDecision {
  if (!repositoryPrivate) {
    return {
      allowed: true,
      reason: "public_repository",
      entitlement,
      usageCents,
      usageLimitCents: null,
    };
  }
  if (!entitlement) {
    return {
      allowed: false,
      reason: "no_entitlement",
      entitlement: null,
      usageCents,
      usageLimitCents: null,
    };
  }
  const effectiveOverageHardCapCents =
    entitlement.overageHardCapCents ??
    (entitlement.subscriptionMode === "hosted" ? 0 : null);
  const usageLimitCents =
    effectiveOverageHardCapCents === null
      ? null
      : entitlement.includedUsageCents + effectiveOverageHardCapCents;
  if (entitlement.status === "suspended") {
    return { allowed: false, reason: "suspended", entitlement, usageCents, usageLimitCents };
  }
  const trialActive = Boolean(entitlement.trialEndsAt && now < entitlement.trialEndsAt);
  const graceActive = Boolean(
    entitlement.status === "past_due" &&
      entitlement.pastDueGraceEndsAt &&
      now < entitlement.pastDueGraceEndsAt,
  );
  const promotionActive = Boolean(
    entitlement.promotionalEligible &&
      (!entitlement.promotionalEndsAt || now < entitlement.promotionalEndsAt),
  );
  const reason: PrivateRepositoryAccessReason | null =
    entitlement.status === "active"
      ? "active_subscription"
      : entitlement.status === "trialing" && trialActive
        ? "active_trial"
        : graceActive
          ? "past_due_grace"
          : promotionActive
            ? "operator_promotion"
            : null;
  if (!reason) {
    return { allowed: false, reason: "inactive", entitlement, usageCents, usageLimitCents };
  }
  if (usageLimitCents !== null && usageCents >= usageLimitCents) {
    return {
      allowed: false,
      reason: "usage_cap_reached",
      entitlement,
      usageCents,
      usageLimitCents,
    };
  }
  return { allowed: true, reason, entitlement, usageCents, usageLimitCents };
}

/** Single product-entitlement gate for all private-repository processing. */
export async function canProcessPrivateRepository(
  db: Database,
  input: { orgId: number | null; repositoryPrivate: boolean; now?: Date },
): Promise<PrivateRepositoryAccessDecision> {
  const now = input.now ?? new Date();
  if (!input.repositoryPrivate) {
    return evaluatePrivateRepositoryAccess(false, null, 0, now);
  }
  if (input.orgId === null) {
    return evaluatePrivateRepositoryAccess(true, null, 0, now);
  }
  const entitlement = (
    await db
      .select({
        subscriptionMode: schema.organizationEntitlements.subscriptionMode,
        status: schema.organizationEntitlements.status,
        trialEndsAt: schema.organizationEntitlements.trialEndsAt,
        pastDueGraceEndsAt: schema.organizationEntitlements.pastDueGraceEndsAt,
        periodStartsAt: schema.organizationEntitlements.periodStartsAt,
        periodEndsAt: schema.organizationEntitlements.periodEndsAt,
        includedUsageCents: schema.organizationEntitlements.includedUsageCents,
        overageHardCapCents: schema.organizationEntitlements.overageHardCapCents,
        promotionalEligible: schema.organizationEntitlements.promotionalEligible,
        promotionalEndsAt: schema.organizationEntitlements.promotionalEndsAt,
        billingContactEmail: schema.organizationEntitlements.billingContactEmail,
        billingContactVerifiedAt:
          schema.organizationEntitlements.billingContactVerifiedAt,
      })
      .from(schema.organizationEntitlements)
      .where(eq(schema.organizationEntitlements.orgId, input.orgId))
      .limit(1)
  )[0] as OrganizationEntitlementSnapshot | undefined;
  if (!entitlement) return evaluatePrivateRepositoryAccess(true, null, 0, now);

  let usageCents = 0;
  const effectiveOverageHardCapCents =
    entitlement.overageHardCapCents ??
    (entitlement.subscriptionMode === "hosted" ? 0 : null);
  if (effectiveOverageHardCapCents !== null) {
    const filters = [eq(schema.usageEvents.orgId, input.orgId)];
    if (entitlement.periodStartsAt) {
      filters.push(gte(schema.usageEvents.createdAt, entitlement.periodStartsAt));
    }
    if (entitlement.periodEndsAt) {
      filters.push(lt(schema.usageEvents.createdAt, entitlement.periodEndsAt));
    }
    const usage = (
      await db
        .select({
          costCents: sql<number>`COALESCE(SUM(${schema.usageEvents.costCents}), 0)::int`,
          unpricedCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.usageEvents.costCents} IS NULL)::int`,
        })
        .from(schema.usageEvents)
        .where(and(...filters))
    )[0];
    const pricedUsageCents = usage?.costCents ?? 0;
    const usageLimitCents =
      entitlement.includedUsageCents + effectiveOverageHardCapCents;
    // A hard cap cannot be proven while an event in the period is unpriced.
    // Fail closed instead of silently treating unknown spend as free.
    usageCents = (usage?.unpricedCount ?? 0) > 0 ? usageLimitCents : pricedUsageCents;
  }
  return evaluatePrivateRepositoryAccess(true, entitlement, usageCents, now);
}
