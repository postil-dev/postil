import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const githubMock = vi.hoisted(() => ({
  request: vi.fn(),
  pullUser: { login: "contributor-carol", type: "User" } as Record<string, unknown>,
  pullMergeability: {
    mergeable: true,
    mergeable_state: "clean",
    head: { sha: "abc123def456" },
    base: { ref: "main" },
  } as Record<string, unknown>,
  reviews: [] as Record<string, unknown>[],
  reviewComments: [] as Record<string, unknown>[],
  issueComments: [] as Record<string, unknown>[],
  postedReviews: [] as Record<string, unknown>[],
  checkRunUpdates: [] as Record<string, unknown>[],
  checkRuns: [] as Record<string, unknown>[],
  mergedPulls: [] as Record<string, unknown>[],
}));

const openRouterMock = vi.hoisted(() => ({
  body: null as unknown,
  bodies: [] as unknown[],
  content: '{"summary":"ok","findings":[]}',
}));

const configMock = vi.hoisted(() => ({
  review: {
    enabled: true,
    on_clean: "approve" as "approve" | "skip",
    auto_merge: false,
    required_checks: [] as string[],
    auto_merge_timeout_ms: 15_000,
  },
}));

const envMock = vi.hoisted(() => ({
  OPENROUTER_API_KEY: "test-openrouter-key",
  REVIEW_MODEL: "test/model",
  REVIEW_MODEL_CASCADE: undefined as string | undefined,
  GITHUB_APP_SLUG: "postil",
  NODE_ENV: "test",
}));

vi.mock("@/lib/env", () => ({
  env: envMock,
}));

vi.mock("@/lib/github", () => ({
  appOctokit: vi.fn().mockReturnValue({
    request: githubMock.request,
  }),
  installationOctokit: vi.fn().mockResolvedValue({
    request: githubMock.request,
  }),
}));

vi.mock("@/lib/config", () => ({
  loadReviewConfig: vi.fn().mockImplementation(async () => ({
    config: {
      enabled: true,
      severityThreshold: "info" as const,
      ignore: [],
      maxFindings: 20,
      review: { ...configMock.review },
    },
  })),
}));

const fetchSpy = vi.spyOn(globalThis, "fetch");

const { runReview } = await import("./run-review");
const configModule = await import("@/lib/config");

const PAYLOAD = {
  installationId: 1,
  repoFullName: "owner/repo",
  pullNumber: 5,
  headSha: "abc123def456",
  checkRunId: undefined as number | undefined,
  reviewId: undefined as string | undefined,
};

function latestPostedReview() {
  return githubMock.postedReviews.at(-1);
}

