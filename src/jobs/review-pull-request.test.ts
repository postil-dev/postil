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

const githubMock = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(async () => "installation-token"),
  repositoryRequest: vi.fn(async () => ({ data: {} })),
}));

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  readFile: vi.fn(async (path: string) => fsMock.files.get(path) ?? "{}"),
  writeFile: vi.fn(async (path: string, content: string) => {
    fsMock.files.set(path, content);
  }),
}));

const dbMock = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
}));

const envMock = vi.hoisted(() => ({
  GITHUB_PAT: "test-repository-token" as string | undefined,
  OPENROUTER_API_KEY: "test-openrouter-key",
  POSTIL_CLI_PATH: "postil-test",
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

vi.mock("node:fs/promises", () => fsMock);
vi.mock("node:child_process", () => childProcessMock);
vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(function Octokit() {
    return { request: githubMock.repositoryRequest };
  }),
}));
vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/github", () => ({
  mintInstallationToken: githubMock.mintInstallationToken,
}));
vi.mock("@/lib/posthog", () => posthogMock);
vi.mock("@/lib/usage", () => usageMock);
vi.mock("@/db", () => ({
  getDb: vi.fn(() => ({
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          dbMock.updates.push(values);
        },
      }),
    }),
  })),
  schema: { reviews: { id: "id" } },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => true),
}));

const PAYLOAD = {
  installationId: 1,
  repoFullName: "owner/repo",
  pullNumber: 5,
  headSha: "abc123def456",
  checkRunId: 77,
  reviewId: "00000000-0000-4000-8000-000000000001",
};

const { reviewPullRequest } = await import("./review-pull-request");
const runReviewTask = reviewPullRequest as unknown as {
  run: (payload: typeof PAYLOAD) => Promise<{ ok: boolean; findings: number }>;
};

function workflowExpression(value: string): string {
  return ["${{", value, "}}"].join(" ");
}

function jsTemplateExpression(value: string): string {
  return ["${", value, "}"].join("");
}

