import { describe, expect, test } from "bun:test";

import {
  evaluatePrivateRepositoryAccess,
  providerModeMatchesPrivateAccess,
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

describe("private repository entitlement matrix", () => {
  test("public repositories remain eligible without billing state", () => {
    expect(evaluatePrivateRepositoryAccess(false, null, 0, now)).toMatchObject({
      allowed: true,
      reason: "public_repository",
    });
  });

  test.each(["hosted", "byok"] as const)(
    "an active %s subscription grants private access",
    (subscriptionMode) => {
      expect(
        evaluatePrivateRepositoryAccess(
          true,
          entitlement({ subscriptionMode }),
          100,
          now,
        ),
      ).toMatchObject({ allowed: true, reason: "active_subscription" });
    },
  );

  test("a provider key has no path into the entitlement decision", () => {
    expect(evaluatePrivateRepositoryAccess(true, null, 0, now)).toMatchObject({
      allowed: false,
      reason: "no_entitlement",
    });
  });

  test("private inference must match the billed provider mode", () => {
    const hosted = evaluatePrivateRepositoryAccess(true, entitlement(), 0, now);
    const byok = evaluatePrivateRepositoryAccess(
      true,
      entitlement({ subscriptionMode: "byok" }),
      0,
      now,
    );
    expect(providerModeMatchesPrivateAccess(true, hosted, false)).toBe(true);
    expect(providerModeMatchesPrivateAccess(true, hosted, true)).toBe(false);
    expect(providerModeMatchesPrivateAccess(true, byok, true)).toBe(true);
    expect(providerModeMatchesPrivateAccess(true, byok, false)).toBe(false);
    expect(providerModeMatchesPrivateAccess(false, hosted, true)).toBe(true);
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
    expect(evaluatePrivateRepositoryAccess(true, before, 0, now).reason).toBe("active_trial");
    expect(evaluatePrivateRepositoryAccess(true, boundary, 0, now)).toMatchObject({
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
    expect(evaluatePrivateRepositoryAccess(true, before, 0, now).reason).toBe(
      "past_due_grace",
    );
    expect(evaluatePrivateRepositoryAccess(true, boundary, 0, now).allowed).toBe(false);
  });

  test("suspension overrides trials, grace, and promotions", () => {
    const suspended = entitlement({
      status: "suspended",
      trialEndsAt: new Date(now.getTime() + 60_000),
      pastDueGraceEndsAt: new Date(now.getTime() + 60_000),
      promotionalEligible: true,
    });
    expect(evaluatePrivateRepositoryAccess(true, suspended, 0, now)).toMatchObject({
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
    expect(evaluatePrivateRepositoryAccess(true, active, 0, now).reason).toBe(
      "operator_promotion",
    );
    expect(evaluatePrivateRepositoryAccess(true, expired, 0, now).allowed).toBe(false);
  });

  test("the included-plus-overage hard cap blocks at the exact limit", () => {
    const state = entitlement({ includedUsageMicros: 1_000_000, overageHardCapMicros: 500_000 });
    expect(evaluatePrivateRepositoryAccess(true, state, 1_499_999, now).allowed).toBe(true);
    expect(evaluatePrivateRepositoryAccess(true, state, 1_500_000, now)).toMatchObject({
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
    expect(evaluatePrivateRepositoryAccess(true, hosted, 999_999, now).allowed).toBe(true);
    expect(evaluatePrivateRepositoryAccess(true, hosted, 1_000_000, now)).toMatchObject({
      allowed: false,
      usageLimitMicros: 1_000_000,
    });
    expect(evaluatePrivateRepositoryAccess(true, byok, 1_000_000, now)).toMatchObject({
      allowed: true,
      usageLimitMicros: null,
    });
  });
});
