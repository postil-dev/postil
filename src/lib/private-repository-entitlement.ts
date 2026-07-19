import { and, eq, gte, lt, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";

export type RepositoryInferenceAccessReason =
  | "public_repository"
  | "active_subscription"
  | "active_trial"
  | "past_due_grace"
  | "operator_promotion"
  | "no_entitlement"
  | "suspended"
  | "inactive"
  | "provider_mode_mismatch"
  | "usage_cap_reached";

export interface OrganizationEntitlementSnapshot {
  subscriptionMode: "hosted" | "byok";
  status: "active" | "trialing" | "past_due" | "suspended";
  trialEndsAt: Date | null;
  pastDueGraceEndsAt: Date | null;
  periodStartsAt: Date | null;
  periodEndsAt: Date | null;
  includedUsageMicros: number;
  overageHardCapMicros: number | null;
  promotionalEligible: boolean;
  promotionalEndsAt: Date | null;
  billingContactEmail: string | null;
  billingContactVerifiedAt: Date | null;
}

export interface RepositoryInferenceAccessDecision {
  allowed: boolean;
  reason: RepositoryInferenceAccessReason;
  entitlement: OrganizationEntitlementSnapshot | null;
  usageMicros: number;
  usageLimitMicros: number | null;
}

/** Keep provider selection within the repository's active inference entitlement. */
export function providerModeMatchesRepositoryAccess(
  repositoryPrivate: boolean,
  decision: RepositoryInferenceAccessDecision,
  byok: boolean,
): boolean {
  // Public repositories are free only when the organization supplies the
  // provider. Managed hosted inference always consumes an entitlement and its
  // bounded allowance, regardless of repository visibility.
  if (!repositoryPrivate && byok) return true;
  if (decision.reason === "public_repository") return false;
  if (!decision.allowed || !decision.entitlement) return false;
  return decision.entitlement.subscriptionMode === (byok ? "byok" : "hosted");
}

/** Reflect a configured provider that cannot be used by the billed plan. */
export function requireMatchingProviderMode(
  decision: RepositoryInferenceAccessDecision,
  byok: boolean,
): RepositoryInferenceAccessDecision {
  if (!decision.allowed || !decision.entitlement) return decision;
  if (decision.entitlement.subscriptionMode === (byok ? "byok" : "hosted")) {
    return decision;
  }
  return { ...decision, allowed: false, reason: "provider_mode_mismatch" };
}

export function evaluateRepositoryInferenceAccess(
  repositoryPrivate: boolean,
  entitlement: OrganizationEntitlementSnapshot | null,
  usageMicros: number,
  now = new Date(),
): RepositoryInferenceAccessDecision {
  if (!entitlement) {
    if (!repositoryPrivate) {
      return {
        allowed: true,
        reason: "public_repository",
        entitlement: null,
        usageMicros,
        usageLimitMicros: null,
      };
    }
    return {
      allowed: false,
      reason: "no_entitlement",
      entitlement: null,
      usageMicros,
      usageLimitMicros: null,
    };
  }
  const effectiveOverageHardCapMicros =
    entitlement.overageHardCapMicros ??
    (entitlement.subscriptionMode === "hosted" ? 0 : null);
  const usageLimitMicros =
    effectiveOverageHardCapMicros === null
      ? null
      : entitlement.includedUsageMicros + effectiveOverageHardCapMicros;
  if (entitlement.status === "suspended") {
    return { allowed: false, reason: "suspended", entitlement, usageMicros, usageLimitMicros };
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
  const reason: RepositoryInferenceAccessReason | null =
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
    if (!repositoryPrivate) {
      return {
        allowed: true,
        reason: "public_repository",
        entitlement,
        usageMicros,
        usageLimitMicros,
      };
    }
    return { allowed: false, reason: "inactive", entitlement, usageMicros, usageLimitMicros };
  }
  if (usageLimitMicros !== null && usageMicros >= usageLimitMicros) {
    return {
      allowed: false,
      reason: "usage_cap_reached",
      entitlement,
      usageMicros,
      usageLimitMicros,
    };
  }
  return { allowed: true, reason, entitlement, usageMicros, usageLimitMicros };
}

/** Single product-entitlement gate for hosted and private-repository inference. */
export async function canProcessRepositoryInference(
  db: Database,
  input: { orgId: number | null; repositoryPrivate: boolean; now?: Date },
): Promise<RepositoryInferenceAccessDecision> {
  const now = input.now ?? new Date();
  if (input.orgId === null) {
    return evaluateRepositoryInferenceAccess(input.repositoryPrivate, null, 0, now);
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
        includedUsageMicros: schema.organizationEntitlements.includedUsageMicros,
        overageHardCapMicros: schema.organizationEntitlements.overageHardCapMicros,
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
  if (!entitlement) {
    return evaluateRepositoryInferenceAccess(input.repositoryPrivate, null, 0, now);
  }

  // BYOK provider charges never pass through Postil, so provider-side limits
  // remain authoritative and Postil does not estimate or gate that spend.
  if (entitlement.subscriptionMode === "byok") {
    return evaluateRepositoryInferenceAccess(input.repositoryPrivate, entitlement, 0, now);
  }

  let usageMicros = 0;
  const effectiveOverageHardCapMicros =
    entitlement.overageHardCapMicros ??
    (entitlement.subscriptionMode === "hosted" ? 0 : null);
  if (effectiveOverageHardCapMicros !== null) {
    const filters = [
      eq(schema.usageEvents.orgId, input.orgId),
      eq(schema.usageEvents.billingScope, "private_hosted"),
    ];
    if (entitlement.periodStartsAt) {
      filters.push(gte(schema.usageEvents.createdAt, entitlement.periodStartsAt));
    }
    if (entitlement.periodEndsAt) {
      filters.push(lt(schema.usageEvents.createdAt, entitlement.periodEndsAt));
    }
    const usage = (
      await db
        .select({
          costMicros: sql<number>`COALESCE(SUM(${schema.usageEvents.costMicros}), 0)::bigint`,
          unpricedCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.usageEvents.costMicros} IS NULL)::int`,
        })
        .from(schema.usageEvents)
        .where(and(...filters))
    )[0];
    const pricedUsageMicros = usage?.costMicros ?? 0;
    const usageLimitMicros =
      entitlement.includedUsageMicros + effectiveOverageHardCapMicros;
    // A hard cap cannot be proven while an event in the period is unpriced.
    // Fail closed instead of silently treating unknown spend as free.
    usageMicros = (usage?.unpricedCount ?? 0) > 0 ? usageLimitMicros : pricedUsageMicros;
  }
  return evaluateRepositoryInferenceAccess(
    input.repositoryPrivate,
    entitlement,
    usageMicros,
    now,
  );
}

// Compatibility exports for billing UI call sites while repository processing
// migrates to the visibility-independent inference entitlement terminology.
export type PrivateRepositoryAccessReason = RepositoryInferenceAccessReason;
export type PrivateRepositoryAccessDecision = RepositoryInferenceAccessDecision;
export const evaluatePrivateRepositoryAccess = evaluateRepositoryInferenceAccess;
export const canProcessPrivateRepository = canProcessRepositoryInference;
export const providerModeMatchesPrivateAccess = providerModeMatchesRepositoryAccess;
