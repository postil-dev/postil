import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequest = vi.fn();
const dbMock = vi.hoisted(() => ({
  webhookDeliveries: {},
  reviews: {},
  insertCalls: [] as unknown[],
  deleteCalls: [] as unknown[],
  updateCalls: [] as Array<Record<string, unknown>>,
  reviewInsertResult: [{ id: "review-1" }],
  findFirst: vi.fn(async () => undefined),
  failTriggerRunIdUpdate: false,
  failFailedStatusUpdate: false,
  failDeliveryDelete: false,
}));
const reviewJobMock = vi.hoisted(() => ({
  enqueueReviewPullRequest: vi.fn(async () => ({ id: "trigger-run-123" })),
}));
const configMock = vi.hoisted(() => ({
  review: {
    auto_merge: true,
  },
}));
const POSTIL_REVIEW_WORKFLOW_PATH = ".github/workflows/postil-review.yml";
const posthogMock = vi.hoisted(() => ({
  captureException: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  env: {
    CI_RECOVERY_FALLBACK_ASSIGNEE: "engineer",
    GITHUB_WEBHOOK_SECRET: "test-secret",
  },
}));

vi.mock("@/db", () => ({
  getDb: () => ({
    insert: (table: unknown) => {
      dbMock.insertCalls.push(table);
      if (table === dbMock.webhookDeliveries) {
        return { values: async () => undefined };
      }
      return {
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => dbMock.reviewInsertResult,
          }),
        }),
      };
    },
    delete: (table: unknown) => {
      dbMock.deleteCalls.push(table);
      return {
        where: async () => {
          if (dbMock.failDeliveryDelete && table === dbMock.webhookDeliveries) {
            throw new Error("delete failed");
          }
          return undefined;
        },
      };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          dbMock.updateCalls.push(values);
          if (dbMock.failFailedStatusUpdate && values.status === "failed") {
            throw new Error("failed status update failed");
          }
          if (dbMock.failTriggerRunIdUpdate && "triggerRunId" in values) {
            throw new Error("trigger run update failed");
          }
          return undefined;
        },
      }),
    }),
    query: { reviews: { findFirst: dbMock.findFirst } },
  }),
  schema: { webhookDeliveries: dbMock.webhookDeliveries, reviews: dbMock.reviews },
}));

vi.mock("@/lib/config", () => ({
  loadReviewConfig: vi.fn(async () => ({
    config: {
      enabled: true,
      ignore: [],
      severityThreshold: "info",
      maxFindings: 25,
      reviewer: { tone: "neutral", focus: [] },
      review: { ...configMock.review },
    },
    source: ".postil.yaml",
  })),
}));

vi.mock("@/lib/github", () => ({
  appOctokit: vi.fn().mockReturnValue({
    request: mockRequest,
  }),
  installationOctokit: vi.fn(async () => ({ request: mockRequest })),
}));

vi.mock("@/jobs/review-pull-request", () => reviewJobMock);

vi.mock("@/lib/posthog", () => ({
  captureException: posthogMock.captureException,
  track: posthogMock.track,
}));

// Import after mock declarations so the route uses the stubs above.
const { POST } = await import("./route");

function sign(secret: string, body: string): string {
  const h = crypto.createHmac("sha256", secret);
  h.update(body);
  return `sha256=${h.digest("hex")}`;
}

function signedRequest(event: string, deliveryId: string, payload: unknown): Request {
  const body = JSON.stringify(payload);
  return new Request("http://x/webhook", {
    method: "POST",
    body,
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "x-hub-signature-256": sign("test-secret", body),
    },
  });
}

