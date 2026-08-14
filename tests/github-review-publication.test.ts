import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  completeGitHubCheckRun,
  createGitHubCheckRun,
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
const CHECK_EXTERNAL_ID = "postil:review-run:review";
const CHECK_DETAILS_URL = "https://postil.dev/orgs/octo/runs/review-run";
const TEST_GITHUB_APP_ID = 123;
const TEST_GITHUB_APP_SLUG = "postil-dev";
const ORIGINAL_GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const ORIGINAL_GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG;

beforeEach(() => {
  process.env.GITHUB_APP_ID = String(TEST_GITHUB_APP_ID);
  process.env.GITHUB_APP_SLUG = TEST_GITHUB_APP_SLUG;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.GITHUB_APP_ID = String(TEST_GITHUB_APP_ID);
  process.env.GITHUB_APP_SLUG = TEST_GITHUB_APP_SLUG;
});

afterAll(() => {
  if (ORIGINAL_GITHUB_APP_ID === undefined) delete process.env.GITHUB_APP_ID;
  else process.env.GITHUB_APP_ID = ORIGINAL_GITHUB_APP_ID;
  if (ORIGINAL_GITHUB_APP_SLUG === undefined) delete process.env.GITHUB_APP_SLUG;
  else process.env.GITHUB_APP_SLUG = ORIGINAL_GITHUB_APP_SLUG;
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

const checkRunStartIntent = {
  appId: TEST_GITHUB_APP_ID,
  appSlug: TEST_GITHUB_APP_SLUG,
  name: "postil/review" as const,
  headSha: HEAD_SHA,
  externalId: CHECK_EXTERNAL_ID,
  detailsUrl: CHECK_DETAILS_URL,
};

const checkRunCompletionIntent = {
  ...checkRunStartIntent,
  checkRunId: "61",
  conclusion: "success" as const,
  title: "Review complete",
  summary: "The review completed.",
  annotations: [
    {
      path: "src/main.ts",
      startLine: 12,
      endLine: 12,
      startColumn: 3,
      endColumn: 9,
      annotationLevel: "warning" as const,
      message: "Review finding",
      title: "Finding",
      rawDetails: "Use the safe branch.",
    },
  ],
};

function checkRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 61,
    name: checkRunStartIntent.name,
    external_id: checkRunStartIntent.externalId,
    head_sha: HEAD_SHA,
    status: "in_progress",
    conclusion: null,
    details_url: CHECK_DETAILS_URL,
    app: { id: TEST_GITHUB_APP_ID, slug: TEST_GITHUB_APP_SLUG },
    output: null,
    ...overrides,
  };
}

function checkRunAnnotation(overrides: Record<string, unknown> = {}) {
  return {
    path: "src/main.ts",
    start_line: 12,
    end_line: 12,
    start_column: 3,
    end_column: 9,
    annotation_level: "warning",
    message: "Review finding",
    title: "Finding",
    raw_details: "Use the safe branch.",
    ...overrides,
  };
}

function isCheckRunAnnotationsRequest(input: RequestInfo | URL): boolean {
  return new URL(String(input)).pathname.endsWith("/annotations");
}

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

