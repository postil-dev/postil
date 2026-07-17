import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import * as billingUsage from "@/lib/billing-usage";

let role = "member";

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
  canProcessPrivateRepository: async () => ({
    allowed: false,
    reason: "no_entitlement",
    entitlement: null,
    usageMicros: 0,
    usageLimitMicros: null,
  }),
  requireMatchingProviderMode: (decision: unknown) => decision,
}));

mock.module("@/lib/org-access", () => ({
  requireOrgMembership: async () => ({
    db: fakeDb(),
    org: { id: 20, slug: "acme", name: "Acme", plan: "beta" },
    membership: { id: 1, role },
  }),
}));

const { default: OrgBillingPage } = await import("@/app/orgs/[slug]/billing/page");

beforeEach(() => {
  role = "member";
});

describe("organization billing page auth", () => {
  test("denies non-admin members before loading billing data", async () => {
    await expect(OrgBillingPage({ params: Promise.resolve({ slug: "acme" }), searchParams: Promise.resolve({}) })).rejects.toThrow(
      "this page requires an organization admin",
    );
  });

  test("renders public-only billing state, usage, credits, and current coverage", async () => {
    role = "admin";

    const page = await OrgBillingPage({ params: Promise.resolve({ slug: "acme" }), searchParams: Promise.resolve({}) });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Repositories are not billing units");
    expect(markup).toContain("for public repositories");
    expect(markup).toContain("enabled, with no per-repo fee");
    expect(markup).toContain("Private repository access");
    expect(markup).toContain("Public only");
    expect(markup).toContain("public · free");
    expect(markup).toContain("$0");
    expect(markup).toContain("Contact us to activate");
    expect(markup).not.toContain("billing contact: not set");
    expect(markup).not.toContain("included usage: $0.00");
    expect(markup).not.toContain("overage hard cap: not set");
    expect(markup).toContain("Private authors");
    expect(markup).toContain("reviewed on private PRs this period");
    expect(markup).toContain("$194.78");
    expect(markup).toContain("remaining from $200.00 granted");
    expect(markup).toContain("$5.22 charged across");
    expect(markup).toContain("Available after a hosted private plan is active");
    expect(markup).toContain("Owner credit grant");
    expect(markup).toContain("acme-2026-07-owner-credit");
    expect(markup).toContain("acme/public");
    expect(markup).toContain("acme/private-now");
    expect(markup).toContain("Jun 20, 2026");
    expect(markup).toContain("Jul 9, 2026");
    expect(markup).not.toContain("Repository coverage history");
    expect(markup).toContain("/orgs/acme/settings/audit");
  });
});

function fakeDb(): any {
  return {
    select(selection: Record<string, unknown>) {
      const kind =
        "hasKey" in selection
          ? "provider"
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
