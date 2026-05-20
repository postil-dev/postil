import { beforeEach, describe, expect, it, vi } from "vitest";

const githubMock = vi.hoisted(() => ({
  request: vi.fn(),
  reviews: [] as Record<string, unknown>[],
  reviewComments: [] as Record<string, unknown>[],
  issueComments: [] as Record<string, unknown>[],
  postedReviews: [] as Record<string, unknown>[],
  checkRunUpdates: [] as Record<string, unknown>[],
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
  },
}));

const envMock = vi.hoisted(() => ({
  OPENROUTER_API_KEY: "test-openrouter-key",
  REVIEW_MODEL: "test/model",
  REVIEW_MODEL_CASCADE: undefined as string | undefined,
  NODE_ENV: "test",
}));

vi.mock("@/lib/env", () => ({
  env: envMock,
}));

vi.mock("@/lib/github", () => ({
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
    configMock.review = {
      enabled: true,
      on_clean: "approve",
      auto_merge: false,
    };
    githubMock.request.mockReset();
    githubMock.request.mockImplementation((path: string, params?: Record<string, unknown>) => {
      const page = Number(params?.page ?? 1);
      const pageOf = (items: Record<string, unknown>[]) =>
        items.slice((page - 1) * 100, page * 100);
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
      if (path.includes("/check-runs/") && path.startsWith("PATCH")) {
        githubMock.checkRunUpdates.push(params ?? {});
        return Promise.resolve({ data: { id: Number(params?.check_run_id ?? 0) } });
      }
      if (path.includes("/issues/{issue_number}/comments")) {
        return Promise.resolve({ data: pageOf(githubMock.issueComments) });
      }
      if (path.includes("pulls/{pull_number}") && !path.includes("comments")) {
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
});
