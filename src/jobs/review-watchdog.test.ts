import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  staleReviews: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}));

const githubMock = vi.hoisted(() => ({
  installationOctokit: vi.fn(async () => ({ request: githubMock.request })),
  request: vi.fn(async () => ({ data: {} })),
}));

const posthogMock = vi.hoisted(() => ({
  captureException: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbMock.staleReviews,
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          dbMock.updates.push(values);
        },
      }),
    }),
  }),
  schema: {
    reviews: {
      id: "id",
      installationId: "installationId",
      repoFullName: "repoFullName",
      pullNumber: "pullNumber",
      headSha: "headSha",
      checkRunId: "checkRunId",
      createdAt: "createdAt",
      status: "status",
    },
  },
}));

vi.mock("@/lib/github", () => ({
  installationOctokit: githubMock.installationOctokit,
}));

vi.mock("@/lib/posthog", () => posthogMock);

const { completeStaleReviewCheckRuns } = await import("./review-watchdog");

describe("review watchdog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.staleReviews = [];
    dbMock.updates = [];
  });

  it("completes stale running app check-runs as failed", async () => {
    dbMock.staleReviews = [
      {
        id: "review-1",
        installationId: 123,
        repoFullName: "postil-dev/postil",
        pullNumber: 162,
        headSha: "abc123",
        checkRunId: 456,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ];

    const result = await completeStaleReviewCheckRuns({ staleAfterMs: 1, limit: 10 });

    expect(result).toMatchObject({ scanned: 1, completed: 1, failed: 0 });
    expect(githubMock.installationOctokit).toHaveBeenCalledWith(123);
    expect(githubMock.request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        owner: "postil-dev",
        repo: "postil",
        check_run_id: 456,
        status: "completed",
        conclusion: "failure",
        output: expect.objectContaining({
          summary: "Review timed out before completion.",
        }),
      }),
    );
    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        errorMessage: "Review timed out before completion.",
      }),
    );
  });

  it("keeps processing when one stale check-run cannot be patched", async () => {
    dbMock.staleReviews = [
      {
        id: "review-1",
        installationId: 123,
        repoFullName: "postil-dev/postil",
        pullNumber: 162,
        headSha: "abc123",
        checkRunId: 456,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ];
    githubMock.request.mockRejectedValueOnce(new Error("patch failed"));

    const result = await completeStaleReviewCheckRuns({ staleAfterMs: 1, limit: 10 });

    expect(result).toMatchObject({ scanned: 1, completed: 0, failed: 1 });
    expect(posthogMock.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        properties: expect.objectContaining({
          op: "review_watchdog_complete_stale_check",
          checkRunId: 456,
        }),
      }),
    );
  });
});
