import { describe, expect, test } from "bun:test";

import {
  evaluateRepositoryInferenceAccess,
  providerModeMatchesRepositoryAccess,
  requireMatchingProviderMode,
  type OrganizationEntitlementSnapshot,
} from "@/lib/private-repository-entitlement";

const now = new Date("2026-07-12T12:00:00.000Z");

function entitlement(
  overrides: Partial<OrganizationEntitlementSnapshot> = {},
): OrganizationEntitlementSnapshot {
  return {
    subscriptionMode: "hosted",
    status: "active",
    trialEndsAt: null,
    pastDueGraceEndsAt: null,
    periodStartsAt: new Date("2026-07-01T00:00:00.000Z"),
    periodEndsAt: new Date("2026-08-01T00:00:00.000Z"),
    includedUsageMicros: 1_000_000,
    overageHardCapMicros: 500_000,
    promotionalEligible: false,
    promotionalEndsAt: null,
    billingContactEmail: null,
    billingContactVerifiedAt: null,
    ...overrides,
  };
}

describe("repository inference entitlement matrix", () => {
  test("public BYOK remains eligible without billing state while hosted does not", () => {
    const access = evaluateRepositoryInferenceAccess(false, null, 0, now);
    expect(access).toMatchObject({
      allowed: true,
      reason: "public_repository",
    });
    expect(providerModeMatchesRepositoryAccess(false, access, true)).toBe(true);
    expect(providerModeMatchesRepositoryAccess(false, access, false)).toBe(false);
  });

  test("an active public hosted trial is bounded by its entitlement", () => {
    const active = evaluateRepositoryInferenceAccess(
      false,
      entitlement({ status: "trialing", trialEndsAt: new Date(now.getTime() + 1) }),
      0,
      now,
    );
    const expired = evaluateRepositoryInferenceAccess(
      false,
      entitlement({ status: "trialing", trialEndsAt: now }),
      0,
      now,
    );
    expect(providerModeMatchesRepositoryAccess(false, active, false)).toBe(true);
    expect(providerModeMatchesRepositoryAccess(false, expired, false)).toBe(false);
  });

  test.each(["hosted", "byok"] as const)(
    "an active %s subscription grants private access",
    (subscriptionMode) => {
      expect(
        evaluateRepositoryInferenceAccess(
          true,
          entitlement({ subscriptionMode }),
          100,
          now,
        ),
      ).toMatchObject({ allowed: true, reason: "active_subscription" });
    },
  );

  test("a provider key has no path into the entitlement decision", () => {
    expect(evaluateRepositoryInferenceAccess(true, null, 0, now)).toMatchObject({
      allowed: false,
      reason: "no_entitlement",
    });
  });

  test("private inference must match the billed provider mode", () => {
    const hosted = evaluateRepositoryInferenceAccess(true, entitlement(), 0, now);
    const byok = evaluateRepositoryInferenceAccess(
      true,
      entitlement({ subscriptionMode: "byok" }),
      0,
      now,
    );
    expect(providerModeMatchesRepositoryAccess(true, hosted, false)).toBe(true);
    expect(providerModeMatchesRepositoryAccess(true, hosted, true)).toBe(false);
    expect(providerModeMatchesRepositoryAccess(true, byok, true)).toBe(true);
    expect(providerModeMatchesRepositoryAccess(true, byok, false)).toBe(false);
    expect(providerModeMatchesRepositoryAccess(false, hosted, true)).toBe(true);
    expect(requireMatchingProviderMode(hosted, true)).toMatchObject({
      allowed: false,
      reason: "provider_mode_mismatch",
    });
    expect(requireMatchingProviderMode(hosted, false)).toBe(hosted);
  });

  test("trial expiry is exclusive at the exact boundary", () => {
    const before = entitlement({
      status: "trialing",
      trialEndsAt: new Date(now.getTime() + 1),
    });
    const boundary = entitlement({ status: "trialing", trialEndsAt: now });
    expect(evaluateRepositoryInferenceAccess(true, before, 0, now).reason).toBe("active_trial");
    expect(evaluateRepositoryInferenceAccess(true, boundary, 0, now)).toMatchObject({
      allowed: false,
      reason: "inactive",
    });
  });

  test("past-due grace is exclusive at the exact boundary", () => {
    const before = entitlement({
      status: "past_due",
      pastDueGraceEndsAt: new Date(now.getTime() + 1),
    });
    const boundary = entitlement({ status: "past_due", pastDueGraceEndsAt: now });
    expect(evaluateRepositoryInferenceAccess(true, before, 0, now).reason).toBe(
      "past_due_grace",
    );
    expect(evaluateRepositoryInferenceAccess(true, boundary, 0, now).allowed).toBe(false);
  });

  test("suspension overrides trials, grace, and promotions", () => {
    const suspended = entitlement({
      status: "suspended",
      trialEndsAt: new Date(now.getTime() + 60_000),
      pastDueGraceEndsAt: new Date(now.getTime() + 60_000),
      promotionalEligible: true,
    });
    expect(evaluateRepositoryInferenceAccess(true, suspended, 0, now)).toMatchObject({
      allowed: false,
      reason: "suspended",
    });
  });

  test("an unexpired operator promotion grants access but expires exclusively", () => {
    const active = entitlement({
      status: "past_due",
      promotionalEligible: true,
      promotionalEndsAt: new Date(now.getTime() + 1),
    });
    const expired = entitlement({
      status: "past_due",
      promotionalEligible: true,
      promotionalEndsAt: now,
    });
    expect(evaluateRepositoryInferenceAccess(true, active, 0, now).reason).toBe(
      "operator_promotion",
    );
    expect(evaluateRepositoryInferenceAccess(true, expired, 0, now).allowed).toBe(false);
  });

  test("the included-plus-overage hard cap blocks at the exact limit", () => {
    const state = entitlement({ includedUsageMicros: 1_000_000, overageHardCapMicros: 500_000 });
    expect(evaluateRepositoryInferenceAccess(true, state, 1_499_999, now).allowed).toBe(true);
    expect(evaluateRepositoryInferenceAccess(true, state, 1_500_000, now)).toMatchObject({
      allowed: false,
      reason: "usage_cap_reached",
      usageLimitMicros: 1_500_000,
    });
  });

  test("hosted null cap fails safe to zero overage while BYOK null remains uncapped", () => {
    const hosted = entitlement({
      subscriptionMode: "hosted",
      includedUsageMicros: 1_000_000,
      overageHardCapMicros: null,
    });
    const byok = entitlement({
      subscriptionMode: "byok",
      includedUsageMicros: 0,
      overageHardCapMicros: null,
    });
    expect(evaluateRepositoryInferenceAccess(true, hosted, 999_999, now).allowed).toBe(true);
    expect(evaluateRepositoryInferenceAccess(true, hosted, 1_000_000, now)).toMatchObject({
      allowed: false,
      usageLimitMicros: 1_000_000,
    });
    expect(evaluateRepositoryInferenceAccess(true, byok, 1_000_000, now)).toMatchObject({
      allowed: true,
      usageLimitMicros: null,
    });
  });
});