describe("GitHub owned check-run creation", () => {
  test("creates one exact in-progress check run with an encoded repository path", async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Response.json(checkRun());
    }) as typeof fetch;

    await expect(
      createGitHubCheckRun("token", "octo space/repo space", checkRunStartIntent),
    ).resolves.toBe("61");
    expect(requests).toEqual([
      {
        method: "POST",
        url: expect.stringContaining("/repos/octo%20space/repo%20space/check-runs"),
        body: {
          name: "postil/review",
          head_sha: HEAD_SHA,
          status: "in_progress",
          external_id: CHECK_EXTERNAL_ID,
          details_url: CHECK_DETAILS_URL,
        },
      },
    ]);
  });

  test("reconciles one uncertain create across every linked page", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") throw new TypeError("connection reset");
      if (methods.length === 2) {
        return Response.json({
          check_runs: [checkRun({ app: { slug: "other-app" } })],
        }, {
          headers: {
            Link: '<https://api.github.test/check-runs?page=2>; rel="next"',
          },
        });
      }
      return Response.json({ check_runs: [checkRun()] });
    }) as typeof fetch;

    await expect(
      createGitHubCheckRun("token", "octo/repo", checkRunStartIntent),
    ).resolves.toBe("61");
    expect(methods).toEqual(["POST", "GET", "GET"]);
    expect(methods.filter((method) => method === "POST")).toHaveLength(1);
  });

  test("fails closed for duplicate or wrong check-run identities", async () => {
    const invalidCandidates = [
      [checkRun(), checkRun({ id: 62 })],
      [checkRun({ app: { slug: "other-app" } })],
      [
        checkRun({
          app: { id: TEST_GITHUB_APP_ID + 1, slug: "postil-dev" },
        }),
      ],
      [checkRun({ head_sha: "b".repeat(40) })],
      [checkRun({ name: "postil/gate" })],
      [checkRun({ id: 0 })],
    ];
    for (const candidates of invalidCandidates) {
      const methods: string[] = [];
      globalThis.fetch = (async (_input, init) => {
        methods.push(init?.method ?? "GET");
        if (init?.method === "POST") return Response.json({ id: "malformed" });
        return Response.json({ check_runs: candidates });
      }) as typeof fetch;

      await expect(
        createGitHubCheckRun("token", "octo/repo", checkRunStartIntent),
      ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
      expect(methods.filter((method) => method === "POST")).toHaveLength(1);
    }
  });

  test("treats malformed and oversized successes as uncertain without reading error payloads", async () => {
    for (const postResponse of [
      Response.json({ id: "malformed" }),
      new Response("{}", {
        status: 201,
        headers: { "content-length": String(16_777_217) },
      }),
      new Response(null, { status: 503 }),
    ]) {
      const methods: string[] = [];
      globalThis.fetch = (async (_input, init) => {
        methods.push(init?.method ?? "GET");
        return init?.method === "POST"
          ? postResponse
          : Response.json({ check_runs: [checkRun()] });
      }) as typeof fetch;

      await expect(
        createGitHubCheckRun("token", "octo/repo", checkRunStartIntent),
      ).resolves.toBe("61");
      expect(methods.filter((method) => method === "POST")).toHaveLength(1);
    }

    globalThis.fetch = Object.assign(
      async () => new Response("remote failure details", { status: 422 }),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const rejection = createGitHubCheckRun(
      "token",
      "octo/repo",
      checkRunStartIntent,
    );
    await expect(rejection).rejects.toBeInstanceOf(GitHubPublicationRejectedError);
    await rejection.catch((error: Error) => {
      expect(error.message).not.toContain("remote failure details");
    });
  });

  test("fails closed when a reconciliation page fails or exceeds its page limit", async () => {
    let request = 0;
    globalThis.fetch = (async (_input, init) => {
      request += 1;
      if (init?.method === "POST") return new Response(null, { status: 503 });
      if (request === 2) {
        return Response.json({ check_runs: [checkRun()] }, {
          headers: {
            Link: '<https://api.github.test/check-runs?page=2>; rel="next"',
          },
        });
      }
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    await expect(
      createGitHubCheckRun("token", "octo/repo", checkRunStartIntent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);

    let pages = 0;
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "POST") return new Response(null, { status: 503 });
      pages += 1;
      return Response.json({ check_runs: [] }, {
        headers: {
          Link: '<https://api.github.test/check-runs?page=next>; rel="next"',
        },
      });
    }) as typeof fetch;
    await expect(
      createGitHubCheckRun("token", "octo/repo", checkRunStartIntent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
    expect(pages).toBe(80);
  });

  test("validates and aborts before a create write", async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("unexpected request");
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    await expect(
      createGitHubCheckRun("token", "octo/repo", checkRunStartIntent, controller.signal),
    ).rejects.toBeDefined();
    await expect(
      createGitHubCheckRun("token", "octo/repo", {
        ...checkRunStartIntent,
        name: "postil/other" as "postil/review",
      }),
    ).rejects.toThrow("intent is invalid");
  });

  test("rejects malformed or mismatched App configuration before POST", async () => {
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json(checkRun());
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    for (const configuration of [
      { id: "0123", slug: TEST_GITHUB_APP_SLUG },
      { id: "+123", slug: TEST_GITHUB_APP_SLUG },
      { id: "9007199254740992", slug: TEST_GITHUB_APP_SLUG },
      { id: String(TEST_GITHUB_APP_ID), slug: "Postil-Dev" },
      { id: String(TEST_GITHUB_APP_ID), slug: "-postil-dev" },
      { id: String(TEST_GITHUB_APP_ID + 1), slug: TEST_GITHUB_APP_SLUG },
      { id: String(TEST_GITHUB_APP_ID), slug: "other-app" },
    ]) {
      process.env.GITHUB_APP_ID = configuration.id;
      process.env.GITHUB_APP_SLUG = configuration.slug;
      await expect(
        createGitHubCheckRun("token", "octo/repo", checkRunStartIntent),
      ).rejects.toThrow("GitHub App configuration is invalid");
    }
    process.env.GITHUB_APP_ID = String(TEST_GITHUB_APP_ID);
    delete process.env.GITHUB_APP_SLUG;
    await expect(
      createGitHubCheckRun("token", "octo/repo", checkRunStartIntent),
    ).rejects.toThrow("GitHub App configuration is invalid");
    expect(requests).toBe(0);
  });
});

describe("GitHub owned check-run completion", () => {
  test("observes identity, patches once, and verifies exact terminal output", async () => {
    const requests: Array<{ method: string; body?: unknown }> = [];
    let checkRunGets = 0;
    globalThis.fetch = (async (input, init) => {
      const method = init?.method ?? "GET";
      requests.push({
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (isCheckRunAnnotationsRequest(input)) {
        return Response.json(checkRunGets === 1 ? [] : [checkRunAnnotation()]);
      }
      if (method === "GET" && checkRunGets++ === 0) return Response.json(checkRun());
      return Response.json(
        checkRun({
          status: "completed",
          conclusion: "success",
          output: {
            title: checkRunCompletionIntent.title,
            summary: checkRunCompletionIntent.summary,
          },
        }),
      );
    }) as typeof fetch;

    await expect(
      completeGitHubCheckRun("token", "octo/repo", checkRunCompletionIntent),
    ).resolves.toBeUndefined();
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "PATCH",
      "GET",
      "GET",
    ]);
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(requests[2]?.body).toEqual({
      status: "completed",
      conclusion: "success",
      details_url: CHECK_DETAILS_URL,
      output: {
        title: "Review complete",
        summary: "The review completed.",
        annotations: [
          {
            path: "src/main.ts",
            start_line: 12,
            end_line: 12,
            start_column: 3,
            end_column: 9,
            annotation_level: "warning",
            message: "Review finding",
            title: "Finding",
            raw_details: "Use the safe branch.",
          },
        ],
      },
    });
  });

  test("does not patch an already exact terminal check run", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (input, init) => {
      methods.push(init?.method ?? "GET");
      if (isCheckRunAnnotationsRequest(input)) {
        return Response.json([checkRunAnnotation()]);
      }
      return Response.json(
        checkRun({
          status: "completed",
          conclusion: "success",
          output: {
            title: checkRunCompletionIntent.title,
            summary: checkRunCompletionIntent.summary,
          },
        }),
      );
    }) as typeof fetch;

    await expect(
      completeGitHubCheckRun("token", "octo/repo", checkRunCompletionIntent),
    ).resolves.toBeUndefined();
    expect(methods).toEqual(["GET", "GET"]);
  });

  test("never patches an already terminal check with stale content", async () => {
    for (const staleTerminalState of [
      { conclusion: "failure" },
      {
        output: {
          title: "Stale review title",
          summary: checkRunCompletionIntent.summary,
        },
      },
      { details_url: "https://postil.dev/orgs/octo/runs/other-run" },
    ]) {
      const methods: string[] = [];
      globalThis.fetch = (async (input, init) => {
        methods.push(init?.method ?? "GET");
        if (isCheckRunAnnotationsRequest(input)) {
          return Response.json([checkRunAnnotation()]);
        }
        return Response.json(
          checkRun({
            status: "completed",
            conclusion: "success",
            output: {
              title: checkRunCompletionIntent.title,
              summary: checkRunCompletionIntent.summary,
            },
            ...staleTerminalState,
          }),
        );
      }) as typeof fetch;

      await expect(
        completeGitHubCheckRun("token", "octo/repo", checkRunCompletionIntent),
      ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
      expect(methods).toEqual(["GET", "GET"]);
    }
  });

  test("does not patch a nonterminal details URL that the intent cannot clear", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (input, init) => {
      methods.push(init?.method ?? "GET");
      if (isCheckRunAnnotationsRequest(input)) {
        return Response.json([checkRunAnnotation()]);
      }
      return Response.json(checkRun());
    }) as typeof fetch;

    await expect(
      completeGitHubCheckRun("token", "octo/repo", {
        ...checkRunCompletionIntent,
        detailsUrl: undefined,
      }),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
    expect(methods).toEqual(["GET", "GET"]);
  });

  test("rejects stale, partial, extra, reordered, or changed terminal annotations without patching", async () => {
    const secondAnnotation = {
      ...checkRunCompletionIntent.annotations[0]!,
      path: "src/other.ts",
      startLine: 4,
      endLine: 4,
      startColumn: undefined,
      endColumn: undefined,
      message: "Second review finding",
      title: undefined,
      rawDetails: undefined,
    };
    const intent = {
      ...checkRunCompletionIntent,
      annotations: [checkRunCompletionIntent.annotations[0]!, secondAnnotation],
    };
    const desired = [
      checkRunAnnotation(),
      checkRunAnnotation({
        path: "src/other.ts",
        start_line: 4,
        end_line: 4,
        start_column: null,
        end_column: null,
        message: "Second review finding",
        title: null,
        raw_details: null,
      }),
    ];
    for (const annotations of [
      [],
      [desired[0]!],
      [...desired, checkRunAnnotation({ path: "src/extra.ts" })],
      [desired[1]!, desired[0]!],
      [checkRunAnnotation({ message: "Changed finding" }), desired[1]!],
    ]) {
      const methods: string[] = [];
      globalThis.fetch = (async (input, init) => {
        methods.push(init?.method ?? "GET");
        if (isCheckRunAnnotationsRequest(input)) return Response.json(annotations);
        return Response.json(
          checkRun({
            status: "completed",
            conclusion: "success",
            output: {
              title: intent.title,
              summary: intent.summary,
            },
          }),
        );
      }) as typeof fetch;
      await expect(
        completeGitHubCheckRun("token", "octo/repo", intent),
      ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
      expect(methods).toEqual(["GET", "GET"]);
    }
  });

  test("fails closed on annotation pagination failure or limit before patching", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (input, init) => {
      methods.push(init?.method ?? "GET");
      if (!isCheckRunAnnotationsRequest(input)) return Response.json(checkRun());
      if (methods.length === 2) {
        return Response.json([], {
          headers: {
            Link: '<https://api.github.test/check-runs/61/annotations?page=2>; rel="next"',
          },
        });
      }
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    await expect(
      completeGitHubCheckRun("token", "octo/repo", checkRunCompletionIntent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
    expect(methods).toEqual(["GET", "GET", "GET"]);
    expect(methods.filter((method) => method === "PATCH")).toHaveLength(0);

    let pages = 0;
    globalThis.fetch = (async (input, init) => {
      if (!isCheckRunAnnotationsRequest(input)) return Response.json(checkRun());
      pages += 1;
      return Response.json([], {
        headers: {
          Link: '<https://api.github.test/check-runs/61/annotations?page=next>; rel="next"',
        },
      });
    }) as typeof fetch;
    await expect(
      completeGitHubCheckRun("token", "octo/repo", checkRunCompletionIntent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
    expect(pages).toBe(80);
  });

  test("reconciles uncertain updates only when the exact terminal state appears", async () => {
    const methods: string[] = [];
    let checkRunGets = 0;
    globalThis.fetch = (async (input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (isCheckRunAnnotationsRequest(input)) {
        return Response.json(checkRunGets === 1 ? [] : [checkRunAnnotation()]);
      }
      if (checkRunGets++ === 0) return Response.json(checkRun());
      if (method === "PATCH") throw new TypeError("connection reset");
      return Response.json(
        checkRun({
          status: "completed",
          conclusion: "success",
          output: {
            title: checkRunCompletionIntent.title,
            summary: checkRunCompletionIntent.summary,
          },
        }),
      );
    }) as typeof fetch;
    await expect(
      completeGitHubCheckRun("token", "octo/repo", checkRunCompletionIntent),
    ).resolves.toBeUndefined();
    expect(methods).toEqual(["GET", "GET", "PATCH", "GET", "GET"]);
    expect(methods.filter((method) => method === "PATCH")).toHaveLength(1);

    for (const patchResponse of [
      Response.json({ id: "malformed" }),
      new Response(null, { status: 503 }),
      new Response("{}", {
        headers: { "content-length": String(16_777_217) },
      }),
    ]) {
      let request = 0;
      let checkRuns = 0;
      globalThis.fetch = (async (input, init) => {
        request += 1;
        if (isCheckRunAnnotationsRequest(input)) {
          return Response.json(checkRuns === 1 ? [] : [checkRunAnnotation()]);
        }
        if (checkRuns++ === 0) return Response.json(checkRun());
        if (init?.method === "PATCH") return patchResponse;
        return Response.json(
          checkRun({
            status: "completed",
            conclusion: "success",
            output: {
              title: checkRunCompletionIntent.title,
              summary: checkRunCompletionIntent.summary,
            },
          }),
        );
      }) as typeof fetch;
      await expect(
        completeGitHubCheckRun("token", "octo/repo", checkRunCompletionIntent),
      ).resolves.toBeUndefined();
      expect(request).toBe(5);
    }
  });

  test("rejects a known patch failure and refuses mismatched identities", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (input, init) => {
      methods.push(init?.method ?? "GET");
      if (isCheckRunAnnotationsRequest(input)) return Response.json([]);
      if (init?.method === "GET") return Response.json(checkRun());
      return new Response("remote failure details", { status: 422 });
    }) as typeof fetch;
    await expect(
      completeGitHubCheckRun("token", "octo/repo", checkRunCompletionIntent),
    ).rejects.toBeInstanceOf(GitHubPublicationRejectedError);
    expect(methods).toEqual(["GET", "GET", "PATCH"]);

    for (const mismatch of [
      { id: 62 },
      { app: { slug: "other-app" } },
      { app: { id: TEST_GITHUB_APP_ID + 1, slug: "postil-dev" } },
      { head_sha: "b".repeat(40) },
      { name: "postil/gate" },
    ]) {
      const observed: string[] = [];
      globalThis.fetch = (async (_input, init) => {
        observed.push(init?.method ?? "GET");
        return Response.json(checkRun(mismatch));
      }) as typeof fetch;
      await expect(
        completeGitHubCheckRun("token", "octo/repo", checkRunCompletionIntent),
      ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
      expect(observed).toEqual(["GET"]);
    }
  });

  test("validates annotations and aborts before a completion write", async () => {
    const invalidIntents = [
      { annotations: Array.from({ length: 51 }, () => checkRunCompletionIntent.annotations[0]!) },
      { annotations: [{ ...checkRunCompletionIntent.annotations[0]!, path: "bad\0path" }] },
      { annotations: [{ ...checkRunCompletionIntent.annotations[0]!, startLine: 0 }] },
      { annotations: [{ ...checkRunCompletionIntent.annotations[0]!, endLine: 11 }] },
      { annotations: [{ ...checkRunCompletionIntent.annotations[0]!, endColumn: undefined }] },
    ];
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("unexpected request");
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    for (const invalid of invalidIntents) {
      await expect(
        completeGitHubCheckRun("token", "octo/repo", {
          ...checkRunCompletionIntent,
          ...invalid,
        }),
      ).rejects.toThrow("intent is invalid");
    }

    const controller = new AbortController();
    controller.abort();
    await expect(
      completeGitHubCheckRun(
        "token",
        "octo/repo",
        checkRunCompletionIntent,
        controller.signal,
      ),
    ).rejects.toBeDefined();
  });
});
