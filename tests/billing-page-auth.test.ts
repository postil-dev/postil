import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import * as billingUsage from "@/lib/billing-usage";
import type { PrivateRepositoryAccessDecision } from "@/lib/private-repository-entitlement";

let role = "member";
let privateAccessDecision: PrivateRepositoryAccessDecision;

const eventRows = [
  {
    id: 1,
    repositoryId: 30,
    githubRepoId: 1001,
    repositoryFullName: "acme/public",
    repositoryPrivate: false,
    action: "enable",
    source: "migration_baseline",
    occurredAt: new Date("2026-06-20T00:00:00.000Z"),
  },
  {
    id: 2,
    repositoryId: 31,
    githubRepoId: 1002,
    repositoryFullName: "acme/private",
    repositoryPrivate: true,
    action: "enable",
    source: "dashboard",
    occurredAt: new Date("2026-07-03T00:00:00.000Z"),
  },
  {
    id: 3,
    repositoryId: 31,
    githubRepoId: 1002,
    repositoryFullName: "acme/private",
    repositoryPrivate: true,
    action: "disable",
    source: "dashboard",
    occurredAt: new Date("2026-07-06T12:00:00.000Z"),
  },
  {
    id: 4,
    repositoryId: 31,
    githubRepoId: 1002,
    repositoryFullName: "acme/private",
    repositoryPrivate: true,
    action: "enable",
    source: "dashboard",
    occurredAt: new Date("2026-07-09T00:00:00.000Z"),
  },
  {
    id: 5,
    repositoryId: 32,
    githubRepoId: 1003,
    repositoryFullName: "acme/disabled",
    repositoryPrivate: false,
    action: "enable",
    source: "dashboard",
    occurredAt: new Date("2026-07-02T00:00:00.000Z"),
  },
  {
    id: 6,
    repositoryId: 32,
    githubRepoId: 1003,
    repositoryFullName: "acme/disabled",
    repositoryPrivate: false,
    action: "disable",
    source: "dashboard",
    occurredAt: new Date("2026-07-04T00:00:00.000Z"),
  },
];

const currentRepoRows = [
  { id: 30, fullName: "acme/public", private: false },
  { id: 31, fullName: "acme/private-now", private: true },
  { id: 32, fullName: "acme/disabled", private: false },
];
const creditGrantRows = [
  {
    id: 70,
    amountCents: 20_000,
    reason: "Owner credit grant",
    actor: "billing-admin",
    source: "admin_script",
    idempotencyKey: "acme-2026-07-owner-credit",
    appliesAt: new Date("2026-07-11T00:00:00.000Z"),
    createdAt: new Date("2026-07-11T01:00:00.000Z"),
  },
];
const usageRows = [
  {
    id: 80,
    promptTokens: 10_000_000,
    completionTokens: 1_000_000,
    modelUsed: "deepseek/deepseek-v4-pro",
    costMicros: 5_220_000,
    createdAt: new Date("2026-07-11T12:00:00.000Z"),
  },
];

mock.module("@/lib/billing-usage", () => ({
  ...billingUsage,
  currentMonthBillingPeriod: () => ({
    start: new Date("2026-07-01T00:00:00.000Z"),
    end: new Date("2026-07-11T00:00:00.000Z"),
  }),
}));

mock.module("@/lib/private-repository-entitlement", () => ({
  canProcessPrivateRepository: async () => privateAccessDecision,
  requireMatchingProviderMode: (decision: unknown) => decision,
}));

mock.module("@/lib/org-access", () => ({
  requireOrgMembership: async () => ({
    db: fakeDb(),
    user: { id: 7, login: "octocat" },
    org: { id: 20, slug: "acme", name: "Acme", plan: "beta" },
    membership: { id: 1, role },
  }),
  getOrgMembership: async () => ({
    ok: true,
    db: fakeDb(),
    user: { id: 7, login: "octocat" },
    org: { id: 20, slug: "acme", name: "Acme", plan: "beta" },
    membership: { id: 1, role },
  }),
}));

const { default: OrgBillingPage } =
  await import("@/app/orgs/[slug]/billing/page");

beforeEach(() => {
  role = "member";
  privateAccessDecision = {
    allowed: false,
    reason: "no_entitlement",
    entitlement: null,
    usageMicros: 0n,
    usageLimitMicros: null,
  };
});

