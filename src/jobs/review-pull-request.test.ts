import { beforeEach, describe, expect, it, vi } from "vitest";

const triggerMock = vi.hoisted(() => ({
  authConfigure: vi.fn(),
  task: vi.fn((definition: unknown) => definition),
}));

const posthogMock = vi.hoisted(() => ({
  captureException: vi.fn(),
  hashInstallationId: vi.fn(() => "hashed-installation"),
  track: vi.fn(),
}));

const usageMock = vi.hoisted(() => ({
  recordReviewCompleted: vi.fn(),
  recordTokenUsage: vi.fn(),
}));

const runReviewMock = vi.hoisted(() => ({
  runReview: vi.fn(),
}));

const envMock = vi.hoisted(() => ({
  REVIEW_MODEL: "test/default",
  REVIEW_MODEL_CASCADE: undefined as string | undefined,
  TRIGGER_API_KEY: "test-trigger-key",
  TRIGGER_API_URL: "https://trigger.example.test",
}));

const githubMock = vi.hoisted(() => {
  const request = vi.fn();
  return {
    request,
    appOctokit: vi.fn(() => ({ request })),
    installationOctokit: vi.fn(async () => ({ request })),
  };
});

vi.mock("@trigger.dev/sdk/v3", () => ({
  auth: { configure: triggerMock.authConfigure },
  logger: { info: vi.fn() },
  task: triggerMock.task,
}));

vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/github", () => ({
  appOctokit: githubMock.appOctokit,
  installationOctokit: githubMock.installationOctokit,
}));
vi.mock("@/lib/posthog", () => posthogMock);
vi.mock("@/lib/usage", () => usageMock);
vi.mock("@/db", () => ({
  getDb: vi.fn(),
  schema: { reviews: { id: "id" } },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => true),
}));
vi.mock("./run-review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-review")>();
  return {
    isOpenRouterCascadeError: actual.isOpenRouterCascadeError,
    publicReviewErrorMessage: actual.publicReviewErrorMessage,
    reviewPayload: actual.reviewPayload,
    runReview: runReviewMock.runReview,
  };
});

const PAYLOAD = {
  installationId: 1,
  repoFullName: "owner/repo",
  pullNumber: 5,
  headSha: "abc123def456",
};

const { reviewPullRequest } = await import("./review-pull-request");
const runReviewTask = reviewPullRequest as unknown as {
  run: (payload: typeof PAYLOAD) => Promise<{ ok: boolean; findings: number }>;
};

describe("reviewPullRequest", () => {
  beforeEach(() => {
    posthogMock.track.mockReset();
    runReviewMock.runReview.mockReset();
    githubMock.appOctokit.mockReset();
    githubMock.appOctokit.mockReturnValue({ request: githubMock.request });
    githubMock.installationOctokit.mockReset();
    githubMock.installationOctokit.mockResolvedValue({ request: githubMock.request });
    runReviewMock.runReview.mockResolvedValue({
      summary: "ok",
      findings: [],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      modelUsed: "test/failover",
    });
  });

  it("records the selected cascade model on completed review telemetry", async () => {
    await runReviewTask.run(PAYLOAD);

    expect(posthogMock.track).toHaveBeenCalledWith(
      "system",
      "review_completed",
      expect.objectContaining({
        modelUsed: "test/failover",
      }),
    );
  });

  it("records the failing cascade model when review execution rejects", async () => {
    envMock.REVIEW_MODEL_CASCADE = "test/primary, test/backup";
    runReviewMock.runReview.mockRejectedValueOnce(
      Object.assign(new Error("openrouter model cascade failed"), {
        modelUsed: "test/backup",
        attemptedModels: ["test/primary", "test/backup"],
        providerFailures: [
          { model: "test/primary", reason: "provider returned an error", status: 429 },
          { model: "test/backup", reason: "cascade timeout", errorClass: "AbortError" },
        ],
      }),
    );

    await expect(runReviewTask.run(PAYLOAD)).rejects.toThrow("openrouter model cascade failed");

    expect(posthogMock.track).toHaveBeenCalledWith(
      "system",
      "review_failed",
      expect.objectContaining({
        error: "Review failed after all configured model providers were unavailable.",
        modelUsed: "test/backup",
        attemptedModels: ["test/primary", "test/backup"],
        providerFailures: [
          { model: "test/primary", reason: "provider returned an error", status: 429 },
          { model: "test/backup", reason: "cascade timeout", errorClass: "AbortError" },
        ],
      }),
    );
    expect(posthogMock.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        properties: expect.objectContaining({
          modelUsed: "test/backup",
          attemptedModels: ["test/primary", "test/backup"],
          providerFailures: [
            { model: "test/primary", reason: "provider returned an error", status: 429 },
            { model: "test/backup", reason: "cascade timeout", errorClass: "AbortError" },
          ],
        }),
      }),
    );
  });

  it("sanitizes installation client setup failures before telemetry", async () => {
    githubMock.installationOctokit.mockRejectedValueOnce(
      new Error("installation auth failed: super-secret-token"),
    );

    await expect(
      runReviewTask.run({ ...PAYLOAD, checkRunId: 77 } as typeof PAYLOAD & {
        checkRunId: number;
      }),
    ).rejects.toThrow("Review failed to complete.");

    expect(githubMock.appOctokit).toHaveBeenCalled();
    expect(githubMock.request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        conclusion: "failure",
        output: {
          title: "Postil Review",
          summary: "Review failed to complete.",
          text: "Review failed to complete.",
        },
      }),
    );
    expect(JSON.stringify(posthogMock.captureException.mock.calls)).not.toContain(
      "super-secret-token",
    );
  });
});