describe("github webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.insertCalls = [];
    dbMock.deleteCalls = [];
    dbMock.updateCalls = [];
    dbMock.failTriggerRunIdUpdate = false;
    dbMock.failFailedStatusUpdate = false;
    dbMock.failDeliveryDelete = false;
    configMock.review = { auto_merge: true };
  });

  it("rejects missing signature", async () => {
    const body = JSON.stringify({ zen: "hi" });
    const res = await POST(
      new Request("http://x/webhook", {
        method: "POST",
        body,
        headers: { "x-github-delivery": "a", "x-github-event": "ping" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid signed ping", async () => {
    const body = JSON.stringify({ zen: "hi" });
    const res = await POST(signedRequest("ping", "b", JSON.parse(body)));
    expect(res.status).toBe(200);
  });

  it("enqueues review work through the runner for opened pull requests", async () => {
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        return { data: { id: 321 } };
      }
      return { data: [] };
    });

    const res = await POST(
      signedRequest("pull_request", "pr-opened", {
        action: "opened",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        pull_request: {
          number: 68,
          draft: false,
          head: { sha: "abc123def456" },
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(reviewJobMock.enqueueReviewPullRequest).toHaveBeenCalledWith(
      {
        installationId: 123,
        repoFullName: "acme/widget",
        pullNumber: 68,
        headSha: "abc123def456",
        checkRunId: 321,
        reviewId: "review-1",
      },
      "pr-opened",
    );
    expect(dbMock.insertCalls).toEqual([dbMock.webhookDeliveries, dbMock.reviews]);
    expect(dbMock.updateCalls).toContainEqual({ triggerRunId: "trigger-run-123" });
  });

  it("enqueues review work when @postil is mentioned on a PR conversation", async () => {
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return { data: { draft: false, head: { sha: "mention-sha" } } };
      }
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        return { data: { id: 654 } };
      }
      return { data: [] };
    });

    const res = await POST(
      signedRequest("issue_comment", "mention-comment", {
        action: "created",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        issue: {
          number: 68,
          pull_request: { url: "https://api.github.com/repos/acme/widget/pulls/68" },
        },
        comment: { body: "@postil take another look at this auth path" },
      }),
    );

    expect(res.status).toBe(200);
    expect(reviewJobMock.enqueueReviewPullRequest).toHaveBeenCalledWith(
      {
        installationId: 123,
        repoFullName: "acme/widget",
        pullNumber: 68,
        headSha: "mention-sha",
        checkRunId: 654,
        reviewId: "review-1",
      },
      "mention-comment",
    );
    expect(posthogMock.track).toHaveBeenCalledWith(
      "system",
      "review_mentioned",
      expect.objectContaining({
        repoFullName: "acme/widget",
        pullNumber: 68,
        event: "issue_comment",
      }),
    );
  });

  it("ignores @postil issue comments that are not attached to a PR", async () => {
    const res = await POST(
      signedRequest("issue_comment", "mention-issue", {
        action: "created",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        issue: { number: 12 },
        comment: { body: "@postil please help" },
      }),
    );

    expect(res.status).toBe(200);
    expect(reviewJobMock.enqueueReviewPullRequest).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.anything(),
    );
  });

  it("ignores PR comments that do not mention @postil", async () => {
    const res = await POST(
      signedRequest("issue_comment", "ordinary-comment", {
        action: "created",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        issue: {
          number: 68,
          pull_request: { url: "https://api.github.com/repos/acme/widget/pulls/68" },
        },
        comment: { body: "This is ready for another human pass." },
      }),
    );

    expect(res.status).toBe(200);
    expect(reviewJobMock.enqueueReviewPullRequest).not.toHaveBeenCalled();
  });

  it("keeps the delivery log open when enqueue fails", async () => {
    reviewJobMock.enqueueReviewPullRequest.mockRejectedValueOnce(new Error("trigger failed"));
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        return { data: { id: 321 } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        return { data: { id: 321 } };
      }
      return { data: [] };
    });

    await expect(
      POST(
        signedRequest("pull_request", "pr-failed", {
          action: "opened",
          installation: { id: 123 },
          repository: { full_name: "acme/widget" },
          pull_request: {
            number: 68,
            draft: false,
            head: { sha: "abc123def456" },
          },
        }),
      ),
    ).rejects.toThrow("trigger failed");
    expect(dbMock.insertCalls).toEqual([dbMock.webhookDeliveries, dbMock.reviews]);
    expect(dbMock.deleteCalls).toEqual([dbMock.webhookDeliveries]);
    expect(
      mockRequest.mock.calls.some(
        ([route]) => route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      ),
    ).toBe(true);
  });

  it("fails dispatch and allows retry when the review check-run cannot be created", async () => {
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        throw new Error("checks permission missing");
      }
      return { data: [] };
    });

    await expect(
      POST(
        signedRequest("pull_request", "pr-check-run-failed", {
          action: "opened",
          installation: { id: 123 },
          repository: { full_name: "acme/widget" },
          pull_request: {
            number: 68,
            draft: false,
            head: { sha: "abc123def456" },
          },
        }),
      ),
    ).rejects.toThrow("checks permission missing");

    expect(reviewJobMock.enqueueReviewPullRequest).not.toHaveBeenCalled();
    expect(dbMock.deleteCalls).toEqual([dbMock.webhookDeliveries]);
    expect(dbMock.updateCalls).toContainEqual(
      expect.objectContaining({
        status: "failed",
        errorMessage: "checks permission missing",
      }),
    );
    expect(posthogMock.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        properties: expect.objectContaining({
          op: "create_check_run",
          repoFullName: "acme/widget",
          pullNumber: 68,
          headSha: "abc123def456",
        }),
      }),
    );
  });

  it("does not fail dispatch when post-enqueue bookkeeping fails", async () => {
    dbMock.failTriggerRunIdUpdate = true;
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        return { data: { id: 321 } };
      }
      return { data: [] };
    });

    const res = await POST(
      signedRequest("pull_request", "pr-bookkeeping", {
        action: "opened",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        pull_request: {
          number: 68,
          draft: false,
          head: { sha: "abc123def456" },
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(reviewJobMock.enqueueReviewPullRequest).toHaveBeenCalledWith(
      {
        installationId: 123,
        repoFullName: "acme/widget",
        pullNumber: 68,
        headSha: "abc123def456",
        checkRunId: 321,
        reviewId: "review-1",
      },
      "pr-bookkeeping",
    );
    expect(dbMock.deleteCalls).toEqual([]);
    expect(posthogMock.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        properties: expect.objectContaining({
          op: "record_trigger_run_id",
          repoFullName: "acme/widget",
          pullNumber: 68,
        }),
      }),
    );
  });

  it("bubbles delivery-delete failures after an enqueue error", async () => {
    dbMock.failDeliveryDelete = true;
    reviewJobMock.enqueueReviewPullRequest.mockRejectedValueOnce(new Error("trigger failed"));
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        return { data: { id: 321 } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        return { data: { id: 321 } };
      }
      return { data: [] };
    });

    await expect(
      POST(
        signedRequest("pull_request", "pr-delete-failed", {
          action: "opened",
          installation: { id: 123 },
          repository: { full_name: "acme/widget" },
          pull_request: {
            number: 68,
            draft: false,
            head: { sha: "abc123def456" },
          },
        }),
      ),
    ).rejects.toThrow("trigger failed");
    expect(dbMock.deleteCalls).toEqual([dbMock.webhookDeliveries]);
  });

  it("still deletes the delivery log when recording dispatch failure metadata fails", async () => {
    dbMock.failFailedStatusUpdate = true;
    reviewJobMock.enqueueReviewPullRequest.mockRejectedValueOnce(new Error("trigger failed"));
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        return { data: { id: 321 } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        return { data: { id: 321 } };
      }
      return { data: [] };
    });

    await expect(
      POST(
        signedRequest("pull_request", "pr-status-update-failed", {
          action: "opened",
          installation: { id: 123 },
          repository: { full_name: "acme/widget" },
          pull_request: {
            number: 68,
            draft: false,
            head: { sha: "abc123def456" },
          },
        }),
      ),
    ).rejects.toThrow("trigger failed");
    expect(dbMock.deleteCalls).toEqual([dbMock.webhookDeliveries]);
    expect(posthogMock.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        properties: expect.objectContaining({
          op: "record_dispatch_failed",
        }),
      }),
    );
  });

  it("creates one recovery issue for a failed pull request workflow run", async () => {
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "GET /search/issues") {
        return { data: { total_count: 0 } };
      }
      if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") {
        return {
          data: {
            jobs: [
              {
                id: 200,
                name: "Build",
                conclusion: "success",
              },
              {
                id: 404,
                name: "Docker build",
                conclusion: "failure",
                steps: [{ name: "Install dependencies", conclusion: "failure" }],
              },
            ],
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs") {
        return {
          data: [
            "Run bun install --frozen-lockfile",
            'error: Module not found "scripts/install-hooks.ts"',
            'error: script "postinstall" exited with code 1',
          ].join("\n"),
        };
      }
      if (route === "GET /repos/{owner}/{repo}/collaborators/{username}/permission") {
        return { data: { permission: "write" } };
      }
      if (route === "POST /repos/{owner}/{repo}/issues") {
        return { data: { number: 99 } };
      }
      throw new Error(`unexpected route ${route}`);
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-failure", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow_run: {
          id: 987,
          name: "CI",
          conclusion: "failure",
          html_url: "https://github.com/acme/widget/actions/runs/987",
          head_branch: "feat/review-always-post-review",
          actor: { login: "branch-owner" },
          pull_requests: [{ number: 68 }],
        },
      }),
    );

    expect(res.status).toBe(200);
    const issueCall = mockRequest.mock.calls.find(
      ([route]) => route === "POST /repos/{owner}/{repo}/issues",
    );
    expect(issueCall).toBeTruthy();
    expect(issueCall?.[1]).toMatchObject({
      owner: "acme",
      repo: "widget",
      assignees: ["branch-owner"],
      labels: ["ci", "recovery"],
    });
    expect(issueCall?.[1].title).toContain("Docker build");
    expect(issueCall?.[1].body).toContain("PR: #68");
    expect(issueCall?.[1].body).toContain("Branch: feat/review-always-post-review");
    expect(issueCall?.[1].body).toContain("Failing check: Docker build / Install dependencies");
    expect(issueCall?.[1].body).toContain("Module not found");
    expect(issueCall?.[1].body).toContain("Work on the pull request branch");
    expect(issueCall?.[1].body).toContain("Root-cause guess:");
  });

  it("falls back when the branch owner is not writable", async () => {
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "GET /search/issues") {
        return { data: { total_count: 0 } };
      }
      if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs") {
        return {
          data: {
            jobs: [
              { id: 200, name: "Build", conclusion: "success" },
              { id: 404, name: "Docker build", conclusion: "failure" },
            ],
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs") {
        return { data: "fatal: docker build failed" };
      }
      if (route === "GET /repos/{owner}/{repo}/collaborators/{username}/permission") {
        return { data: { permission: "read" } };
      }
      if (route === "POST /repos/{owner}/{repo}/issues") {
        return { data: { number: 99 } };
      }
      throw new Error(`unexpected route ${route}`);
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-fallback", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow_run: {
          id: 987,
          name: "CI",
          conclusion: "failure",
          html_url: "https://github.com/acme/widget/actions/runs/987",
          head_branch: "feat/review-always-post-review",
          actor: { login: "read-only-user" },
          pull_requests: [{ number: 68 }],
        },
      }),
    );

    expect(res.status).toBe(200);
    const issueCall = mockRequest.mock.calls.find(
      ([route]) => route === "POST /repos/{owner}/{repo}/issues",
    );
    expect(issueCall?.[1]).toMatchObject({
      assignees: ["engineer"],
    });
    expect(issueCall?.[1].title).toContain("Docker build");
  });

  it("completes the app review check when the review workflow succeeds", async () => {
    dbMock.findFirst.mockResolvedValueOnce({ id: "review-1", checkRunId: 321 } as never);
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        return { data: { id: 321 } };
      }
      throw new Error(`unexpected route ${route}`);
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-review-success", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow: {
          path: POSTIL_REVIEW_WORKFLOW_PATH,
        },
        workflow_run: {
          id: 653,
          name: "Postil Review",
          conclusion: "success",
          html_url: "https://github.com/acme/widget/actions/runs/653",
          head_sha: "abc123def456",
          pull_requests: [{ number: 68 }],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(dbMock.findFirst).toHaveBeenCalledTimes(1);
    expect(
      mockRequest.mock.calls.find(
        ([route]) => route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      )?.[1],
    ).toMatchObject({
      check_run_id: 321,
      conclusion: "success",
      output: {
        title: "Postil Review",
        summary: "Review completed.",
        text: "Review completed.",
      },
    });
    expect(dbMock.updateCalls).toContainEqual({
      status: "completed",
      completedAt: expect.any(Date),
    });
  });

  it("completes the review check when the review workflow only knows the pull number", async () => {
    dbMock.findFirst.mockResolvedValueOnce({ id: "review-1", checkRunId: 321 } as never);
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        throw new Error("must not resolve current PR head");
      }
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        return { data: { id: 321 } };
      }
      throw new Error(`unexpected route ${route}`);
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-review-failure", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow: {
          path: POSTIL_REVIEW_WORKFLOW_PATH,
        },
        workflow_run: {
          id: 654,
          name: "Postil Review",
          conclusion: "failure",
          html_url: "https://github.com/acme/widget/actions/runs/654",
          pull_requests: [{ number: 68 }],
          head_sha: "abc123def456",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(dbMock.findFirst).toHaveBeenCalledTimes(1);
    expect(
      mockRequest.mock.calls.some(([route]) => route === "GET /repos/{owner}/{repo}/pulls"),
    ).toBe(false);
    expect(
      mockRequest.mock.calls.some(([route]) => route === "POST /repos/{owner}/{repo}/issues"),
    ).toBe(false);
    expect(
      mockRequest.mock.calls.find(
        ([route]) => route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      )?.[1],
    ).toMatchObject({
      check_run_id: 321,
      conclusion: "failure",
      output: {
        title: "Postil Review",
        summary: "Review failed to complete.",
        text: "Review failed to complete.",
      },
    });
    expect(dbMock.updateCalls).toContainEqual({
      status: "failed",
      errorMessage: "Review workflow failed before review completion.",
      completedAt: expect.any(Date),
    });
  });

  it("marks the review row failed even when the check-run patch fails", async () => {
    dbMock.findFirst.mockResolvedValueOnce({ id: "review-1", checkRunId: 325 } as never);
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        throw new Error("patch failed");
      }
      throw new Error(`unexpected route ${route}`);
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-review-patch-failure", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow: {
          path: POSTIL_REVIEW_WORKFLOW_PATH,
        },
        workflow_run: {
          id: 659,
          name: "Postil Review",
          conclusion: "failure",
          html_url: "https://github.com/acme/widget/actions/runs/659",
          head_sha: "abc123def456",
          pull_requests: [{ number: 68 }],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(dbMock.updateCalls).toContainEqual({
      status: "failed",
      errorMessage: "Review workflow failed before review completion.",
      completedAt: expect.any(Date),
    });
  });

  it("does not complete a newer review check when a historical review workflow has no pull requests", async () => {
    dbMock.findFirst.mockResolvedValueOnce(undefined);
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        throw new Error("must not resolve current PR head");
      }
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        throw new Error("must not patch newer review check");
      }
      throw new Error(`unexpected route ${route}`);
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-review-no-pulls", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow: {
          path: POSTIL_REVIEW_WORKFLOW_PATH,
        },
        workflow_run: {
          id: 660,
          name: "Postil Review",
          conclusion: "failure",
          html_url: "https://github.com/acme/widget/actions/runs/660",
          head_branch: "feat/review-workflow",
          head_sha: "base123",
          pull_requests: [],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(dbMock.findFirst).toHaveBeenCalledTimes(1);
    expect(
      mockRequest.mock.calls.some(([route]) => route === "GET /repos/{owner}/{repo}/pulls"),
    ).toBe(false);
    expect(
      mockRequest.mock.calls.some(
        ([route]) => route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      ),
    ).toBe(false);
    expect(dbMock.updateCalls).toEqual([]);
    expect(posthogMock.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Review workflow failure did not match a review check-run",
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          op: "review_workflow_failure_check_run_unmatched",
          pullNumber: null,
        }),
      }),
    );
  });

  it("completes the review check when the workflow-run SHA is the base SHA", async () => {
    dbMock.findFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "review-1", checkRunId: 323 } as never);
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        return { data: { id: 323 } };
      }
      throw new Error(`unexpected route ${route}`);
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-review-base-sha", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow: {
          path: POSTIL_REVIEW_WORKFLOW_PATH,
        },
        workflow_run: {
          id: 656,
          name: "Postil Review",
          conclusion: "failure",
          html_url: "https://github.com/acme/widget/actions/runs/656",
          head_sha: "base123",
          pull_requests: [{ number: 68, head: { sha: "abc123def456" } }],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(dbMock.findFirst).toHaveBeenCalledTimes(2);
    expect(
      mockRequest.mock.calls.find(
        ([route]) => route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      )?.[1],
    ).toMatchObject({
      check_run_id: 323,
      conclusion: "failure",
    });
    expect(dbMock.updateCalls).toContainEqual({
      status: "failed",
      errorMessage: "Review workflow failed before review completion.",
      completedAt: expect.any(Date),
    });
  });

  it("does not complete a newer review check for a stale review workflow failure", async () => {
    dbMock.findFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    mockRequest.mockImplementation(async (route: string) => {
      throw new Error(`unexpected route ${route}`);
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-review-stale", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow: {
          path: POSTIL_REVIEW_WORKFLOW_PATH,
        },
        workflow_run: {
          id: 657,
          name: "Postil Review",
          conclusion: "failure",
          html_url: "https://github.com/acme/widget/actions/runs/657",
          head_sha: "base123",
          pull_requests: [{ number: 68, head: { sha: "oldabc123" } }],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(dbMock.findFirst).toHaveBeenCalledTimes(2);
    expect(
      mockRequest.mock.calls.some(
        ([route]) => route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      ),
    ).toBe(false);
    expect(dbMock.updateCalls).toEqual([]);
  });

  it("completes the review check when the review workflow is cancelled before setup finishes", async () => {
    dbMock.findFirst.mockResolvedValueOnce({ id: "review-1", checkRunId: 322 } as never);
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        return { data: { id: 322 } };
      }
      throw new Error(`unexpected route ${route}`);
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-review-cancelled", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow: {
          path: POSTIL_REVIEW_WORKFLOW_PATH,
        },
        workflow_run: {
          id: 655,
          name: "Postil Review",
          conclusion: "cancelled",
          html_url: "https://github.com/acme/widget/actions/runs/655",
          head_sha: "abc123def456",
          pull_requests: [{ number: 68 }],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(dbMock.findFirst).toHaveBeenCalled();
    expect(
      mockRequest.mock.calls.some(([route]) => route === "POST /repos/{owner}/{repo}/issues"),
    ).toBe(false);
    expect(
      mockRequest.mock.calls.find(
        ([route]) => route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      )?.[1],
    ).toMatchObject({
      check_run_id: 322,
      conclusion: "failure",
      output: {
        title: "Postil Review",
        summary: "Review failed to complete.",
        text: "Review failed to complete.",
      },
    });
    expect(dbMock.updateCalls).toContainEqual({
      status: "failed",
      errorMessage: "Review workflow cancelled before review completion.",
      completedAt: expect.any(Date),
    });
  });

  it.each([
    "action_required",
    "neutral",
    "skipped",
    "startup_failure",
    "stale",
    "timed_out",
    "unexpected_conclusion",
    null,
    undefined,
  ])("ignores review workflow conclusion %s", async (conclusion) => {
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        throw new Error("unexpected review check-run patch");
      }
      throw new Error(`unexpected route ${route}`);
    });

    const res = await POST(
      signedRequest("workflow_run", `workflow-review-${conclusion ?? "missing"}`, {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow: {
          path: POSTIL_REVIEW_WORKFLOW_PATH,
        },
        workflow_run: {
          id: 661,
          name: "Postil Review",
          conclusion,
          html_url: "https://github.com/acme/widget/actions/runs/661",
          head_sha: "abc123def456",
          pull_requests: [{ number: 68 }],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(dbMock.findFirst).not.toHaveBeenCalled();
    expect(dbMock.updateCalls).toEqual([]);
    expect(
      mockRequest.mock.calls.some(
        ([route]) => route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      ),
    ).toBe(false);
  });

  it("ignores a workflow-run failure with the same display name when the workflow path is different", async () => {
    mockRequest.mockImplementation(async (route: string) => {
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        throw new Error("unexpected review check-run patch");
      }
      return { data: [] };
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-review-spoof", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow: {
          path: ".github/workflows/unrelated.yml",
          name: "Postil Review",
        },
        workflow_run: {
          id: 658,
          name: "Postil Review",
          conclusion: "failure",
          html_url: "https://github.com/acme/widget/actions/runs/658",
          head_sha: "abc123def456",
          pull_requests: [{ number: 68 }],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(dbMock.findFirst).not.toHaveBeenCalled();
    expect(dbMock.updateCalls).toEqual([]);
    expect(
      mockRequest.mock.calls.some(
        ([route]) => route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      ),
    ).toBe(false);
  });

  it("retries auto-merge when the CI workflow finishes successfully after approval", async () => {
    mockRequest.mockImplementation(async (route: string, _params?: Record<string, unknown>) => {
      if (route === "GET /app") {
        return { data: { slug: "postil" } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
        return {
          data: [
            {
              state: "APPROVED",
              commit_id: "abc123def456",
              submitted_at: "2026-05-18T06:00:00Z",
              user: { login: "postil[bot]" },
            },
          ],
        };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return {
          data: {
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: "abc123def456" },
            labels: [],
          },
        };
      }
      if (
        route === "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks"
      ) {
        return {
          data: {
            contexts: [
              "postil/review",
              "Lint",
              "Typecheck",
              "Unit tests",
              "Build",
              "Docker build",
              "Verify postil/review passed",
            ],
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        return {
          data: {
            check_runs: [
              {
                name: "postil/review",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Lint",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Typecheck",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Unit tests",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Build",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Docker build",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Verify postil/review passed",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
            ],
          },
        };
      }
      if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") {
        return { data: { merged: true } };
      }
      return { data: [] };
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-success", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow_run: {
          id: 988,
          name: "CI",
          conclusion: "success",
          html_url: "https://github.com/acme/widget/actions/runs/988",
          head_sha: "abc123def456",
          pull_requests: [{ number: 68 }],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(
      mockRequest.mock.calls.some(
        ([route]) => route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      ),
    ).toBe(true);
    expect(
      mockRequest.mock.calls.find(
        ([route]) => route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      )?.[1],
    ).toMatchObject({
      sha: "abc123def456",
      merge_method: "squash",
    });
  });

  it("does not retry auto-merge when the bot review is only a comment", async () => {
    mockRequest.mockImplementation(async (route: string, _params?: Record<string, unknown>) => {
      if (route === "GET /app") {
        return { data: { slug: "postil" } };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
        return {
          data: [
            {
              state: "COMMENTED",
              commit_id: "abc123def456",
              submitted_at: "2026-05-18T06:00:00Z",
              user: { login: "postil[bot]" },
            },
          ],
        };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return {
          data: {
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: "abc123def456" },
            labels: [],
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        return {
          data: {
            check_runs: [
              {
                name: "postil/review",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Lint",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Typecheck",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Unit tests",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Build",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Docker build",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "Verify postil/review passed",
                head_sha: "abc123def456",
                status: "completed",
                conclusion: "success",
              },
            ],
          },
        };
      }
      if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") {
        return { data: { merged: true } };
      }
      return { data: [] };
    });

    const res = await POST(
      signedRequest("workflow_run", "workflow-no-approval", {
        action: "completed",
        installation: { id: 123 },
        repository: { full_name: "acme/widget" },
        workflow_run: {
          id: 989,
          name: "CI",
          conclusion: "success",
          html_url: "https://github.com/acme/widget/actions/runs/989",
          head_sha: "abc123def456",
          pull_requests: [{ number: 68 }],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(
      mockRequest.mock.calls.some(
        ([route]) => route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      ),
    ).toBe(false);
  });
});
