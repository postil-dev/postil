import { afterEach, describe, expect, test } from "bun:test";

import {
  addCommentReaction,
  comparePullRequestSnapshotTimes,
  completeExpectedCheckRun,
  createCheckRun,
  findCheckRunByExternalId,
  findIssueCommentByMarker,
  findPullRequestReviewCommentByMarker,
  getPullRequestReviewComment,
  getPullRequestReviewContext,
  listPullRequestReviewCommentReactions,
  parsePullRequestUpdatedAt,
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
    user: { login: "postil-dev[bot]" },
  }));
}

describe("review request reactions", () => {
  test("uses the comment-kind endpoint and recognizes GitHub idempotency", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ id: 1 }), {
        status: requests.length === 1 ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(
      addCommentReaction("token", "octo/repo", 41, "issue_comment", "eyes"),
    ).resolves.toBe("created");
    await expect(
      addCommentReaction(
        "token",
        "octo/repo",
        42,
        "pull_request_review_comment",
        "eyes",
      ),
    ).resolves.toBe("already_exists");
    expect(requests).toEqual([
      {
        url: expect.stringContaining("/repos/octo/repo/issues/comments/41/reactions"),
        body: { content: "eyes" },
      },
      {
        url: expect.stringContaining("/repos/octo/repo/pulls/comments/42/reactions"),
        body: { content: "eyes" },
      },
    ]);
  });

  test("treats a deleted source comment as reconciled", async () => {
    globalThis.fetch = Object.assign(
      async () => new Response("missing", { status: 404 }),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    await expect(
      addCommentReaction("token", "octo/repo", 41, "issue_comment", "eyes"),
    ).resolves.toBe("missing");
  });
});

