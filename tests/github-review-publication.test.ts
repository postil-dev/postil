import { afterEach, describe, expect, test } from "bun:test";

import {
  findGitHubReviewByMarker,
  GitHubPublicationAmbiguousError,
  GitHubPublicationRejectedError,
  GitHubReviewPlacementRejectedError,
  publishGitHubCompositeReview,
  publishGitHubFileComment,
  updateGitHubReviewComment,
  updateGitHubReviewSummary,
} from "@/lib/github/review-publication";

const ORIGINAL_FETCH = globalThis.fetch;
const HEAD_SHA = "a".repeat(40);
const REVIEW_MARKER = `<!-- postil-review:v2:${"b".repeat(32)} -->`;
const FINDING_MARKER = `<!-- postil-finding:v2:${"c".repeat(32)} -->`;
const SECOND_FINDING_MARKER = `<!-- postil-finding:v2:${"d".repeat(32)} -->`;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    body: `Review summary\n\n${REVIEW_MARKER}`,
    commit_id: HEAD_SHA,
    state: "COMMENTED",
    submitted_at: "2026-08-14T12:00:00Z",
    user: { login: "postil-dev[bot]" },
    ...overrides,
  };
}

function reviewComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 51,
    body: `Finding body\n\n${FINDING_MARKER}`,
    commit_id: HEAD_SHA,
    original_commit_id: HEAD_SHA,
    path: "src/main.ts",
    pull_request_review_id: 41,
    subject_type: "line",
    user: { login: "postil-dev[bot]" },
    ...overrides,
  };
}

const compositeIntent = {
  commitId: HEAD_SHA,
  body: `Review summary\n\n${REVIEW_MARKER}`,
  marker: REVIEW_MARKER,
  comments: [
    {
      path: "src/main.ts",
      line: 12,
      side: "RIGHT" as const,
      startLine: 11,
      startSide: "RIGHT" as const,
      body: `Finding body\n\n${FINDING_MARKER}`,
      marker: FINDING_MARKER,
    },
  ],
};