function latestCheckRunUpdate() {
  return githubMock.checkRunUpdates.at(-1);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runReview", () => {
  beforeEach(() => {
    githubMock.reviews = [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: { login: "reviewer-alice" },
        body: "Please keep the guard clause here.",
        commit_id: "abc123",
        submitted_at: "2026-05-18T01:00:00Z",
      },
      {
        id: 2,
        state: "DISMISSED",
        user: { login: "reviewer-bob" },
        body: "Please address the comments",
        commit_id: "def456",
        dismissal_message: "Approve without commentary unless something concrete to say",
        submitted_at: "2026-05-18T02:00:00Z",
      },
      {
        id: 3,
        state: "APPROVED",
        user: { login: "reviewer-alice" },
        body: "LGTM, nice fix",
        commit_id: "ghi789",
        submitted_at: "2026-05-18T03:00:00Z",
      },
      {
        id: 4,
        state: "COMMENTED",
        user: { login: "reviewer-dana" },
        body: "This still needs a regression test.",
        commit_id: "jkl012",
        submitted_at: "2026-05-18T04:00:00Z",
      },
      {
        id: 5,
        state: "COMMENTED",
        user: { login: "reviewer-empty" },
        body: "",
        commit_id: "mno345",
        submitted_at: "2026-05-18T05:00:00Z",
      },
    ];
    githubMock.reviewComments = [
      {
        id: 10,
        user: { login: "reviewer-alice" },
        path: "src/index.ts",
        line: 42,
        body: "Consider using a constant here.",
        created_at: "2026-05-18T02:30:00Z",
      },
    ];
    githubMock.issueComments = [
      {
        id: 20,
        user: { login: "contributor-carol" },
        body: "Addressed in latest push!",
        created_at: "2026-05-18T03:30:00Z",
      },
    ];
    githubMock.postedReviews = [];
    githubMock.checkRunUpdates = [];
    githubMock.checkRuns = [
      "postil/review",
      "Lint",
      "Typecheck",
      "Unit tests",
      "Build",
      "Docker build",
      "Verify postil/review passed",
    ].map((name) => ({
      name,
      head_sha: "abc123def456",
      status: "completed",
      conclusion: "success",
    }));
    githubMock.mergedPulls = [];
    configMock.review = {
      enabled: true,
      on_clean: "approve",
      auto_merge: false,
      required_checks: [],
      auto_merge_timeout_ms: 15_000,
    };
    githubMock.pullUser = { login: "contributor-carol", type: "User" };
    githubMock.pullMergeability = {
      mergeable: true,
      mergeable_state: "clean",
      head: { sha: "abc123def456" },
      base: { ref: "main" },
    };
    githubMock.request.mockReset();
    githubMock.request.mockImplementation((path: string, params?: Record<string, unknown>) => {
      const page = Number(params?.page ?? 1);
      const pageOf = (items: Record<string, unknown>[]) =>
        items.slice((page - 1) * 100, page * 100);
      if (path === "GET /app") {
        return Promise.resolve({ data: { slug: "postil" } });
      }
      if (path.includes("/comments") && path.includes("pulls")) {
        return Promise.resolve({ data: pageOf(githubMock.reviewComments) });
      }
      if (path.includes("/reviews") && path.startsWith("GET")) {
        return Promise.resolve({ data: pageOf(githubMock.reviews) });
      }
      if (path.includes("/reviews") && path.startsWith("POST")) {
        githubMock.postedReviews.push(params ?? {});
        return Promise.resolve({ data: { id: 99 } });
      }
      if (path === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        return Promise.resolve({ data: { check_runs: githubMock.checkRuns } });
      }
      if (
        path === "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks"
      ) {
        return Promise.resolve({
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
        });
      }
      if (path.includes("/check-runs/") && path.startsWith("PATCH")) {
        githubMock.checkRunUpdates.push(params ?? {});
        return Promise.resolve({ data: { id: Number(params?.check_run_id ?? 0) } });
      }
      if (path.includes("pulls/{pull_number}/merge") && path.startsWith("PUT")) {
        githubMock.mergedPulls.push(params ?? {});
        return Promise.resolve({ data: { merged: true } });
      }
      if (path.includes("/issues/{issue_number}/comments")) {
        return Promise.resolve({ data: pageOf(githubMock.issueComments) });
      }
      if (path.includes("pulls/{pull_number}") && !path.includes("comments")) {
        if ((params?.mediaType as { format?: unknown } | undefined)?.format !== "diff") {
          return Promise.resolve({
            data:
              path === "GET /repos/{owner}/{repo}/pulls/{pull_number}"
                ? { user: githubMock.pullUser, ...githubMock.pullMergeability }
                : { user: githubMock.pullUser },
          });
        }
        return Promise.resolve({ data: "mock-diff-content" });
      }
      return Promise.resolve({ data: [] });
    });

    openRouterMock.body = null;
    openRouterMock.bodies = [];
    openRouterMock.content = '{"summary":"ok","findings":[]}';
    envMock.REVIEW_MODEL = "test/model";
    envMock.REVIEW_MODEL_CASCADE = undefined;
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr?.includes("openrouter")) {
        openRouterMock.body = init ? JSON.parse(init.body as string) : null;
        openRouterMock.bodies.push(openRouterMock.body);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: openRouterMock.content } }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
  });

  it("includes newest substantive review context in the OpenRouter prompt", async () => {
    await runReview(PAYLOAD);

    expect(openRouterMock.body).not.toBeNull();
    const body = openRouterMock.body as {
      messages?: { role: string; content: string }[];
    };
    const content = body.messages?.find((m) => m.role === "user")?.content ?? "";

    expect(content).toContain("Review events:");
    expect(content).toContain("Human review feedback (newest first):");
    expect(content).toContain("This still needs a regression test.");
    expect(content).toContain("Please keep the guard clause here.");
    expect(content).toContain("Approve without commentary unless something concrete to say");
    expect(content).not.toContain("reviewer-empty");
    expect(content.indexOf("This still needs a regression test.")).toBeLessThan(
      content.indexOf("Please keep the guard clause here."),
    );
    expect(content).toContain("Inline comments:");
    expect(content).toContain("src/index.ts");
    expect(content).toContain("PR comments:");
    expect(content).toContain("contributor-carol");
    expect(content).toContain("mock-diff-content");
  });

  it("excludes self-authored review comments from the OpenRouter prompt", async () => {
    githubMock.reviews.push({
      id: 99,
      state: "COMMENTED",
      user: { login: "postil[bot]", type: "Bot" },
      body: "ok\n\nPostil status: needs-attention | errors=1 warnings=0 info=0 inline_comments=1",
      commit_id: "pqr678",
      submitted_at: "2026-05-18T06:00:00Z",
    });
    githubMock.reviewComments.push({
      id: 100,
      pull_request_review_id: 99,
      user: { login: "postil[bot]", type: "Bot" },
      path: "src/self.ts",
      line: 8,
      body: "Previous generated review should not be reviewed again.",
      created_at: "2026-05-18T06:01:00Z",
    });
    githubMock.reviewComments.push({
      id: 101,
      pull_request_review_id: 99,
      user: { login: "reviewer-henry", type: "User" },
      path: "src/self.ts",
      line: 9,
      body: "Human reply on the generated thread should stay visible.",
      created_at: "2026-05-18T06:01:30Z",
    });
    githubMock.reviewComments.push({
      id: 102,
      pull_request_review_id: 99,
      user: { login: "third-party[bot]", type: "Bot" },
      path: "src/self.ts",
      line: 10,
      body: "Third-party bot reply on the thread should stay visible.",
      created_at: "2026-05-18T06:01:45Z",
    });
    githubMock.issueComments.push({
      id: 103,
      user: { login: "postil[bot]", type: "Bot" },
      body: "ok\n\nPostil status: clean | errors=0 warnings=0 info=0 inline_comments=0",
      created_at: "2026-05-18T06:02:00Z",
    });

    await runReview(PAYLOAD);

    const body = openRouterMock.body as {
      messages?: { role: string; content: string }[];
    };
    const content = body.messages?.find((m) => m.role === "user")?.content ?? "";

    expect(content).toContain("Consider using a constant here.");
    expect(content).toContain("Addressed in latest push!");
    expect(content).not.toContain("Previous generated review should not be reviewed again.");
    expect(content).toContain("Human reply on the generated thread should stay visible.");
    expect(content).toContain("Third-party bot reply on the thread should stay visible.");
    expect(content).not.toContain("Postil status:");
  });

  it("keeps external review context when it quotes the status marker", async () => {
    githubMock.reviews.push({
      id: 102,
      state: "CHANGES_REQUESTED",
      user: { login: "reviewer-eve", type: "User" },
      body: "Copied output: Postil status: needs-attention, but the real blocker remains.",
      commit_id: "stu901",
      submitted_at: "2026-05-18T06:10:00Z",
    });
    githubMock.reviewComments.push({
      id: 103,
      pull_request_review_id: 102,
      user: { login: "reviewer-eve", type: "User" },
      path: "src/human.ts",
      line: 12,
      body: "Human follow-up inline note should stay visible.",
      created_at: "2026-05-18T06:11:00Z",
    });
    githubMock.issueComments.push({
      id: 104,
      user: { login: "reviewer-eve", type: "User" },
      body: "Postil status: copied into a human PR comment.",
      created_at: "2026-05-18T06:12:00Z",
    });
    githubMock.reviews.push({
      id: 105,
      state: "COMMENTED",
      user: { login: "third-party[bot]", type: "Bot" },
      body: "Third-party bot quoting Postil status: clean should stay visible.",
      commit_id: "vwx234",
      submitted_at: "2026-05-18T06:13:00Z",
    });

    await runReview(PAYLOAD);

    const body = openRouterMock.body as {
      messages?: { role: string; content: string }[];
    };
    const content = body.messages?.find((m) => m.role === "user")?.content ?? "";

    expect(content).toContain("Copied output: Postil status: needs-attention");
    expect(content).toContain("Human follow-up inline note should stay visible.");
    expect(content).toContain("Postil status: copied into a human PR comment.");
    expect(content).toContain("Third-party bot quoting Postil status: clean");
    expect(content).toContain("Outstanding change requests: @reviewer-eve");
  });

  it("keeps external dismissal messages attached to generated reviews", async () => {
    githubMock.reviews = [
      {
        id: 106,
        state: "DISMISSED",
        user: { login: "postil[bot]", type: "Bot" },
        body: "ok\n\nPostil status: clean | errors=0 warnings=0 info=0 inline_comments=0",
        dismissal_message: "Dismissed by a human because the generated review is stale.",
        dismissed_by: { login: "reviewer-frank", type: "User" },
        commit_id: "yz0123",
        submitted_at: "2026-05-18T06:14:00Z",
      },
    ];
    githubMock.reviewComments = [
      {
        id: 107,
        pull_request_review_id: 106,
        user: { login: "postil[bot]", type: "Bot" },
        path: "src/generated.ts",
        line: 3,
        body: "Generated inline comment should still be hidden.",
        created_at: "2026-05-18T06:15:00Z",
      },
    ];
    githubMock.issueComments = [];

    await runReview(PAYLOAD);

    const body = openRouterMock.body as {
      messages?: { role: string; content: string }[];
    };
    const content = body.messages?.find((m) => m.role === "user")?.content ?? "";

    expect(content).toContain("Dismissed by a human because the generated review is stale.");
    expect(content).toContain("reviewer-frank");
    expect(content).not.toContain("Generated inline comment should still be hidden.");
    expect(content).not.toContain("Postil status:");
  });

  it("does not post on a self-authored PR when only generated context remains", async () => {
    githubMock.pullUser = { login: "postil[bot]", type: "Bot" };
    githubMock.reviews = [
      {
        id: 108,
        state: "COMMENTED",
        user: { login: "postil[bot]", type: "Bot" },
        body: "ok\n\nPostil status: clean | errors=0 warnings=0 info=0 inline_comments=0",
        commit_id: "abc999",
        submitted_at: "2026-05-18T06:16:00Z",
      },
    ];
    githubMock.reviewComments = [
      {
        id: 109,
        pull_request_review_id: 108,
        user: { login: "postil[bot]", type: "Bot" },
        path: "src/generated.ts",
        line: 4,
        body: "Generated inline comment should not keep posting alive.",
        created_at: "2026-05-18T06:17:00Z",
      },
    ];
    githubMock.issueComments = [
      {
        id: 110,
        user: { login: "postil[bot]", type: "Bot" },
        body: "ok\n\nPostil status: clean | errors=0 warnings=0 info=0 inline_comments=0",
        created_at: "2026-05-18T06:18:00Z",
      },
    ];

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(latestPostedReview()).toBeUndefined();
    expect(openRouterMock.body).toBeNull();
    expect(latestCheckRunUpdate()).toMatchObject({
      conclusion: "success",
      output: {
        title: "No issues",
        text: "No issues found.",
      },
    });
    expect(
      githubMock.request.mock.calls.some(
        ([path]) =>
          typeof path === "string" &&
          path.startsWith("POST") &&
          path.includes("/issues/{issue_number}/comments"),
      ),
    ).toBe(false);
  });

  it("does not wake the model for non-marker self-authored issue comments", async () => {
    githubMock.pullUser = { login: "postil[bot]", type: "Bot" };
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [
      {
        id: 111,
        user: { login: "postil[bot]", type: "Bot" },
        body: "Tracking this manually for now.",
        created_at: "2026-05-18T06:19:30Z",
      },
    ];

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(latestPostedReview()).toBeUndefined();
    expect(openRouterMock.body).toBeNull();
    expect(latestCheckRunUpdate()).toMatchObject({
      conclusion: "success",
      output: {
        title: "No issues",
        text: "No issues found.",
      },
    });
  });

  it("falls back when app identity lookup fails", async () => {
    githubMock.request.mockImplementationOnce((path: string) => {
      if (path === "GET /app") {
        return Promise.reject(new Error("app identity unavailable"));
      }
      return Promise.resolve({ data: [] });
    });

    await runReview(PAYLOAD);

    expect(openRouterMock.body).not.toBeNull();
    expect(latestPostedReview()).toMatchObject({
      event: "APPROVE",
      body: "ok\n\nPostil status: clean | errors=0 warnings=0 info=0 inline_comments=0",
    });
  });

  it("keeps reviewing when review context fetch fails on a self-authored PR", async () => {
    const baseImpl = githubMock.request.getMockImplementation();
    githubMock.request.mockImplementation((path: string, params?: Record<string, unknown>) => {
      if (typeof path === "string" && path.startsWith("GET") && path.includes("/reviews")) {
        return Promise.reject(new Error("review context unavailable"));
      }
      return baseImpl?.(path, params) ?? Promise.resolve({ data: [] });
    });
    githubMock.pullUser = { login: "postil[bot]", type: "Bot" };
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];

    await runReview(PAYLOAD);

    expect(openRouterMock.body).not.toBeNull();
    expect(latestPostedReview()).toMatchObject({
      event: "APPROVE",
    });
  });

  it("can post on a self-authored PR after external review activity", async () => {
    githubMock.pullUser = { login: "postil[bot]", type: "Bot" };
    githubMock.reviews = [
      {
        id: 111,
        state: "COMMENTED",
        user: { login: "reviewer-grace", type: "User" },
        body: "Please keep the regression coverage.",
        commit_id: "def999",
        submitted_at: "2026-05-18T06:19:00Z",
      },
    ];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];
    openRouterMock.content = JSON.stringify({
      summary: "Needs work.",
      findings: [
        {
          path: "src/self.ts",
          line: 7,
          severity: "error",
          body: "This should fail.",
        },
      ],
    });

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(latestPostedReview()).toMatchObject({
      event: "COMMENT",
      body: "Needs work.\n\nPostil status: needs-attention | errors=1 warnings=0 info=0 inline_comments=1",
    });
    expect(latestCheckRunUpdate()).toMatchObject({
      conclusion: "failure",
      output: {
        title: "1 error",
        text: "See inline review comments.",
      },
    });
  });

  it("uses the single review model when no cascade is configured", async () => {
    const result = await runReview(PAYLOAD);

    expect(result.modelUsed).toBe("test/model");
    expect(openRouterMock.body).toMatchObject({ model: "test/model" });
  });

  it("uses the first configured review model in the cascade", async () => {
    envMock.REVIEW_MODEL_CASCADE = "test/primary,test/backup";

    const result = await runReview(PAYLOAD);

    expect(result.modelUsed).toBe("test/primary");
    expect(openRouterMock.body).toMatchObject({ model: "test/primary" });
  });

  it("falls back to the next configured review model after a provider error", async () => {
    envMock.REVIEW_MODEL_CASCADE = "test/primary, test/backup";
    fetchSpy.mockImplementationOnce(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr?.includes("openrouter")) {
        const body = init ? JSON.parse(init.body as string) : null;
        openRouterMock.body = body;
        openRouterMock.bodies.push(body);
        return new Response("rate limited", { status: 429 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await runReview(PAYLOAD);

    expect(result.modelUsed).toBe("test/backup");
    expect(openRouterMock.bodies).toMatchObject([
      { model: "test/primary" },
      { model: "test/backup" },
    ]);
  });

  it("stops the review model cascade when the shared timeout budget is spent", async () => {
    envMock.REVIEW_MODEL_CASCADE = "test/primary, test/backup, test/late";
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr?.includes("openrouter")) {
        const body = init ? JSON.parse(init.body as string) : null;
        openRouterMock.body = body;
        openRouterMock.bodies.push(body);
        now = openRouterMock.bodies.length === 1 ? 359_999 : 360_000;
        return new Response("rate limited", { status: 429 });
      }
      return new Response("not found", { status: 404 });
    });

    const error = await runReview(PAYLOAD).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "openrouter model cascade failed after all configured providers were unavailable",
    );
    expect(error).toMatchObject({
      modelUsed: "test/backup",
      attemptedModels: ["test/primary", "test/backup"],
    });
    expect((error as { providerFailures?: unknown[] }).providerFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "test/late", reason: "skipped after cascade timeout" }),
      ]),
    );

    expect(openRouterMock.bodies).toMatchObject([
      { model: "test/primary" },
      { model: "test/backup" },
    ]);
    nowSpy.mockRestore();
  });

  it("aborts an in-flight provider request when the shared cascade budget expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    envMock.REVIEW_MODEL_CASCADE = "test/primary, test/backup, test/slow";
    const providerSignals: AbortSignal[] = [];

    fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (!urlStr?.includes("openrouter")) {
        return new Response("not found", { status: 404 });
      }

      const body = init ? JSON.parse(init.body as string) : null;
      openRouterMock.body = body;
      openRouterMock.bodies.push(body);
      if (init?.signal) providerSignals.push(init.signal);

      if (openRouterMock.bodies.length <= 2) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response("rate limited", { status: 429 })), 121_000);
        });
      }

      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const errorPromise = runReview(PAYLOAD).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(121_000);
    await vi.advanceTimersByTimeAsync(121_000);
    await vi.advanceTimersByTimeAsync(118_000);
    const error = await errorPromise;

    expect(providerSignals.at(-1)?.aborted).toBe(true);
    expect(error).toMatchObject({
      modelUsed: "test/slow",
      attemptedModels: ["test/primary", "test/backup", "test/slow"],
    });
    expect((error as { providerFailures?: unknown[] }).providerFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "test/slow", reason: "cascade timeout" }),
      ]),
    );
  });

  it("keeps provider failure bodies out of check-run failure output", async () => {
    envMock.REVIEW_MODEL_CASCADE = "test/primary";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchSpy.mockImplementationOnce(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr?.includes("openrouter")) {
        openRouterMock.body = init ? JSON.parse(init.body as string) : null;
        openRouterMock.bodies.push(openRouterMock.body);
        return new Response("provider said: account quota diagnostic-value", { status: 429 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(runReview({ ...PAYLOAD, checkRunId: 77 })).rejects.toThrow(
      "openrouter model cascade failed after all configured providers were unavailable",
    );

    expect(latestCheckRunUpdate()).toMatchObject({
      conclusion: "failure",
      output: {
        summary: "Review failed after all configured model providers were unavailable.",
        text: "Review failed after all configured model providers were unavailable.",
      },
    });
    expect(JSON.stringify(latestCheckRunUpdate())).not.toContain("account quota diagnostic-value");
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("account quota diagnostic-value");
    expect(warnSpy).toHaveBeenCalledWith(
      "[openrouter] model request failed",
      expect.objectContaining({
        model: "test/primary",
        reason: "provider returned an error",
        status: 429,
      }),
    );
    warnSpy.mockRestore();
  });

  it("sanitizes setup failures before stderr or telemetry can see raw diagnostics", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(configModule.loadReviewConfig).mockRejectedValueOnce(
      new Error("setup auth failed: diagnostic-value"),
    );

    await expect(runReview({ ...PAYLOAD, checkRunId: 77 })).rejects.toThrow(
      "Review failed to complete.",
    );

    expect(latestCheckRunUpdate()).toMatchObject({
      conclusion: "failure",
      output: {
        summary: "Review failed to complete.",
        text: "Review failed to complete.",
      },
    });
    expect(JSON.stringify(githubMock.checkRunUpdates)).not.toContain("diagnostic-value");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("diagnostic-value");
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("diagnostic-value");
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("ends clean posted reviews with a status line", async () => {
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];

    await runReview(PAYLOAD);

    expect(latestPostedReview()).toMatchObject({
      event: "APPROVE",
      body: "ok\n\nPostil status: clean | errors=0 warnings=0 info=0 inline_comments=0",
    });
  });

  it("ends findings reviews with a status line", async () => {
    openRouterMock.content = JSON.stringify({
      summary: "Needs work.",
      findings: [
        {
          path: "src/index.ts",
          line: 42,
          severity: "warn",
          body: "This can throw.",
        },
        {
          path: "src/index.ts",
          line: 43,
          severity: "info",
          body: "Consider clarifying this.",
        },
      ],
    });

    await runReview(PAYLOAD);

    expect(latestPostedReview()).toMatchObject({
      event: "COMMENT",
      body:
        "Needs work.\n\n" +
        "Postil status: needs-attention | errors=0 warnings=1 info=1 inline_comments=2",
    });
  });

  it("does not auto-approve clean results while human change requests are outstanding", async () => {
    githubMock.reviewComments = [];
    githubMock.issueComments = [];
    githubMock.reviews = [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: { login: "reviewer-alice" },
        body: "Please keep the guard clause here.",
        commit_id: "abc123",
        submitted_at: "2026-05-18T01:00:00Z",
      },
      {
        id: 2,
        state: "COMMENTED",
        user: { login: "reviewer-dana" },
        body: "This still needs a regression test.",
        commit_id: "jkl012",
        submitted_at: "2026-05-18T04:00:00Z",
      },
    ];

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    const postedReview = latestPostedReview();
    expect(postedReview).toMatchObject({
      event: "COMMENT",
      body: "ok\n\nPostil status: needs-attention | errors=0 warnings=0 info=0 inline_comments=0",
    });
    expect(latestCheckRunUpdate()).toMatchObject({
      conclusion: "failure",
      output: {
        title: "1 change request",
        summary: expect.stringContaining("Outstanding change requests: @reviewer-alice"),
        text: "Outstanding change requests: @reviewer-alice",
      },
    });
  });

  it("still approves clean results while commented reviews remain", async () => {
    githubMock.reviews = [
      {
        id: 1,
        state: "COMMENTED",
        user: { login: "reviewer-dana" },
        body: "This still needs a regression test.",
        commit_id: "jkl012",
        submitted_at: "2026-05-18T04:00:00Z",
      },
    ];

    await runReview(PAYLOAD);

    expect(latestPostedReview()).toMatchObject({
      event: "APPROVE",
      body: "ok\n\nPostil status: clean | errors=0 warnings=0 info=0 inline_comments=0",
    });
  });

  it("still approves clean results while inline or PR comments remain", async () => {
    githubMock.reviews = [];
    githubMock.reviewComments = [
      {
        id: 10,
        user: { login: "reviewer-alice" },
        path: "src/index.ts",
        line: 42,
        body: "Consider using a constant here.",
        created_at: "2026-05-18T02:30:00Z",
      },
    ];
    githubMock.issueComments = [
      {
        id: 20,
        user: { login: "contributor-carol" },
        body: "Addressed in latest push!",
        created_at: "2026-05-18T03:30:00Z",
      },
    ];

    await runReview(PAYLOAD);

    expect(latestPostedReview()).toMatchObject({
      event: "APPROVE",
      body: "ok\n\nPostil status: clean | errors=0 warnings=0 info=0 inline_comments=0",
    });
  });

  it("lets dismissed change requests stop blocking approval", async () => {
    githubMock.reviewComments = [];
    githubMock.issueComments = [];
    githubMock.reviews = [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: { login: "reviewer-alice" },
        body: "Please keep the guard clause here.",
        commit_id: "abc123",
        submitted_at: "2026-05-18T01:00:00Z",
      },
      {
        id: 2,
        state: "DISMISSED",
        user: { login: "reviewer-alice" },
        body: "Dismissed after follow-up.",
        commit_id: "def456",
        dismissal_message: "No longer relevant",
        submitted_at: "2026-05-18T02:00:00Z",
      },
    ];

    await runReview(PAYLOAD);

    expect(latestPostedReview()).toMatchObject({
      event: "APPROVE",
      body: "ok\n\nPostil status: clean | errors=0 warnings=0 info=0 inline_comments=0",
    });
  });

  it("keeps a human change request active when a bot review is dismissed", async () => {
    githubMock.reviewComments = [];
    githubMock.issueComments = [];
    githubMock.reviews = [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: { login: "reviewer-frank" },
        body: "Please keep the guard clause here.",
        commit_id: "abc123",
        submitted_at: "2026-05-18T01:00:00Z",
      },
      {
        id: 2,
        state: "DISMISSED",
        user: { login: "postil[bot]", type: "Bot" },
        body: "ok\n\nPostil status: clean | errors=0 warnings=0 info=0 inline_comments=0",
        dismissal_message: "Dismissed after follow-up.",
        dismissed_by: { login: "reviewer-frank", type: "User" },
        commit_id: "def456",
        submitted_at: "2026-05-18T02:00:00Z",
      },
    ];

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(latestCheckRunUpdate()).toMatchObject({
      conclusion: "failure",
      output: {
        title: "1 change request",
        text: "Outstanding change requests: @reviewer-frank",
      },
    });
  });

  it("paginates review history before reducing substantive feedback", async () => {
    githubMock.reviewComments = [];
    githubMock.issueComments = [];
    githubMock.reviews = [
      ...Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        state: "COMMENTED",
        user: { login: `reviewer-empty-${i}` },
        body: "",
        commit_id: `empty-${i}`,
        submitted_at: `2026-05-18T05:${String(i % 60).padStart(2, "0")}:00Z`,
      })),
      {
        id: 101,
        state: "COMMENTED",
        user: { login: "reviewer-page-two" },
        body: "Second page feedback still matters.",
        commit_id: "page-two",
        submitted_at: "2026-05-18T04:00:00Z",
      },
    ];

    await runReview(PAYLOAD);

    const body = openRouterMock.body as {
      messages?: { role: string; content: string }[];
    };
    const content = body.messages?.find((m) => m.role === "user")?.content ?? "";
    expect(content).toContain("Second page feedback still matters.");
    expect(content).toContain("reviewer-page-two");
  });

  it("respects on_clean skip only when no human feedback needs attention", async () => {
    configMock.review.on_clean = "skip";
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];

    await runReview(PAYLOAD);

    expect(latestPostedReview()).toBeUndefined();

    githubMock.reviews = [
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        user: { login: "reviewer-dana" },
        body: "This still needs a regression test.",
        commit_id: "jkl012",
        submitted_at: "2026-05-18T04:00:00Z",
      },
    ];

    await runReview(PAYLOAD);

    expect(latestPostedReview()).toMatchObject({
      event: "COMMENT",
      body: "ok\n\nPostil status: needs-attention | errors=0 warnings=0 info=0 inline_comments=0",
    });
  });

  it("completes the review check before auto-merging clean approvals", async () => {
    configMock.review.auto_merge = true;
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(githubMock.mergedPulls).toHaveLength(1);
    const checkRunIndex = githubMock.request.mock.calls.findIndex(
      ([path]) => typeof path === "string" && path.includes("/check-runs/"),
    );
    const mergeIndex = githubMock.request.mock.calls.findIndex(
      ([path]) => typeof path === "string" && path.includes("pulls/{pull_number}/merge"),
    );
    expect(checkRunIndex).toBeGreaterThan(-1);
    expect(mergeIndex).toBeGreaterThan(checkRunIndex);
    expect(latestCheckRunUpdate()).toMatchObject({ conclusion: "success" });
  });

  it("checks successful same-head required results before auto-merging", async () => {
    configMock.review.auto_merge = true;
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    const requiredCheckIndex = githubMock.request.mock.calls.findIndex(
      ([path]) => path === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    );
    const mergeIndex = githubMock.request.mock.calls.findIndex(
      ([path]) => typeof path === "string" && path.includes("pulls/{pull_number}/merge"),
    );
    expect(requiredCheckIndex).toBeGreaterThan(-1);
    expect(mergeIndex).toBeGreaterThan(requiredCheckIndex);
    expect(githubMock.request.mock.calls[requiredCheckIndex]?.[1]).toMatchObject({
      ref: PAYLOAD.headSha,
    });
  });

  it("does not wait on the review verifier before auto-merging", async () => {
    configMock.review.auto_merge = true;
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];
    githubMock.checkRuns = githubMock.checkRuns.map((run) =>
      run.name === "Verify postil/review passed"
        ? { ...run, status: "in_progress", conclusion: null }
        : run,
    );

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(githubMock.mergedPulls).toHaveLength(1);
    const checkedRef = githubMock.request.mock.calls.find(
      ([path]) => path === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    )?.[1] as { ref?: string } | undefined;
    expect(checkedRef).toMatchObject({ ref: PAYLOAD.headSha });
    expect(latestCheckRunUpdate()).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
  });

  it("uses branch protection checks when config does not specify them", async () => {
    configMock.review.auto_merge = true;
    configMock.review.required_checks = [];
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(githubMock.mergedPulls).toHaveLength(1);
    expect(
      githubMock.request.mock.calls.some(
        ([path]) =>
          path === "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "pending",
      (runs: Record<string, unknown>[]) =>
        runs.map((run) =>
          run.name === "Build" ? { ...run, status: "in_progress", conclusion: null } : run,
        ),
    ],
    [
      "missing",
      (runs: Record<string, unknown>[]) => runs.filter((run) => run.name !== "Docker build"),
    ],
    [
      "failing",
      (runs: Record<string, unknown>[]) =>
        runs.map((run) => (run.name === "Unit tests" ? { ...run, conclusion: "failure" } : run)),
    ],
    [
      "wrong head",
      (runs: Record<string, unknown>[]) =>
        runs.map((run) =>
          run.name === "postil/review" ? { ...run, head_sha: "different-sha" } : run,
        ),
    ],
  ])("does not auto-merge when a required check is %s", async (_label, mutateRuns) => {
    configMock.review.auto_merge = true;
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];
    githubMock.checkRuns = mutateRuns(githubMock.checkRuns);

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(githubMock.mergedPulls).toHaveLength(0);
    expect(latestCheckRunUpdate()).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
    expect(
      githubMock.request.mock.calls.some(
        ([path]) => typeof path === "string" && path.includes("pulls/{pull_number}/merge"),
      ),
    ).toBe(false);
  });

  it("waits for the E2E job when the PR is labeled for E2E", async () => {
    configMock.review.auto_merge = true;
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];
    githubMock.pullMergeability = {
      mergeable: true,
      mergeable_state: "clean",
      head: { sha: "abc123def456" },
      base: { ref: "main" },
      labels: [{ name: "e2e" }],
    };

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(githubMock.mergedPulls).toHaveLength(0);
    expect(
      githubMock.request.mock.calls.some(
        ([path]) => typeof path === "string" && path.includes("pulls/{pull_number}/merge"),
      ),
    ).toBe(false);
  });

  it("does not auto-merge when the pull head changed after review", async () => {
    configMock.review.auto_merge = true;
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];
    githubMock.pullMergeability = {
      mergeable: true,
      mergeable_state: "clean",
      head: { sha: "new-head-sha" },
      base: { ref: "main" },
    };

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(githubMock.mergedPulls).toHaveLength(0);
    expect(
      githubMock.request.mock.calls.some(
        ([path]) => path === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      ),
    ).toBe(false);
  });

  it("does not auto-merge when the review check cannot be completed", async () => {
    configMock.review.auto_merge = true;
    githubMock.reviews = [];
    githubMock.reviewComments = [];
    githubMock.issueComments = [];
    const baseImpl = githubMock.request.getMockImplementation();
    githubMock.request.mockImplementation((path: string, params?: Record<string, unknown>) => {
      if (typeof path === "string" && path.includes("/check-runs/") && path.startsWith("PATCH")) {
        return Promise.reject(new Error("check update failed"));
      }
      return baseImpl?.(path, params) ?? Promise.resolve({ data: [] });
    });

    await runReview({ ...PAYLOAD, checkRunId: 77 });

    expect(githubMock.mergedPulls).toHaveLength(0);
    expect(
      githubMock.request.mock.calls.some(
        ([path]) => typeof path === "string" && path.includes("pulls/{pull_number}/merge"),
      ),
    ).toBe(false);
  });
});
