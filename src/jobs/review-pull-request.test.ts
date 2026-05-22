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

const githubMock = vi.hoisted(() => ({
  installationOctokit: vi.fn(),
  request: vi.fn(),
}));

const envMock = vi.hoisted(() => ({
  REVIEW_MODEL: "test/default",
  REVIEW_MODEL_CASCADE: undefined as string | undefined,
  TRIGGER_API_KEY: "test-trigger-key",
  TRIGGER_API_URL: "https://trigger.example.test",
}));

vi.mock("@trigger.dev/sdk/v3", () => ({
  auth: { configure: triggerMock.authConfigure },
  logger: { info: vi.fn() },
  task: triggerMock.task,
}));

vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/github", () => ({
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
  run: (payload: typeof PAYLOAD & { checkRunId?: number }) => Promise<{
    ok: boolean;
    findings: number;
  }>;
};

describe("reviewPullRequest", () => {
  beforeEach(() => {
    posthogMock.track.mockReset();
    posthogMock.captureException.mockReset();
    posthogMock.hashInstallationId.mockReset();
    posthogMock.hashInstallationId.mockResolvedValue("hashed-installation");
    runReviewMock.runReview.mockReset();
    githubMock.installationOctokit.mockReset();
    githubMock.installationOctokit.mockResolvedValue({ request: githubMock.request });
    githubMock.request.mockReset();
    envMock.REVIEW_MODEL_CASCADE = undefined;
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

  it("completes the review check with the precreated client when setup fails before runReview starts", async () => {
    posthogMock.hashInstallationId.mockRejectedValueOnce(new Error("secret fetch failed"));

    await expect(runReviewTask.run({ ...PAYLOAD, checkRunId: 321 })).rejects.toMatchObject({
      message: "Review setup failed before execution could start.",
      name: "ReviewSetupError",
    });

    expect(runReviewMock.runReview).not.toHaveBeenCalled();
    expect(githubMock.installationOctokit).toHaveBeenCalledWith(1);
    expect(githubMock.request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        check_run_id: 321,
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Postil Review",
          summary: "Review failed to complete.",
          text: "Review failed to complete.",
        },
      }),
    );
  });

  it("surfaces an explicit unavailable completion path when client setup fails", async () => {
    const rawSetupMessage = "private key unavailable from secret-store diagnostic";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    githubMock.installationOctokit.mockRejectedValueOnce(new Error(rawSetupMessage));

    try {
      await expect(runReviewTask.run({ ...PAYLOAD, checkRunId: 321 })).rejects.toMatchObject({
        message: "Review setup failed before execution could start.",
        name: "ReviewSetupError",
      });

      expect(runReviewMock.runReview).not.toHaveBeenCalled();
      expect(githubMock.request).not.toHaveBeenCalled();
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(rawSetupMessage);
      expect(consoleError).toHaveBeenCalledWith(
        "[check-run]",
        expect.stringContaining("Review setup failed before a GitHub check client was available"),
        { errorClass: "Error" },
      );
      expect(posthogMock.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          properties: expect.objectContaining({
            op: "review_check_completion_unavailable",
            repoFullName: "owner/repo",
            pullNumber: 5,
            headSha: "abc123def456",
            checkRunId: 321,
            errorClass: "Error",
            requiredAction: "Restore GitHub App authentication and rerun the review.",
          }),
        }),
      );
      expect(JSON.stringify(posthogMock.captureException.mock.calls)).not.toContain(
        rawSetupMessage,
      );
      expect(
        posthogMock.captureException.mock.calls.map(([error]) =>
          error instanceof Error ? error.message : String(error),
        ),
      ).toEqual([
        "Review setup failed before execution could start.",
        "Review setup failed before execution could start.",
      ]);
      expect(
        posthogMock.captureException.mock.calls.map(([error]) =>
          error instanceof Error ? error.name : String(error),
        ),
      ).toEqual(["ReviewSetupError", "ReviewSetupError"]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not complete the review check in the wrapper after runReview starts", async () => {
    runReviewMock.runReview.mockRejectedValueOnce(new Error("review execution failed"));

    await expect(runReviewTask.run({ ...PAYLOAD, checkRunId: 321 })).rejects.toThrow(
      "review execution failed",
    );

    expect(runReviewMock.runReview).toHaveBeenCalledWith(
      { ...PAYLOAD, checkRunId: 321 },
      { installation: { request: githubMock.request } },
    );
    expect(githubMock.installationOctokit).toHaveBeenCalledWith(1);
    expect(githubMock.request).not.toHaveBeenCalled();
  });

  it("reuses the precreated check-run client once runReview starts", async () => {
    runReviewMock.runReview.mockImplementationOnce(async (_payload, clients) => {
      await clients.installation.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        owner: "owner",
        repo: "repo",
        check_run_id: 321,
        status: "completed",
        conclusion: "failure",
      });
      throw new Error("late setup failed");
    });

    await expect(runReviewTask.run({ ...PAYLOAD, checkRunId: 321 })).rejects.toThrow(
      "late setup failed",
    );

    expect(githubMock.installationOctokit).toHaveBeenCalledTimes(1);
    expect(githubMock.installationOctokit).toHaveBeenCalledWith(1);
    expect(githubMock.request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        check_run_id: 321,
        status: "completed",
        conclusion: "failure",
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
});