describe("GitHub composite review publication", () => {
  test("publishes and observes the exact review and inline identities", async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (init?.method === "POST") return Response.json(review());
      return Response.json([reviewComment()]);
    }) as typeof fetch;

    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, compositeIntent),
    ).resolves.toEqual({
      reviewId: "41",
      commitId: HEAD_SHA,
      body: compositeIntent.body,
      commentIdsByMarker: { [FINDING_MARKER]: "51" },
      missingCommentMarkers: [],
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: expect.stringContaining("/repos/octo/repo/pulls/7/reviews"),
      body: {
        commit_id: HEAD_SHA,
        event: "COMMENT",
        body: compositeIntent.body,
        comments: [
          {
            path: "src/main.ts",
            line: 12,
            side: "RIGHT",
            start_line: 11,
            start_side: "RIGHT",
            body: compositeIntent.comments[0]!.body,
          },
        ],
      },
    });
    expect(requests[1]?.url).toContain("/reviews/41/comments?");
  });

  test("classifies only line-placement validation as a fallback signal", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json(
          {
            message: "Validation Failed",
            errors: [{ field: "start_line", code: "invalid" }],
          },
          { status: 422 },
        ),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, compositeIntent),
    ).rejects.toBeInstanceOf(GitHubReviewPlacementRejectedError);

    globalThis.fetch = Object.assign(
      async () =>
        Response.json(
          {
            message: "Validation Failed",
            errors: [{ field: "body", code: "invalid" }],
          },
          { status: 422 },
        ),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, compositeIntent),
    ).rejects.toBeInstanceOf(GitHubPublicationRejectedError);
  });

  test("reconciles a transport failure by exact review and finding markers", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST") throw new TypeError("connection reset");
      if (methods.length === 2) return Response.json([review()]);
      return Response.json([reviewComment()]);
    }) as typeof fetch;

    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, compositeIntent),
    ).resolves.toMatchObject({
      reviewId: "41",
      commentIdsByMarker: { [FINDING_MARKER]: "51" },
    });
    expect(methods).toEqual(["POST", "GET", "GET"]);
  });

  test("reconciles malformed success and oversized server-failure responses", async () => {
    for (const postResponse of [
      Response.json({ id: "not-a-review" }),
      new Response("x".repeat(1_048_577), { status: 500 }),
    ]) {
      let request = 0;
      globalThis.fetch = (async (_input, init) => {
        request += 1;
        if (init?.method === "POST") return postResponse;
        if (request === 2) return Response.json([review()]);
        return Response.json([reviewComment()]);
      }) as typeof fetch;

      await expect(
        publishGitHubCompositeReview("token", "octo/repo", 7, compositeIntent),
      ).resolves.toMatchObject({ reviewId: "41" });
      expect(request).toBe(3);
    }
  });

  test("fails closed for duplicate or non-App marker ownership", async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json([review(), review({ id: 42 })]),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    await expect(
      findGitHubReviewByMarker(
        "token",
        "octo/repo",
        7,
        REVIEW_MARKER,
        HEAD_SHA,
      ),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);

    globalThis.fetch = Object.assign(
      async () => Response.json([review({ user: { login: "octocat" } })]),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    await expect(
      findGitHubReviewByMarker(
        "token",
        "octo/repo",
        7,
        REVIEW_MARKER,
        HEAD_SHA,
      ),
    ).resolves.toBeNull();
  });

  test("never accepts a pending review as a submitted publication", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json([review({ state: "PENDING", submitted_at: null })]),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    await expect(
      findGitHubReviewByMarker(
        "token",
        "octo/repo",
        7,
        REVIEW_MARKER,
        HEAD_SHA,
      ),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
  });

  test("reports mixed partial inline creation without retrying the review", async () => {
    const methods: string[] = [];
    const partialIntent = {
      ...compositeIntent,
      comments: [
        compositeIntent.comments[0]!,
        {
          ...compositeIntent.comments[0]!,
          line: 13,
          startLine: undefined,
          startSide: undefined,
          body: `Second finding\n\n${SECOND_FINDING_MARKER}`,
          marker: SECOND_FINDING_MARKER,
        },
      ],
    };
    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST") return Response.json(review());
      return Response.json([reviewComment()]);
    }) as typeof fetch;

    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, partialIntent),
    ).resolves.toMatchObject({
      reviewId: "41",
      commentIdsByMarker: { [FINDING_MARKER]: "51" },
      missingCommentMarkers: [SECOND_FINDING_MARKER],
    });
    expect(methods).toEqual(["POST", "GET"]);
  });

  test("rejects a successful reconciliation page above the response bound", async () => {
    globalThis.fetch = Object.assign(
      async () => new Response("x".repeat(16_777_217), { status: 200 }),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    await expect(
      findGitHubReviewByMarker(
        "token",
        "octo/repo",
        7,
        REVIEW_MARKER,
        HEAD_SHA,
      ),
    ).rejects.toThrow("malformed");
  });

  test("keeps post-write comment observation failures ambiguous", async () => {
    const methods: string[] = [];
    let request = 0;
    globalThis.fetch = (async (_input, init) => {
      request += 1;
      methods.push(init?.method ?? "GET");
      if (request === 1) return Response.json(review());
      if (request === 2 || request === 4) {
        return Response.json({ message: "unavailable" }, { status: 503 });
      }
      return Response.json([review()]);
    }) as typeof fetch;

    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, compositeIntent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
    expect(methods.filter((method) => method === "POST")).toHaveLength(1);
  });

  test("rejects one remote comment identity assigned to multiple markers", async () => {
    const intent = {
      ...compositeIntent,
      comments: [
        compositeIntent.comments[0]!,
        {
          ...compositeIntent.comments[0]!,
          line: 13,
          startLine: undefined,
          startSide: undefined,
          body: `Second finding\n\n${SECOND_FINDING_MARKER}`,
          marker: SECOND_FINDING_MARKER,
        },
      ],
    };
    const sharedComment = reviewComment({
      body: `Two markers\n\n${FINDING_MARKER}\n${SECOND_FINDING_MARKER}`,
    });
    let request = 0;
    globalThis.fetch = (async (_input, init) => {
      request += 1;
      if (request === 1) return Response.json(review());
      if (request === 2 || request === 4) return Response.json([sharedComment]);
      return Response.json([review()]);
    }) as typeof fetch;

    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, intent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
  });

  test("does not start a write when its signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json(review());
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    await expect(
      publishGitHubCompositeReview(
        "token",
        "octo/repo",
        7,
        compositeIntent,
        controller.signal,
      ),
    ).rejects.toBe(controller.signal.reason);
    expect(requests).toBe(0);
  });

  test("rejects duplicate finding markers before starting the review write", async () => {
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json(review());
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const duplicateIntent = {
      ...compositeIntent,
      comments: [
        compositeIntent.comments[0]!,
        {
          ...compositeIntent.comments[0]!,
          line: 13,
          startLine: undefined,
          startSide: undefined,
        },
      ],
    };

    await expect(
      publishGitHubCompositeReview(
        "token",
        "octo/repo",
        7,
        duplicateIntent,
      ),
    ).rejects.toThrow("invalid");
    expect(requests).toBe(0);
  });
});

