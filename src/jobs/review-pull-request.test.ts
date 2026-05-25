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

const githubMock = vi.hoisted(() => ({
  installationOctokit: vi.fn(async () => ({ request: githubMock.request })),
  mintInstallationToken: vi.fn(async () => "installation-token"),
  request: vi.fn(async () => ({ data: {} })),
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
vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/github", () => ({
  installationOctokit: githubMock.installationOctokit,
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

describe("reviewPullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.files.clear();
    dbMock.updates = [];
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

    expect(githubMock.mintInstallationToken).toHaveBeenCalledWith(1);
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "postil-test",
      expect.arrayContaining(["review", "--config", expect.any(String), "--output-json"]),
      expect.any(Object),
      expect.any(Function),
    );
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

    expect(githubMock.request).toHaveBeenCalledWith(
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

    expect(githubMock.request).not.toHaveBeenCalledWith(
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

  it("sanitizes CLI setup failures before telemetry", async () => {
    githubMock.mintInstallationToken.mockRejectedValueOnce(
      new Error("installation auth failed: super-secret-token"),
    );

    await expect(runReviewTask.run(PAYLOAD)).rejects.toThrow("Review failed to complete.");

    expect(JSON.stringify(posthogMock.captureException.mock.calls)).not.toContain(
      "super-secret-token",
    );
  });
});
