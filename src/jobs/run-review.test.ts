import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock env first so the module uses test values
vi.mock("@/lib/env", () => ({
  env: {
    OPENROUTER_API_KEY: "test-openrouter-key",
    REVIEW_MODEL: "test/model",
    NODE_ENV: "test",
  },
}));

// Track the last OpenRouter request body to assert on it
let capturedOpenRouterBody: unknown = null;

vi.mock("@/lib/github", () => ({
  installationOctokit: vi.fn().mockResolvedValue({
    request: vi.fn().mockImplementation((path: string) => {
      // Return mock review comments (must check before /reviews so it doesn't
      // get caught by the broader "/reviews" substring match)
      if (path.includes("/comments") && path.includes("pulls")) {
        return Promise.resolve({
          data: [
            {
              id: 10,
              user: { login: "reviewer-alice" },
              path: "src/index.ts",
              line: 42,
              body: "Consider using a constant here.",
            },
          ],
        });
      }
      // Return mock reviews: one APPROVED, one DISMISSED with dismissal message
      if (path.includes("/reviews")) {
        return Promise.resolve({
          data: [
            {
              id: 1,
              state: "APPROVED",
              user: { login: "reviewer-alice" },
              body: "LGTM, nice fix",
              commit_id: "abc123",
            },
            {
              id: 2,
              state: "DISMISSED",
              user: { login: "reviewer-bob" },
              body: "Please address the comments",
              commit_id: "def456",
              dismissal_message: "Approve without commentary unless something concrete to say",
            },
          ],
        });
      }
      // Return mock issue comments
      if (path.includes("/issues/{issue_number}/comments")) {
        return Promise.resolve({
          data: [
            {
              id: 20,
              user: { login: "contributor-carol" },
              body: "Addressed in latest push!",
            },
          ],
        });
      }
      // Return mock PR diff
      if (path.includes("pulls/{pull_number}") && !path.includes("comments")) {
        return Promise.resolve({ data: "mock-diff-content" });
      }
      return Promise.resolve({ data: [] });
    }),
  }),
}));

vi.mock("@/lib/config", () => ({
  loadReviewConfig: vi.fn().mockResolvedValue({
    config: {
      enabled: true,
      severityThreshold: "warn" as const,
      ignore: [],
      maxFindings: 20,
      review: {
        enabled: true,
        on_clean: "approve" as const,
        auto_merge: false,
      },
    },
  }),
}));

// Spy on global fetch for OpenRouter
const fetchSpy = vi.spyOn(globalThis, "fetch");

// Import runReview after all mocks are set up
const { runReview } = await import("./run-review");

const PAYLOAD = {
  installationId: 1,
  repoFullName: "owner/repo",
  pullNumber: 5,
  headSha: "abc123def456",
  checkRunId: undefined as number | undefined,
  reviewId: undefined as string | undefined,
};

describe("runReview", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    capturedOpenRouterBody = null;
    fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr?.includes("openrouter")) {
        capturedOpenRouterBody = init ? JSON.parse(init.body as string) : null;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"summary":"ok","findings":[]}' } }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
  });

  it("includes PR review thread context in the OpenRouter prompt", async () => {
    await runReview(PAYLOAD);

    expect(capturedOpenRouterBody).not.toBeNull();
    const body = capturedOpenRouterBody as {
      messages?: { role: string; content: string }[];
    };
    const userMessage = body.messages?.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();

    const content = userMessage!.content;
    // Should include the prior review thread
    expect(content).toContain("Existing reviews:");
    // Should include the APPROVED review
    expect(content).toContain("reviewer-alice");
    expect(content).toContain("APPROVED");
    // Should include the DISMISSED review
    expect(content).toContain("reviewer-bob");
    expect(content).toContain("DISMISSED");
    // Should include the dismissal message
    expect(content).toContain("Approve without commentary unless something concrete to say");
    // Should include inline review comment
    expect(content).toContain("Inline comments (unresolved):");
    expect(content).toContain("src/index.ts");
    expect(content).toContain("42");
    // Should include issue comment
    expect(content).toContain("PR comments:");
    expect(content).toContain("contributor-carol");
    // Should still include the diff
    expect(content).toContain("mock-diff-content");
  });
});
