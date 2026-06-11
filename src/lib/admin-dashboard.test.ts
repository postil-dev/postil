import { describe, expect, it } from "vitest";
import { sanitizeMetadata, summarizeAdminDashboard, toAdminTriggerPath } from "./admin-dashboard";

const baseRow = {
  id: "metric-1",
  reviewId: "review-1",
  organizationId: "org-1",
  installationId: 123,
  repoFullName: "postil-dev/postil",
  pullNumber: 42,
  headSha: "abc123",
  checkRunId: 456,
  triggerRunId: "run-1",
  workflowRunId: 789,
  triggerPath: "hosted_pull_request",
  status: "completed",
  conclusion: "success",
  failureClass: null,
  startedAt: new Date("2026-06-10T12:00:00Z"),
  completedAt: new Date("2026-06-10T12:00:03Z"),
  latencyMs: 3000,
  timeoutMs: 120000,
  modelProvider: "openrouter",
  modelUsed: "test/model",
  modelCascade: null,
  promptTokens: 100,
  completionTokens: 40,
  totalTokens: 140,
  fallbackUsed: false,
  cliVersion: "1.0.0",
  actionVersion: "v1",
  hostedAppVersion: "abc",
  findingCount: 2,
  errorFindingCount: 1,
  warnFindingCount: 1,
  infoFindingCount: 0,
  inlineCommentCount: 1,
  postedCommentCount: 1,
  suppressedCleanComment: false,
  rerun: false,
  replay: false,
  metadata: {
    deliveryId: "delivery-1",
    token: "secret-value",
    nested: { apiKey: "secret-value", safe: "visible" },
  },
  createdAt: new Date("2026-06-10T12:00:04Z"),
};

describe("admin dashboard", () => {
  it("redacts secret-shaped metadata keys", () => {
    expect(sanitizeMetadata(baseRow.metadata)).toEqual({
      deliveryId: "delivery-1",
      token: "[redacted]",
      nested: { apiKey: "[redacted]", safe: "visible" },
    });
  });

  it("summarizes operational totals and failure groups", () => {
    const dashboard = summarizeAdminDashboard([
      baseRow,
      {
        ...baseRow,
        id: "metric-2",
        status: "failed",
        conclusion: "failure",
        failureClass: "github_api",
        latencyMs: 9000,
        suppressedCleanComment: true,
        totalTokens: 300,
        createdAt: new Date("2026-06-10T13:00:00Z"),
      },
    ]);

    expect(dashboard.totals).toMatchObject({
      installs: 1,
      repositories: 1,
      reviews: 2,
      failures: 1,
      findings: 4,
      suppressedCleanComments: 1,
      totalTokens: 440,
      averageLatencyMs: 6000,
    });
    expect(dashboard.failures[0]).toMatchObject({
      failureClass: "github_api",
      count: 1,
      nextAction: "Review GitHub API status, rate limits, and linked check run.",
    });
    expect(dashboard.reviews[0]?.metadataPreview).toMatchObject({
      token: "[redacted]",
    });
  });

  it("falls back unknown trigger paths to hosted pull request", () => {
    expect(toAdminTriggerPath("legacy_webhook")).toBe("hosted_pull_request");
  });
});
