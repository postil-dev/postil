import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  staleReviews: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  updateWheres: [] as Array<unknown>,
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
        where: async (condition: unknown) => {
          dbMock.updates.push(values);
          dbMock.updateWheres.push(condition);
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
    dbMock.updateWheres = [];
  });

  it("completes stale running app check-runs as neutral", async () => {
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
        conclusion: "neutral",
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
    expect(JSON.stringify(dbMock.updateWheres)).toContain("running");
  });

  it("does not patch GitHub when the repo full name is invalid", async () => {
    dbMock.staleReviews = [
      {
        id: "review-1",
        installationId: 123,
        repoFullName: "postil-dev",
        pullNumber: 162,
        headSha: "abc123",
        checkRunId: 456,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ];

    const result = await completeStaleReviewCheckRuns({ staleAfterMs: 1, limit: 10 });

    expect(result).toMatchObject({ scanned: 1, completed: 0, failed: 1 });
    expect(githubMock.installationOctokit).not.toHaveBeenCalled();
    expect(githubMock.request).not.toHaveBeenCalled();
    expect(dbMock.updates).toHaveLength(0);
    expect(posthogMock.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        properties: expect.objectContaining({
          op: "review_watchdog_complete_stale_check",
          repoFullName: "postil-dev",
          checkRunId: 456,
        }),
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
