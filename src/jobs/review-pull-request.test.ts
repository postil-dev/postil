import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

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
  installationRequest: vi.fn(),
  repositoryRequest: vi.fn(),
}));

const envMock = vi.hoisted(() => ({
  GITHUB_PAT: "test-repository-token" as string | undefined,
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

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(function Octokit() {
    return { request: githubMock.repositoryRequest };
  }),
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

function workflowExpression(value: string): string {
  return ["${{", value, "}}"].join(" ");
}

describe("reviewPullRequest", () => {
  beforeEach(() => {
    posthogMock.track.mockReset();
    posthogMock.captureException.mockReset();
    posthogMock.hashInstallationId.mockReset();
    posthogMock.hashInstallationId.mockResolvedValue("hashed-installation");
    runReviewMock.runReview.mockReset();
    githubMock.installationOctokit.mockReset();
    githubMock.installationOctokit.mockResolvedValue({ request: githubMock.installationRequest });
    githubMock.installationRequest.mockReset();
    githubMock.repositoryRequest.mockReset();
    envMock.GITHUB_PAT = "test-repository-token";
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
    posthogMock.hashInstallationId.mockRejectedValueOnce(new Error("setup diagnostic placeholder"));
    githubMock.repositoryRequest.mockRejectedValue(
      new Error("repository credential path must not be used"),
    );

    await expect(runReviewTask.run({ ...PAYLOAD, checkRunId: 321 })).rejects.toMatchObject({
      message: "Review setup failed before execution could start.",
      name: "ReviewSetupError",
    });

    expect(runReviewMock.runReview).not.toHaveBeenCalled();
    expect(githubMock.installationOctokit).toHaveBeenCalledWith(1);
    expect(githubMock.installationRequest).toHaveBeenCalledWith(
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
    expect(githubMock.repositoryRequest).not.toHaveBeenCalled();
  });

  it("does not refetch the installation hash while reporting setup failure telemetry", async () => {
    const rawSetupMessage = "setup diagnostic placeholder";
    posthogMock.hashInstallationId.mockRejectedValue(new Error(rawSetupMessage));

    await expect(runReviewTask.run({ ...PAYLOAD, checkRunId: 321 })).rejects.toMatchObject({
      message: "Review setup failed before execution could start.",
      name: "ReviewSetupError",
    });

    expect(posthogMock.hashInstallationId).toHaveBeenCalledTimes(1);
    expect(posthogMock.track).toHaveBeenCalledWith(
      "system",
      "review_failed",
      expect.objectContaining({
        error: "Review failed to complete.",
        errorClass: "Error",
        installationHash: undefined,
      }),
    );
    expect(JSON.stringify(posthogMock.track.mock.calls)).not.toContain(rawSetupMessage);
    expect(JSON.stringify(posthogMock.captureException.mock.calls)).not.toContain(rawSetupMessage);
  });

  it("surfaces an explicit unavailable completion path when installation client setup fails", async () => {
    const rawSetupMessage = "installation setup placeholder";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    envMock.GITHUB_PAT = undefined;
    githubMock.installationOctokit.mockRejectedValueOnce(new Error(rawSetupMessage));

    try {
      await expect(runReviewTask.run({ ...PAYLOAD, checkRunId: 321 })).rejects.toMatchObject({
        message: "Review setup failed before execution could start.",
        name: "ReviewSetupError",
      });

      expect(runReviewMock.runReview).not.toHaveBeenCalled();
      expect(githubMock.installationRequest).not.toHaveBeenCalled();
      expect(githubMock.repositoryRequest).not.toHaveBeenCalled();
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(rawSetupMessage);
      expect(consoleError).toHaveBeenCalledWith(
        "[check-run]",
        expect.stringContaining("Review setup failed before a GitHub check client was available"),
        { errorClass: "Error" },
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("sanitizes installation setup failures before runReview starts without a check run", async () => {
    const rawSetupMessage = "installation setup placeholder";
    githubMock.installationOctokit.mockRejectedValueOnce(new Error(rawSetupMessage));

    await expect(runReviewTask.run(PAYLOAD)).rejects.toMatchObject({
      message: "Review setup failed before execution could start.",
      name: "ReviewSetupError",
    });

    expect(runReviewMock.runReview).not.toHaveBeenCalled();
    expect(githubMock.repositoryRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(posthogMock.captureException.mock.calls)).not.toContain(rawSetupMessage);
    expect(JSON.stringify(posthogMock.track.mock.calls)).not.toContain(rawSetupMessage);
  });

  it("completes the review check with a repository client when installation client setup fails", async () => {
    const rawSetupMessage = "installation setup placeholder";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    githubMock.installationOctokit.mockRejectedValueOnce(new Error(rawSetupMessage));

    try {
      await expect(runReviewTask.run({ ...PAYLOAD, checkRunId: 321 })).rejects.toMatchObject({
        message: "Review setup failed before execution could start.",
        name: "ReviewSetupError",
      });

      expect(runReviewMock.runReview).not.toHaveBeenCalled();
      expect(githubMock.installationRequest).not.toHaveBeenCalled();
      expect(githubMock.repositoryRequest).toHaveBeenCalledWith(
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
      expect(JSON.stringify(githubMock.repositoryRequest.mock.calls)).not.toContain(
        rawSetupMessage,
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(rawSetupMessage);
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
      { installation: { request: githubMock.installationRequest } },
    );
    expect(githubMock.installationOctokit).toHaveBeenCalledWith(1);
    expect(githubMock.installationRequest).not.toHaveBeenCalled();
    expect(githubMock.repositoryRequest).not.toHaveBeenCalled();
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
    expect(githubMock.installationRequest).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        check_run_id: 321,
        status: "completed",
        conclusion: "failure",
      }),
    );
    expect(githubMock.repositoryRequest).not.toHaveBeenCalled();
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

  it("keeps workflow-level secret fetch failures terminal for the review check", () => {
    const workflow = parseYaml(
      readFileSync(new URL("../../.github/workflows/postil-review.yml", import.meta.url), "utf8"),
    ) as {
      jobs: {
        review: {
          steps: Array<{
            id?: string;
            if?: string;
            name?: string;
            env?: Record<string, string>;
            run?: string;
          }>;
        };
      };
    };
    const steps = workflow.jobs.review.steps;
    const fetchSecretsIndex = steps.findIndex(
      (step) => step.name === "Fetch secrets from Infisical",
    );
    const completeCheckIndex = steps.findIndex(
      (step) => step.name === "Complete review check after secret fetch failure",
    );
    const setupBunIndex = steps.findIndex((step) => step.name === "Set up Bun");

    expect(fetchSecretsIndex).toBeGreaterThan(-1);
    expect(completeCheckIndex).toBe(fetchSecretsIndex + 1);
    expect(setupBunIndex).toBeGreaterThan(completeCheckIndex);
    expect(steps[fetchSecretsIndex]).toMatchObject({ id: "fetch-secrets" });
    expect(steps[completeCheckIndex]).toMatchObject({
      if: "github.event_name == 'pull_request_target' && failure() && steps.fetch-secrets.outcome == 'failure'",
      env: expect.objectContaining({
        GITHUB_TOKEN: workflowExpression("secrets.GITHUB_TOKEN"),
        GITHUB_REPOSITORY: workflowExpression("github.repository"),
        GITHUB_EVENT_PATH: workflowExpression("github.event_path"),
      }),
    });
    expect(steps[completeCheckIndex].run).toContain("https://api.github.com/repos/");
    expect(steps[completeCheckIndex].run).toContain("/commits/${headSha}/check-runs");
    expect(steps[completeCheckIndex].run).toContain('run.name === "postil/review"');
    expect(steps[completeCheckIndex].run).toContain("for (const checkRun of checkRuns)");
    expect(steps[completeCheckIndex].run).toContain("check-runs/${checkRun.id}");
    expect(steps[completeCheckIndex].run).toContain('conclusion: "failure"');
    expect(steps[completeCheckIndex].run).toContain(
      "Review setup failed before execution could start.",
    );
  });
});
