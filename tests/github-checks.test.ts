import { afterEach, describe, expect, test } from "bun:test";

import {
  completeExpectedCheckRun,
  createCheckRun,
  findCheckRunByExternalId,
  findIssueCommentByMarker,
  getPullRequestReviewContext,
  RESPOND_MARKER_MAX_PAGES,
  verifyCompletedCheckRun,
} from "@/lib/github/checks";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function comments(count: number, page: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: page * 1_000 + index,
    body: `comment ${page}-${index}`,
  }));
}

describe("respond delivery marker lookup", () => {
  test("finds a marker after the first 100 issue comments", async () => {
    const requestedPages: number[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      const body = comments(page === 1 ? 100 : 4, page);
      if (page === 2) body[2]!.body += " <!-- postil-respond-job:42 -->";
      return Response.json(body);
    }) as typeof fetch;

    const found = await findIssueCommentByMarker(
      "token",
      "postil-dev/postil",
      7,
      "<!-- postil-respond-job:42 -->",
      new Date("2026-07-13T00:00:00.000Z"),
    );

    expect(found).toBe(2_002);
    expect(requestedPages).toEqual([1, 2]);
  });

  test("fails closed after the bounded search window is full", async () => {
    const requestedPages: number[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      return Response.json(comments(100, page));
    }) as typeof fetch;

    const lookup = findIssueCommentByMarker(
      "token",
      "postil-dev/postil",
      7,
      "<!-- postil-respond-job:missing -->",
      new Date("2026-07-13T00:00:00.000Z"),
    );

    await expect(lookup).rejects.toThrow("marker search is inconclusive");
    expect(requestedPages).toHaveLength(RESPOND_MARKER_MAX_PAGES);
    expect(requestedPages.at(-1)).toBe(RESPOND_MARKER_MAX_PAGES);
  });

  test("returns null when a short page proves the search is exhausted", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json(comments(3, 1))) as typeof fetch;

    const found = await findIssueCommentByMarker(
      "token",
      "postil-dev/postil",
      7,
      "<!-- postil-respond-job:missing -->",
      new Date("2026-07-13T00:00:00.000Z"),
    );

    expect(found).toBeNull();
  });
});

describe("pull-request review context", () => {
  test("loads immutable refs and optional author identity", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({
        draft: false,
        head: { sha: "head-sha" },
        base: { sha: "base-sha" },
        user: { id: 42, login: "octocat" },
      })) as typeof fetch;

    await expect(
      getPullRequestReviewContext("token", "octo/repo", 7),
    ).resolves.toEqual({
      headSha: "head-sha",
      baseSha: "base-sha",
      draft: false,
      authorGithubId: 42,
      authorLogin: "octocat",
    });
  });

  test("normalizes only a complete bounded author identity", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({
        draft: false,
        head: { sha: "head-sha" },
        base: { sha: "base-sha" },
        user: { id: 0, login: "   " },
      })) as typeof fetch;

    await expect(
      getPullRequestReviewContext("token", "octo/repo", 7),
    ).resolves.toEqual({
      headSha: "head-sha",
      baseSha: "base-sha",
      draft: false,
    });

    globalThis.fetch = (async (_input) =>
      Response.json({
        draft: false,
        head: { sha: "head-sha" },
        base: { sha: "base-sha" },
        user: { id: 42, login: ` ${"a".repeat(101)} ` },
      })) as typeof fetch;

    await expect(
      getPullRequestReviewContext("token", "octo/repo", 7),
    ).resolves.toEqual({
      headSha: "head-sha",
      baseSha: "base-sha",
      draft: false,
      authorGithubId: 42,
    });
  });

  test("fails closed when either immutable ref is absent", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({ head: { sha: "head-sha" }, base: {} })) as typeof fetch;

    await expect(
      getPullRequestReviewContext("token", "octo/repo", 7),
    ).rejects.toThrow("incomplete refs");
  });
});

describe("check-run creation", () => {
  test("forwards a bounded caller cancellation signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const requestSignals: AbortSignal[] = [];
    globalThis.fetch = (async (_input, init) => {
      const requestSignal = init?.signal as AbortSignal | undefined;
      if (requestSignal) requestSignals.push(requestSignal);
      if (requestSignal?.aborted) throw requestSignal.reason;
      return Response.json({ id: 1 });
    }) as typeof fetch;

    await expect(
      createCheckRun("token", "octo/repo", "postil/review", "head-sha", {
        signal: controller.signal,
        externalId: "postil:run:review",
      }),
    ).rejects.toBeDefined();
    expect(requestSignals[0]?.aborted).toBe(true);
  });

  test("reconciles an ambiguous create by external id", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "POST") throw new TypeError("connection reset");
      return Response.json({
        total_count: 1,
        check_runs: [
          { id: 42, name: "postil/review", external_id: "postil:run:review" },
        ],
      });
    }) as typeof fetch;

    await expect(
      createCheckRun("token", "octo/repo", "postil/review", "head-sha", {
        externalId: "postil:run:review",
      }),
    ).resolves.toBe(42);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("/commits/head-sha/check-runs?");
  });

  test("finds a check run by its stable external id", async () => {
    globalThis.fetch = (async (_input, _init) =>
      Response.json({
        total_count: 2,
        check_runs: [
          { id: 1, name: "postil/review", external_id: "another-run" },
          { id: 2, name: "postil/review", external_id: "postil:run:review" },
        ],
      })) as typeof fetch;

    await expect(
      findCheckRunByExternalId(
        "token",
        "octo/repo",
        "head-sha",
        "postil/review",
        "postil:run:review",
      ),
    ).resolves.toBe(2);
  });
});