describe("pull-request review conversations", () => {
  test("loads bounded reaction pages with validated immutable identities", async () => {
    const requestedPages: Array<{ content: string | null; page: number }> = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      const content = url.searchParams.get("content");
      requestedPages.push({ content, page });
      const count = content === "+1" && page === 1 ? 100 : 1;
      return Response.json(Array.from({ length: count }, (_, index) => ({
        id: (content === "+1" ? 1_000 : 2_000) + page * 100 + index,
        content,
        created_at: "2026-08-24T12:34:56Z",
        user: {
          id: 500 + index,
          login: index === 0 && content === "-1" ? "dependabot[bot]" : `reviewer-${index}`,
          type: index === 0 && content === "-1" ? "Bot" : "User",
        },
      })));
    }) as typeof fetch;

    const reactions = await listPullRequestReviewCommentReactions(
      "token",
      "octo/repo",
      41,
    );
    expect(requestedPages).toEqual([
      { content: "+1", page: 1 },
      { content: "+1", page: 2 },
      { content: "-1", page: 1 },
    ]);
    expect(reactions).toHaveLength(102);
    expect(reactions[0]).toMatchObject({
      id: 1_100,
      content: "+1",
      user: { id: 500, login: "reviewer-0", type: "User" },
    });
    expect(reactions[0]!.createdAt).toEqual(new Date("2026-08-24T12:34:56Z"));
    expect(reactions.at(-1)).toMatchObject({
      content: "-1",
      user: { login: "dependabot[bot]", type: "Bot" },
    });
  });

  test("returns a bounded prefix when every reaction page is full", async () => {
    const requestedPages: Array<{ content: string | null; page: number }> = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const content = url.searchParams.get("content");
      const page = Number(url.searchParams.get("page"));
      requestedPages.push({ content, page });
      return Response.json(Array.from({ length: 100 }, (_, index) => ({
        id: (content === "+1" ? 1_000_000 : 2_000_000) + page * 100 + index,
        content,
        created_at: "2026-08-24T12:34:56Z",
        user: { id: 10_000 + page * 100 + index, login: `reviewer-${page}-${index}`, type: "User" },
      })));
    }) as typeof fetch;

    const reactions = await listPullRequestReviewCommentReactions(
      "token",
      "octo/repo",
      41,
    );

    expect(reactions).toHaveLength(1_000);
    expect(requestedPages).toHaveLength(10);
    expect(requestedPages.at(-1)).toEqual({ content: "-1", page: 5 });
  });

  test("rejects an unrelated reaction returned despite the server content filter", async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json([{
        id: 1,
        content: "unsupported",
        created_at: "2026-08-24T12:34:56Z",
        user: { id: 2, login: "reviewer", type: "User" },
      }]),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    await expect(
      listPullRequestReviewCommentReactions("token", "octo/repo", 41),
    ).rejects.toThrow("GitHub review comment reactions response is malformed");
  });

  test("loads a bounded root identity and posts a thread reply", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({
          id: 41,
          body: "Could this return earlier?",
          user: { login: "postil-dev[bot]" },
        });
      }
      return Response.json({ id: 42 });
    }) as typeof fetch;

    await expect(
      getPullRequestReviewComment("token", "octo/repo", 41),
    ).resolves.toMatchObject({ id: 41, userLogin: "postil-dev[bot]" });
    const { postPullRequestReviewCommentReply } = await import("@/lib/github/checks");
    await expect(
      postPullRequestReviewCommentReply("token", "octo/repo", 7, 41, "Because."),
    ).resolves.toBe(42);
    expect(requests[1]).toMatchObject({
      url: expect.stringContaining("/repos/octo/repo/pulls/7/comments/41/replies"),
      method: "POST",
      body: { body: "Because." },
    });
  });

  test("ignores a forged marker from a non-App author", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json([
          {
            id: 7,
            body: "<!-- postil-respond:marker -->",
            user: { login: "mallory" },
          },
        ]),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    await expect(
      findPullRequestReviewCommentByMarker(
        "token",
        "octo/repo",
        7,
        "<!-- postil-respond:marker -->",
        new Date("2026-07-13T00:00:00.000Z"),
      ),
    ).resolves.toBeNull();
  });
});

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
  test("classifies update timestamps without collapsing malformed input into missing", () => {
    expect(parsePullRequestUpdatedAt(undefined)).toEqual({ kind: "missing" });
    expect(parsePullRequestUpdatedAt(null)).toEqual({ kind: "malformed" });
    expect(parsePullRequestUpdatedAt("not-a-timestamp")).toEqual({
      kind: "malformed",
    });
    for (const looseDate of ["08/24/2026", "2026-08-24", "0"]) {
      expect(parsePullRequestUpdatedAt(looseDate)).toEqual({ kind: "malformed" });
    }
    expect(parsePullRequestUpdatedAt("2026-02-29T12:34:56Z")).toEqual({
      kind: "malformed",
    });
    expect(parsePullRequestUpdatedAt("2024-02-29T12:34:56Z")).toEqual({
      kind: "valid",
      seconds: 1_709_210_096,
    });
    expect(parsePullRequestUpdatedAt("2026-08-24T12:34:56.999Z")).toEqual(
      parsePullRequestUpdatedAt("2026-08-24T12:34:56Z"),
    );
  });

  test("orders valid timestamps by parsed seconds and fails closed otherwise", () => {
    expect(
      comparePullRequestSnapshotTimes(
        "2026-08-24T12:34:57Z",
        "2026-08-24T12:34:56Z",
      ),
    ).toBe("event_newer");
    expect(
      comparePullRequestSnapshotTimes(
        "2026-08-24T12:34:55Z",
        "2026-08-24T12:34:56Z",
      ),
    ).toBe("live_newer");
    expect(
      comparePullRequestSnapshotTimes(
        "2026-08-24T12:34:56.100Z",
        "2026-08-24T12:34:56.900Z",
      ),
    ).toBe("equal");
    expect(comparePullRequestSnapshotTimes(undefined, "2026-08-24T12:34:56Z")).toBe(
      "unknown",
    );
    expect(
      comparePullRequestSnapshotTimes("not-a-timestamp", "2026-08-24T12:34:56Z"),
    ).toBe("unknown");
    expect(
      comparePullRequestSnapshotTimes("08/24/2026", "2026-08-24T12:34:56Z"),
    ).toBe("unknown");
    expect(
      comparePullRequestSnapshotTimes("2026-08-24T12:34:56Z", "2026-08-24"),
    ).toBe("unknown");
  });

  test("loads immutable refs and optional author identity", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({
        state: "open",
        merged: false,
        draft: false,
        updated_at: "2026-08-24T12:34:56Z",
        head: { sha: "head-sha" },
        base: { sha: "base-sha" },
        user: { id: 42, login: "octocat" },
      })) as typeof fetch;

    await expect(
      getPullRequestReviewContext("token", "octo/repo", 7),
    ).resolves.toEqual({
      open: true,
      merged: false,
      headSha: "head-sha",
      baseSha: "base-sha",
      draft: false,
      updatedAt: "2026-08-24T12:34:56Z",
      authorGithubId: 42,
      authorLogin: "octocat",
    });
  });

  for (const updatedAt of [undefined, "not-a-timestamp"] as const) {
    test(`omits a ${updatedAt === undefined ? "missing" : "malformed"} update timestamp`, async () => {
      globalThis.fetch = (async (_input) =>
        Response.json({
          state: "open",
          merged: false,
          draft: false,
          head: { sha: "head-sha" },
          base: { sha: "base-sha" },
          ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
        })) as typeof fetch;

      await expect(
        getPullRequestReviewContext("token", "octo/repo", 7),
      ).resolves.toEqual({
        open: true,
        merged: false,
        headSha: "head-sha",
        baseSha: "base-sha",
        draft: false,
      });
    });
  }

  test("normalizes only a complete bounded author identity", async () => {
    globalThis.fetch = (async (_input) =>
      Response.json({
        state: "open",
        merged: false,
        draft: false,
        head: { sha: "head-sha" },
        base: { sha: "base-sha" },
        user: { id: 0, login: "   " },
      })) as typeof fetch;

    await expect(
      getPullRequestReviewContext("token", "octo/repo", 7),
    ).resolves.toEqual({
      open: true,
      merged: false,
      headSha: "head-sha",
      baseSha: "base-sha",
      draft: false,
    });

    globalThis.fetch = (async (_input) =>
      Response.json({
        state: "open",
        merged: false,
        draft: false,
        head: { sha: "head-sha" },
        base: { sha: "base-sha" },
        user: { id: 42, login: ` ${"a".repeat(101)} ` },
      })) as typeof fetch;

    await expect(
      getPullRequestReviewContext("token", "octo/repo", 7),
    ).resolves.toEqual({
      open: true,
      merged: false,
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
  test("publishes the exact review URL with the initial gate", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ id: 42 });
    }) as typeof fetch;

    await createCheckRun("token", "octo/repo", "postil/gate", "head-sha", {
      externalId: "postil:run:gate",
      detailsUrl: "https://postil.dev/orgs/octo/runs/run",
    });

    expect(body).toMatchObject({
      name: "postil/gate",
      head_sha: "head-sha",
      external_id: "postil:run:gate",
      details_url: "https://postil.dev/orgs/octo/runs/run",
    });
  });

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

  test("cleanup replaces a generic details URL even when the verdict is terminal", async () => {
    const methods: string[] = [];
    const patchBodies: Array<Record<string, unknown>> = [];
    let detailsUrl = "https://postil.dev";
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        patchBodies.push(body);
        detailsUrl = String(body.details_url);
        return new Response(null, { status: 200 });
      }
      return Response.json({
        id: 42,
        name: "postil/review",
        external_id: "postil:run:review",
        head_sha: "head-sha",
        status: "completed",
        conclusion: "success",
        details_url: detailsUrl,
        output: {
          title: "Review complete",
          summary: "The review completed.",
        },
      });
    }) as typeof fetch;

    await completeExpectedCheckRun(
      "token",
      "octo/repo",
      {
        ...expected,
        detailsUrl: "https://postil.dev/orgs/octo/runs/run",
      },
      "Review complete",
      "The review completed.",
    );

    expect(methods).toEqual(["GET", "PATCH", "GET"]);
    expect(patchBodies[0]?.details_url).toBe(
      "https://postil.dev/orgs/octo/runs/run",
    );
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
