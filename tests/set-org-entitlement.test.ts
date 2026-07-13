import { describe, expect, test } from "bun:test";

import {
  assertMutationAuthorized,
  parseEntitlementArgs,
} from "@/../scripts/set-org-entitlement";

describe("set organization entitlement CLI", () => {
  test("parses a complete dry-run without requiring mutation confirmation", () => {
    expect(
      parseEntitlementArgs([
        "--org",
        "acme",
        "--mode",
        "byok",
        "--status",
        "active",
        "--actor",
        "ops@example.com",
        "--included-usage-cents",
        "1000",
        "--overage-hard-cap-cents",
        "500",
        "--promotional-eligible",
        "--dry-run",
      ]),
    ).toMatchObject({
      org: "acme",
      mode: "byok",
      status: "active",
      actor: "ops@example.com",
      includedUsageCents: 1_000,
      overageHardCapCents: 500,
      promotionalEligible: true,
      dryRun: true,
      yes: false,
    });
  });

  test("rejects invalid lifecycle values and verified contacts without an email", () => {
    expect(() =>
      parseEntitlementArgs([
        "--org", "acme", "--mode", "hosted", "--status", "trial", "--actor", "ops",
      ]),
    ).toThrow("--status must be active, trialing, past_due, or suspended");
    expect(() =>
      parseEntitlementArgs([
        "--org", "acme", "--mode", "hosted", "--status", "active", "--actor", "ops",
        "--billing-contact-verified-at", "2026-07-12T00:00:00Z",
        "--included-usage-cents", "600",
      ]),
    ).toThrow("requires --billing-contact-email");
  });

  test("requires both --yes and an exact organization confirmation for mutation", () => {
    const base = parseEntitlementArgs([
      "--org", "acme", "--mode", "hosted", "--status", "active", "--actor", "ops",
      "--included-usage-cents", "600",
    ]);
    expect(() => assertMutationAuthorized(base)).toThrow("refusing to mutate acme");
    expect(() =>
      assertMutationAuthorized({ ...base, yes: true, confirmOrg: "other" }),
    ).toThrow("refusing to mutate acme");
    expect(() =>
      assertMutationAuthorized({ ...base, yes: true, confirmOrg: "acme" }),
    ).not.toThrow();
    expect(() => assertMutationAuthorized({ ...base, dryRun: true })).not.toThrow();
  });

  test("defaults hosted overage to zero and permits an uncapped BYOK provider budget", () => {
    const hosted = parseEntitlementArgs([
      "--org", "acme", "--mode", "hosted", "--status", "active", "--actor", "ops",
      "--included-usage-cents", "600",
    ]);
    const byok = parseEntitlementArgs([
      "--org", "acme", "--mode", "byok", "--status", "active", "--actor", "ops",
    ]);
    expect(hosted.overageHardCapCents).toBe(0);
    expect(byok.overageHardCapCents).toBeNull();
  });

  test("rejects hosted activation without a positive explicit allowance", () => {
    expect(() =>
      parseEntitlementArgs([
        "--org", "acme", "--mode", "hosted", "--status", "active", "--actor", "ops",
      ]),
    ).toThrow("requires --included-usage-cents of at least 100");
    expect(() =>
      parseEntitlementArgs([
        "--org", "acme", "--mode", "hosted", "--status", "past_due", "--actor", "ops",
        "--promotional-eligible",
      ]),
    ).toThrow("requires --included-usage-cents of at least 100");
  });
});