describe("check-run publication verification", () => {
  const expected = {
    id: 42,
    name: "postil/review",
    externalId: "postil:run:review",
    headSha: "head-sha",
    conclusion: "success" as const,
  };

  test("accepts only the exact completed check-run verdict", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:run:review",
        head_sha: "head-sha",
        status: "completed",
        conclusion: "success",
        output: {
          title: "Review complete",
          summary: "The review completed.",
        },
      })) as typeof fetch;

    await expect(
      verifyCompletedCheckRun("token", "octo/repo", expected),
    ).resolves.toBeUndefined();
  });

  test("rejects pending and partial publication", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:run:review",
        head_sha: "head-sha",
        status: "in_progress",
        conclusion: null,
      })) as typeof fetch;

    await expect(
      verifyCompletedCheckRun("token", "octo/repo", expected),
    ).rejects.toThrow("is not completed");

    globalThis.fetch = (async (_input) =>
      Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:run:review",
        head_sha: "head-sha",
        status: "completed",
        conclusion: null,
      })) as typeof fetch;

    await expect(
      verifyCompletedCheckRun("token", "octo/repo", expected),
    ).rejects.toThrow("expected success");
  });

  test("rejects a terminal verdict with no published output when required", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:run:review",
        head_sha: "head-sha",
        status: "completed",
        conclusion: "success",
        output: { title: "", summary: "" },
      })) as typeof fetch;

    await expect(
      verifyCompletedCheckRun("token", "octo/repo", {
        ...expected,
        requireOutput: true,
      }),
    ).rejects.toThrow("has no published output");
  });

  test("rejects mismatched check identity and verdict", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({
        id: 42,
        name: "postil/gate",
        external_id: "postil:another:gate",
        head_sha: "another-head",
        status: "completed",
        conclusion: "failure",
      })) as typeof fetch;

    await expect(
      verifyCompletedCheckRun("token", "octo/repo", expected),
    ).rejects.toThrow("does not match its review identity");

    globalThis.fetch = (async (_input) =>
      Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:run:review",
        head_sha: "head-sha",
        status: "completed",
        conclusion: "failure",
      })) as typeof fetch;

    await expect(
      verifyCompletedCheckRun("token", "octo/repo", expected),
    ).rejects.toThrow("expected success");
  });

  test("cleanup is idempotent after the exact verdict is terminal", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:run:review",
        head_sha: "head-sha",
        status: "completed",
        conclusion: "success",
        output: {
          title: "Review complete",
          summary: "The review completed.",
        },
      });
    }) as typeof fetch;

    await completeExpectedCheckRun(
      "token",
      "octo/repo",
      expected,
      "Review complete",
      "The review completed.",
    );

    expect(methods).toEqual(["GET"]);
  });

  test("cleanup replaces a stale output even when the conclusion already matches", async () => {
    const methods: string[] = [];
    let patched = false;
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "PATCH") {
        patched = true;
        return new Response(null, { status: 200 });
      }
      return Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:run:review",
        head_sha: "head-sha",
        status: "completed",
        conclusion: "success",
        output: patched
          ? {
              title: "Review publication incomplete",
              summary: "This run is not a published review verdict.",
            }
          : {
              title: "Review complete",
              summary: "A review verdict exists.",
            },
      });
    }) as typeof fetch;

    await completeExpectedCheckRun(
      "token",
      "octo/repo",
      expected,
      "Review publication incomplete",
      "This run is not a published review verdict.",
    );

    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  test("cleanup verifies identity before and terminal state after its patch", async () => {
    const methods: string[] = [];
    let patched = false;
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "PATCH") {
        patched = true;
        return new Response(null, { status: 200 });
      }
      return Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:run:review",
        head_sha: "head-sha",
        status: patched ? "completed" : "in_progress",
        conclusion: patched ? "success" : null,
        output: patched
          ? {
              title: "Review complete",
              summary: "The review completed.",
            }
          : null,
      });
    }) as typeof fetch;

    await completeExpectedCheckRun(
      "token",
      "octo/repo",
      expected,
      "Review complete",
      "The review completed.",
    );

    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  test("cleanup rejects a patch whose terminal output remains stale", async () => {
    let patched = false;
    globalThis.fetch = (async (_input, init) => {
      if ((init?.method ?? "GET") === "PATCH") {
        patched = true;
        return new Response(null, { status: 200 });
      }
      return Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:run:review",
        head_sha: "head-sha",
        status: patched ? "completed" : "in_progress",
        conclusion: patched ? "success" : null,
        output: patched
          ? {
              title: "Review complete",
              summary: "Stale review verdict.",
            }
          : null,
      });
    }) as typeof fetch;

    await expect(
      completeExpectedCheckRun(
        "token",
        "octo/repo",
        expected,
        "Review publication incomplete",
        "This run is not a published review verdict.",
      ),
    ).rejects.toThrow("did not publish the expected output");
  });

  test("cleanup does not patch a mismatched check-run identity", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:another:review",
        head_sha: "head-sha",
        status: "in_progress",
        conclusion: null,
      });
    }) as typeof fetch;

    await expect(
      completeExpectedCheckRun(
        "token",
        "octo/repo",
        expected,
        "Review complete",
        "The review completed.",
      ),
    ).rejects.toThrow("does not match its review identity");
    expect(methods).toEqual(["GET"]);
  });
});