describe("reviewPullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.files.clear();
    dbMock.updates = [];
    envMock.GITHUB_PAT = "test-repository-token";
    envMock.REVIEW_MODEL_CASCADE = undefined;
    childProcessMock.execFile.mockImplementation((_cmd, args, _opts, cb) => {
      const outputPath = args[args.indexOf("--output-json") + 1];
      fsMock.files.set(
        outputPath,
        JSON.stringify({
          summary: "ok",
          findings: [],
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
          modelUsed: "test/failover",
        }),
      );
      cb(null, "", "");
    });
  });

  it("runs the Rust CLI and records completed review telemetry", async () => {
    await runReviewTask.run(PAYLOAD);

    expect(fsMock.mkdir).toHaveBeenCalledWith(
      expect.stringMatching(/(?:^|[\\/])postil-runs[\\/].+/),
      expect.objectContaining({ recursive: true, mode: 0o700 }),
    );
    expect(githubMock.mintInstallationToken).toHaveBeenCalledWith(1);
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "postil-test",
      expect.arrayContaining(["review", "--config", expect.any(String), "--output-json"]),
      expect.any(Object),
      expect.any(Function),
    );
    const configPath = childProcessMock.execFile.mock.calls[0][1][2];
    const cliConfig = JSON.parse(fsMock.files.get(configPath) ?? "{}");
    expect(cliConfig.checkRunId).toBe(77);
    expect(posthogMock.track).toHaveBeenCalledWith(
      "system",
      "review_completed",
      expect.objectContaining({
        modelUsed: "test/failover",
      }),
    );
    expect(usageMock.recordTokenUsage).toHaveBeenCalledWith(1, PAYLOAD.reviewId, {
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    });
    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "completed",
        result: expect.objectContaining({ summary: "ok" }),
      }),
    );
  });

  it("marks the review and check-run failed when CLI execution rejects", async () => {
    childProcessMock.execFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(new Error("cli failed"), "", "");
    });

    await expect(runReviewTask.run(PAYLOAD)).rejects.toThrow("Review failed to complete.");

    expect(githubMock.repositoryRequest).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        check_run_id: 77,
        conclusion: "failure",
      }),
    );
    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        errorMessage: "Review failed to complete.",
      }),
    );
    expect(posthogMock.track).toHaveBeenCalledWith(
      "system",
      "review_failed",
      expect.objectContaining({
        error: "Review failed to complete.",
      }),
    );
  });

  it("marks the review failed even when emergency check-run completion fails", async () => {
    childProcessMock.execFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(new Error("cli failed"), "", "");
    });
    githubMock.repositoryRequest.mockRejectedValueOnce(new Error("check-run patch failed"));

    await expect(runReviewTask.run(PAYLOAD)).rejects.toThrow("Review failed to complete.");

    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        errorMessage: "Review failed to complete.",
      }),
    );
    expect(dbMock.updates[0]).toEqual(
      expect.objectContaining({
        status: "failed",
      }),
    );
    expect(posthogMock.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "postil review check-run failure patch failed",
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          op: "emergency_complete_check_run",
        }),
      }),
    );
  });

  it("marks the review failed when the CLI exits 1 without findings", async () => {
    childProcessMock.execFile.mockImplementationOnce((_cmd, args, _opts, cb) => {
      const outputPath = args[args.indexOf("--output-json") + 1];
      fsMock.files.set(
        outputPath,
        JSON.stringify({
          summary: "",
          findings: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          modelUsed: "test/default",
        }),
      );
      cb(Object.assign(new Error("exit code 1"), { code: 1 }), "", "");
    });

    await expect(runReviewTask.run(PAYLOAD)).rejects.toThrow("Review failed to complete.");

    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        errorMessage: "Review failed to complete.",
      }),
    );
  });

  it("marks the review failed when the CLI exits with an unexpected code", async () => {
    childProcessMock.execFile.mockImplementationOnce((_cmd, args, _opts, cb) => {
      const outputPath = args[args.indexOf("--output-json") + 1];
      fsMock.files.set(
        outputPath,
        JSON.stringify({
          summary: "blocking findings",
          findings: [
            {
              path: "src/billing/checkout.ts",
              line: 42,
              severity: "error",
              body: "Credit is applied twice.",
            },
          ],
          usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
          modelUsed: "test/default",
        }),
      );
      cb(Object.assign(new Error("exit code 2"), { code: 2 }), "", "");
    });

    await expect(runReviewTask.run(PAYLOAD)).rejects.toThrow("Review failed to complete.");

    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        errorMessage: "Review failed to complete.",
      }),
    );
  });

  it("records a completed review when the CLI exits after writing blocking findings", async () => {
    childProcessMock.execFile.mockImplementationOnce((_cmd, args, _opts, cb) => {
      const outputPath = args[args.indexOf("--output-json") + 1];
      fsMock.files.set(
        outputPath,
        JSON.stringify({
          summary: "blocking findings",
          findings: [
            {
              path: "src/billing/checkout.ts",
              line: 42,
              severity: "error",
              body: "Credit is applied twice.",
            },
          ],
          usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
          modelUsed: "test/default",
        }),
      );
      cb(Object.assign(new Error("exit code 1"), { code: 1 }), "", "");
    });

    await expect(runReviewTask.run(PAYLOAD)).resolves.toEqual({ ok: true, findings: 1 });

    expect(githubMock.repositoryRequest).not.toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({ conclusion: "failure" }),
    );
    expect(dbMock.updates).toContainEqual(
      expect.objectContaining({
        status: "completed",
        result: expect.objectContaining({
          summary: "blocking findings",
          findings: expect.arrayContaining([expect.objectContaining({ severity: "error" })]),
        }),
      }),
    );
    expect(posthogMock.track).toHaveBeenCalledWith(
      "system",
      "review_completed",
      expect.objectContaining({
        findings: 1,
      }),
    );
  });

  it("completes the review check with repository credentials when CLI setup fails", async () => {
    githubMock.mintInstallationToken.mockRejectedValueOnce(
      new Error("installation auth failed: super-secret-token"),
    );

    await expect(runReviewTask.run(PAYLOAD)).rejects.toThrow("Review failed to complete.");

    expect(githubMock.repositoryRequest).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        check_run_id: 77,
        status: "completed",
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
    expect(JSON.stringify(posthogMock.track.mock.calls)).not.toContain("super-secret-token");
  });

  it("sanitizes CLI setup failures when no repository check client is available", async () => {
    envMock.GITHUB_PAT = undefined;
    githubMock.mintInstallationToken.mockRejectedValueOnce(
      new Error("installation auth failed: super-secret-token"),
    );

    await expect(runReviewTask.run(PAYLOAD)).rejects.toThrow("Review failed to complete.");

    expect(githubMock.repositoryRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(posthogMock.captureException.mock.calls)).not.toContain(
      "super-secret-token",
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
        GITHUB_PAT: workflowExpression("secrets.GITHUB_PAT"),
        GITHUB_REPOSITORY: workflowExpression("github.repository"),
        GITHUB_EVENT_PATH: workflowExpression("github.event_path"),
      }),
    });
    expect(steps[completeCheckIndex].run).toContain("https://api.github.com/repos/");
    expect(steps[completeCheckIndex].run).toContain(
      "const headSha = pull && pull.head && pull.head.sha;",
    );
    expect(steps[completeCheckIndex].run).not.toContain("workflow_run");
    expect(steps[completeCheckIndex].run).toContain(
      `/commits/${jsTemplateExpression("headSha")}/check-runs`,
    );
    expect(steps[completeCheckIndex].run).toContain('run.name === "postil/review"');
    expect(steps[completeCheckIndex].run).toContain("for (const checkRun of checkRuns)");
    expect(steps[completeCheckIndex].run).toContain(
      `check-runs/${jsTemplateExpression("checkRun.id")}`,
    );
    expect(steps[completeCheckIndex].run).toContain('conclusion: "failure"');
    expect(steps[completeCheckIndex].run).toContain(
      "Review setup failed before execution could start.",
    );
  });
});
