import { describe, expect, it } from "vitest";
import { summarizeDashboard } from "./dashboard";

const baseMetric = {
  id: "metric-1",
  reviewId: "review-1",
  repoFullName: "postil-dev/postil",
  pullNumber: 42,
  headSha: "abc123",
  triggerPath: "hosted_pull_request",
  status: "completed",
  conclusion: "success",
  failureClass: null,
  latencyMs: 1200,
  findingCount: 2,
  errorFindingCount: 1,
  warnFindingCount: 1,
  infoFindingCount: 0,
  suppressedCleanComment: false,
  checkRunId: 123,
  workflowRunId: null,
  createdAt: new Date("2026-06-10T12:00:00Z"),
};

describe("customer dashboard summaries", () => {
  it("aggregates repository state from organization-scoped review metrics", () => {
    const dashboard = summarizeDashboard({
      organization: {
        id: "org-1",
        slug: "postil-dev",
        name: "Postil Dev",
        githubLogin: "postil-dev",
        plan: "free",
      },
      installations: [],
      metrics: [
        baseMetric,
        {
          ...baseMetric,
          id: "metric-2",
          reviewId: "review-2",
          triggerPath: "hosted_mention",
          status: "failed",
          conclusion: "failure",
          failureClass: "config",
          suppressedCleanComment: true,
          createdAt: new Date("2026-06-10T13:00:00Z"),
        },
      ],
    });

    expect(dashboard.totals).toEqual({
      reviews: 2,
      repositories: 1,
      findings: 4,
      suppressedCleanComments: 1,
      failures: 1,
    });
    expect(dashboard.repositories[0]).toMatchObject({
      repoFullName: "postil-dev/postil",
      status: "failing",
      lastTriggerPath: "hosted_mention",
      reviewCount: 2,
      configHealth: "attention",
    });
  });

  it("falls back to hosted review labels for unknown trigger values", () => {
    const dashboard = summarizeDashboard({
      organization: null,
      installations: [],
      metrics: [{ ...baseMetric, triggerPath: "legacy_webhook" }],
    });

    expect(dashboard.reviews[0]?.triggerPath).toBe("hosted_pull_request");
    expect(dashboard.repositories[0]?.lastTriggerPath).toBe("hosted_pull_request");
  });
});
