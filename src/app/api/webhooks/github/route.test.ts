import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequest = vi.fn();

vi.mock("@/lib/env", () => ({
  env: {
    CI_RECOVERY_FALLBACK_ASSIGNEE: "engineer",
    GITHUB_WEBHOOK_SECRET: "test-secret",
  },
}));

vi.mock("@/db", () => ({
  getDb: () => ({
    insert: () => ({ values: async () => undefined }),
    query: { reviews: { findFirst: async () => undefined } },
  }),
  schema: { webhookDeliveries: {}, reviews: {} },
}));

vi.mock("@/lib/github", () => ({
  installationOctokit: vi.fn(async () => ({ request: mockRequest })),
}));

vi.mock("@/lib/posthog", () => ({
  captureException: vi.fn(),
  track: vi.fn(),
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
});