describe("GitHub review finalization", () => {
  test("reads before writing and verifies the exact final summary", async () => {
    const methods: string[] = [];
    let body = compositeIntent.body;
    const finalBody = `Final summary\n\n${REVIEW_MARKER}`;
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "PUT") {
        body = String(
          (JSON.parse(String(init?.body)) as { body?: unknown }).body,
        );
      }
      return Response.json(review({ body }));
    }) as typeof fetch;

    await expect(
      updateGitHubReviewSummary(
        "token",
        "octo/repo",
        7,
        "41",
        HEAD_SHA,
        REVIEW_MARKER,
        finalBody,
      ),
    ).resolves.toMatchObject({ body: finalBody });
    expect(methods).toEqual(["GET", "PUT", "GET"]);
  });

  test("never updates a review with mismatched commit or marker ownership", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json(review({ commit_id: "d".repeat(40) }));
    }) as typeof fetch;

    await expect(
      updateGitHubReviewSummary(
        "token",
        "octo/repo",
        7,
        "41",
        HEAD_SHA,
        REVIEW_MARKER,
        `Final summary\n\n${REVIEW_MARKER}`,
      ),
    ).rejects.toThrow("malformed");
    expect(methods).toEqual(["GET"]);
  });

  test("reports an ambiguous update when post-write verification is unavailable", async () => {
    let request = 0;
    globalThis.fetch = (async (_input, init) => {
      request += 1;
      if (request === 1) return Response.json(review());
      if (init?.method === "PUT") return Response.json(review());
      throw new TypeError("verification connection reset");
    }) as typeof fetch;

    await expect(
      updateGitHubReviewSummary(
        "token",
        "octo/repo",
        7,
        "41",
        HEAD_SHA,
        REVIEW_MARKER,
        `Final summary\n\n${REVIEW_MARKER}`,
      ),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
  });
});