describe("organization billing page auth", () => {
  test("denies non-admin members before loading billing data", async () => {
    await expect(
      OrgBillingPage({
        params: Promise.resolve({ slug: "acme" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("this page requires an organization admin");
  });

  test("renders public-only billing state and current coverage", async () => {
    role = "admin";

    const page = await OrgBillingPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Repositories are not billing units");
    expect(markup).toContain("for public repositories");
    expect(markup).toContain("enabled, with no per-repo fee");
    expect(markup).toContain("Private repository access");
    expect(markup).toContain("Public only");
    expect(markup).toContain("public · free");
    expect(markup).toContain("$0");
    expect(markup).toContain("Start 30-day trial");
    expect(markup).not.toContain("billing contact: not set");
    expect(markup).not.toContain("included usage: $0.00");
    expect(markup).not.toContain("overage hard cap: not set");
    expect(markup).toContain("Private authors");
    expect(markup).toContain("reviewed on private PRs this period");
    expect(markup).not.toContain("$194.78");
    expect(markup).not.toContain("remaining from $200.00 granted");
    expect(markup).not.toContain("$5.22 charged across");
    expect(markup).not.toContain("Owner credit grant");
    expect(markup).not.toContain("acme-2026-07-owner-credit");
    expect(markup).toContain("acme/public");
    expect(markup).toContain("acme/private-now");
    expect(markup).toContain("Jun 20, 2026");
    expect(markup).toContain("Jul 9, 2026");
    expect(markup).not.toContain("Repository coverage history");
    expect(markup).toContain("/orgs/acme/settings/audit");
  });

  test("states the exact no-card trial boundary and consequence", async () => {
    role = "admin";
    privateAccessDecision = entitlementDecision(
      "active_trial",
      "trialing",
      new Date("2099-08-17T12:00:00.000Z"),
    );

    const page = await OrgBillingPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Free trial active");
    expect(markup).toContain('data-trial-state="active"');
    expect(markup).toContain('dateTime="2099-08-17T12:00:00.000Z"');
    expect(markup).toContain("No card is required");
    expect(markup).toContain("then pause unless a paid plan is active");
    expect(markup).toContain("Email preferences");
    expect(markup).toContain("Billing summaries");
    expect(markup).toContain("Service summaries");
    expect(markup).toContain(
      "These preferences do not apply to security, verification, payment failure",
    );
    expect(markup).toContain('name="billingSummaryEmail" value="on"');
    expect(markup).toMatch(
      /name="serviceSummaryEmail" checked="" value="on"/,
    );
  });

  test("explains why private reviews pause after trial expiry", async () => {
    role = "admin";
    privateAccessDecision = entitlementDecision(
      "inactive",
      "past_due",
      new Date("2026-07-17T12:00:00.000Z"),
    );

    const page = await OrgBillingPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Private access paused");
    expect(markup).toContain('data-trial-state="ended"');
    expect(markup).toContain('dateTime="2026-07-17T12:00:00.000Z"');
    expect(markup).toContain(
      "Private reviews are paused until a paid plan is active",
    );
  });
});

function entitlementDecision(
  reason: "active_trial" | "inactive",
  status: "trialing" | "past_due",
  trialEndsAt: Date,
): PrivateRepositoryAccessDecision {
  return {
    allowed: reason === "active_trial",
    reason,
    entitlement: {
      subscriptionMode: "byok",
      status,
      trialEndsAt,
      pastDueGraceEndsAt: null,
      periodStartsAt: new Date("2026-07-18T12:00:00.000Z"),
      periodEndsAt: trialEndsAt,
      includedUsageMicros: 100_000_000n,
      overageHardCapMicros: 0n,
      promotionalEligible: false,
      promotionalEndsAt: null,
      billingContactEmail: null,
      billingContactVerifiedAt: null,
    },
    usageMicros: 0n,
    usageLimitMicros: null,
  };
}

function fakeDb(): any {
  return {
    select(selection: Record<string, unknown>) {
      const kind =
        "hasKey" in selection
          ? "provider"
          : "billingSummaryEmail" in selection
            ? "notificationPreferences"
          : "activeEmail" in selection
            ? "contact"
            : "status" in selection && "currentPeriodEndsAt" in selection
              ? "subscription"
              : "count" in selection
                ? "activeAuthors"
                : "repositoryFullName" in selection
                  ? "events"
                  : "amountCents" in selection
                    ? "credits"
                    : "promptTokens" in selection
                      ? "usage"
                      : "repositories";
      const rows =
        kind === "activeAuthors"
          ? [{ count: 3 }]
          : kind === "events"
            ? eventRows
            : kind === "credits"
              ? creditGrantRows
              : kind === "usage"
                ? usageRows
                : kind === "provider"
                  ? [{ hasKey: false }]
                  : kind === "notificationPreferences"
                    ? [{ billingSummaryEmail: false, serviceSummaryEmail: true }]
                  : kind === "contact"
                    ? [
                        {
                          activeEmail: null,
                          pendingEmail: null,
                          verifiedAt: null,
                        },
                      ]
                    : kind === "subscription"
                      ? []
                      : currentRepoRows;
      const chain = {
        from() {
          return chain;
        },
        innerJoin() {
          return chain;
        },
        where() {
          return kind === "repositories" || kind === "activeAuthors"
            ? Promise.resolve(rows)
            : chain;
        },
        orderBy() {
          return Promise.resolve(rows);
        },
        limit() {
          return Promise.resolve(rows);
        },
      };
      return chain;
    },
  };
}
