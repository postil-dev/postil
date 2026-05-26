import { describe, expect, it, vi } from "vitest";
import { loadReviewConfig } from "./config";

function octokitWithFile(path: string, body: string) {
  return {
    request: vi.fn(async (_route: string, params: { path: string }) => {
      if (params.path === path) return { data: body };
      const err = new Error("not found") as Error & { status: number };
      err.status = 404;
      throw err;
    }),
  };
}

describe("loadReviewConfig", () => {
  it("defaults clean reviews to skip", async () => {
    const octokit = {
      request: vi.fn(async () => {
        const err = new Error("not found") as Error & { status: number };
        err.status = 404;
        throw err;
      }),
    };

    const { config, source } = await loadReviewConfig(
      octokit as never,
      "owner",
      "repo",
      "head-sha",
    );

    expect(source).toBe("built-in-defaults");
    expect(config.review.on_clean).toBe("skip");
  });

  it("normalizes CLI camelCase review settings for backend auto-merge", async () => {
    const octokit = octokitWithFile(
      ".postil.yaml",
      [
        "review:",
        "  onClean: skip",
        "  autoMerge: true",
        "  requiredChecks:",
        "    - postil/review",
        "  autoMergeTimeoutMs: 30000",
      ].join("\n"),
    );

    const { config, source } = await loadReviewConfig(
      octokit as never,
      "owner",
      "repo",
      "head-sha",
    );

    expect(source).toBe(".postil.yaml");
    expect(config.review).toEqual({
      enabled: true,
      on_clean: "skip",
      auto_merge: true,
      required_checks: ["postil/review"],
      auto_merge_timeout_ms: 30000,
    });
  });
});