describe("GitHub file-level review comments", () => {
  const intent = {
    commitId: HEAD_SHA,
    path: "src/main.ts",
    body: `Finding body\n\n${FINDING_MARKER}`,
    marker: FINDING_MARKER,
  };

  test("publishes a file-level comment with no line coordinates", async () => {
    let posted: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      posted = JSON.parse(String(init?.body));
      return Response.json(reviewComment({ subject_type: "file" }), {
        status: 201,
      });
    }) as typeof fetch;

    await expect(
      publishGitHubFileComment("token", "octo/repo", 7, intent),
    ).resolves.toMatchObject({ commentId: "51", path: "src/main.ts" });
    expect(posted).toEqual({
      body: intent.body,
      commit_id: HEAD_SHA,
      path: "src/main.ts",
      subject_type: "file",
    });
  });

  test("reconciles an uncertain write and rejects forged marker ownership", async () => {
    let request = 0;
    globalThis.fetch = (async (_input, init) => {
      request += 1;
      if (init?.method === "POST") throw new TypeError("connection reset");
      return Response.json([reviewComment({ subject_type: "file" })]);
    }) as typeof fetch;
    await expect(
      publishGitHubFileComment("token", "octo/repo", 7, intent),
    ).resolves.toMatchObject({ commentId: "51" });
    expect(request).toBe(2);

    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "POST") throw new TypeError("connection reset");
      return Response.json([
        reviewComment({
          subject_type: "file",
          user: { login: "octocat" },
        }),
      ]);
    }) as typeof fetch;
    await expect(
      publishGitHubFileComment("token", "octo/repo", 7, intent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
  });

  test("reconciles a malformed successful create response", async () => {
    let request = 0;
    globalThis.fetch = (async (_input, init) => {
      request += 1;
      if (init?.method === "POST")
        return Response.json({ id: "invalid" }, { status: 201 });
      return Response.json([reviewComment({ subject_type: "file" })]);
    }) as typeof fetch;

    await expect(
      publishGitHubFileComment("token", "octo/repo", 7, intent),
    ).resolves.toMatchObject({ commentId: "51" });
    expect(request).toBe(2);
  });

  test("requires a file target and fences on the original commit", async () => {
    let request = 0;
    globalThis.fetch = (async (_input, init) => {
      request += 1;
      if (request === 1) {
        return Response.json(reviewComment({ subject_type: "line" }), {
          status: 201,
        });
      }
      return Response.json([reviewComment({ subject_type: "line" })]);
    }) as typeof fetch;
    await expect(
      publishGitHubFileComment("token", "octo/repo", 7, intent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);

    globalThis.fetch = Object.assign(
      async () =>
        Response.json(
          reviewComment({
            commit_id: "e".repeat(40),
            original_commit_id: HEAD_SHA,
            subject_type: "file",
          }),
          { status: 201 },
        ),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    await expect(
      publishGitHubFileComment("token", "octo/repo", 7, intent),
    ).resolves.toMatchObject({ commentId: "51", commitId: HEAD_SHA });
  });

  test("does not certify one match when a later reconciliation page fails", async () => {
    let request = 0;
    globalThis.fetch = (async (_input, init) => {
      request += 1;
      if (init?.method === "POST") throw new TypeError("connection reset");
      if (request === 2) {
        return Response.json([reviewComment({ subject_type: "file" })], {
          headers: {
            Link: '<https://api.github.test/comments?page=2>; rel="next"',
          },
        });
      }
      return Response.json({ message: "unavailable" }, { status: 503 });
    }) as typeof fetch;

    await expect(
      publishGitHubFileComment("token", "octo/repo", 7, intent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
  });
});

describe("GitHub owned review comment updates", () => {
  const LEGACY_MARKER = `<!-- postil-finding:v1:${"d".repeat(12)} -->`;
  const intent = {
    commentId: "51",
    commitId: HEAD_SHA,
    path: "src/main.ts",
    expectedMarkers: [FINDING_MARKER, LEGACY_MARKER],
    body: `Corrected finding body\n\n${FINDING_MARKER}`,
  };

  test("observes ownership, patches the body, and verifies the response", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      return Response.json(
        reviewComment({
          body:
            method === "PATCH"
              ? intent.body
              : `Stale finding body\n\n${LEGACY_MARKER}`,
        }),
      );
    }) as typeof fetch;

    await expect(
      updateGitHubReviewComment("token", "octo/repo", intent),
    ).resolves.toMatchObject({ commentId: "51", body: intent.body });
    expect(methods).toEqual(["GET", "PATCH"]);
  });

  test("reconciles a transport failure only when the desired body is observed", async () => {
    let request = 0;
    globalThis.fetch = (async (_input, init) => {
      request += 1;
      if (request === 1) {
        return Response.json(
          reviewComment({ body: `Stale finding body\n\n${LEGACY_MARKER}` }),
        );
      }
      if (init?.method === "PATCH") throw new TypeError("connection reset");
      return Response.json(reviewComment({ body: intent.body }));
    }) as typeof fetch;

    await expect(
      updateGitHubReviewComment("token", "octo/repo", intent),
    ).resolves.toMatchObject({ body: intent.body });
    expect(request).toBe(3);
  });

  test("does not patch an unowned or mismatched comment identity", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json(reviewComment({ user: { login: "octocat" } }));
    }) as typeof fetch;

    await expect(
      updateGitHubReviewComment("token", "octo/repo", intent),
    ).rejects.toThrow("malformed");
    expect(methods).toEqual(["GET"]);
  });
});
