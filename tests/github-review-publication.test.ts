import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  completeGitHubCheckRun,
  createGitHubCheckRun,
  findGitHubCheckRunByExternalId,
  findGitHubFileCommentByMarker,
  findGitHubFileCommentByMarkers,
  findGitHubReviewByMarker,
  findGitHubReviewByMarkers,
  GitHubPublicationAmbiguousError,
  GitHubPublicationRejectedError,
  GitHubReviewPlacementRejectedError,
  observeGitHubCheckRunCompletion,
  observeGitHubCompositeReviewByMarkers,
  observeGitHubReviewComment,
  publishGitHubCompositeReview,
  publishGitHubFileComment,
  updateGitHubReviewComment,
  updateGitHubReviewSummary,
} from "@/lib/github/review-publication";

const ORIGINAL_FETCH = globalThis.fetch;
const HEAD_SHA = "a".repeat(40);
const REVIEW_MARKER = `<!-- postil-review:v2:${"b".repeat(64)} -->`;
const FINDING_MARKER = `<!-- postil-finding:v2:${"c".repeat(64)} -->`;
const SECOND_FINDING_MARKER = `<!-- postil-finding:v2:${"d".repeat(64)} -->`;
const LEGACY_REVIEW_MARKER = `<!-- postil-review:v1:${"e".repeat(12)} -->`;
const LEGACY_FINDING_MARKER = `<!-- postil-finding:v1:${"f".repeat(12)} -->`;
const CHECK_EXTERNAL_ID = "postil:review-run:review";
const CHECK_DETAILS_URL = "https://postil.dev/orgs/octo/runs/review-run";
const TEST_GITHUB_APP_ID = 123;
const TEST_GITHUB_APP_SLUG = "postil-dev";
const ORIGINAL_GITHUB_APP_ID = process.env.GITHUB_APP_ID;

beforeEach(() => {
  process.env.GITHUB_APP_ID = String(TEST_GITHUB_APP_ID);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.GITHUB_APP_ID = String(TEST_GITHUB_APP_ID);
});

afterAll(() => {
  if (ORIGINAL_GITHUB_APP_ID === undefined) delete process.env.GITHUB_APP_ID;
  else process.env.GITHUB_APP_ID = ORIGINAL_GITHUB_APP_ID;
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

function findingMarker(index: number): string {
  return `<!-- postil-finding:v2:${index.toString(16).padStart(64, "0")} -->`;
}

function checkAnnotationIntent(index: number) {
  return {
    path: `src/file-${index}.ts`,
    startLine: index + 1,
    endLine: index + 1,
    annotationLevel: "warning" as const,
    message: `Review finding ${index}`,
  };
}

function checkAnnotationResponse(index: number) {
  return {
    path: `src/file-${index}.ts`,
    start_line: index + 1,
    end_line: index + 1,
    annotation_level: "warning",
    message: `Review finding ${index}`,
  };
}

function installChunkedCheckCompletionFake(
  initialAnnotationCount = 0,
  uncertainFirstPatch = false,
) {
  const remoteAnnotations: Array<Record<string, unknown>> = Array.from(
    { length: initialAnnotationCount },
    (_, index) => checkAnnotationResponse(index),
  );
  let remoteRun = checkRun(initialAnnotationCount === 0
    ? {}
    : {
        output: {
          title: checkRunCompletionIntent.title,
          summary: checkRunCompletionIntent.summary,
        },
      });
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(input));
    if (isCheckRunAnnotationsRequest(input)) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * 25;
      const response = remoteAnnotations.slice(start, start + 25);
      return Response.json(response, remoteAnnotations.length > start + 25
        ? {
            headers: {
              Link: `<https://api.github.test/annotations?page=${page + 1}>; rel="next"`,
            },
          }
        : undefined);
    }
    if (method === "GET") return Response.json(remoteRun);

    const patch = JSON.parse(String(init?.body)) as {
      status: string;
      conclusion?: string;
      details_url?: string;
      output: {
        title: string;
        summary: string;
        annotations?: Array<Record<string, unknown>>;
      };
    };
    patches.push(patch);
    remoteAnnotations.push(...(patch.output.annotations ?? []));
    remoteRun = checkRun({
      status: patch.status,
      conclusion: patch.conclusion ?? null,
      details_url: patch.details_url,
      output: {
        title: patch.output.title,
        summary: patch.output.summary,
      },
    });
    if (uncertainFirstPatch && patches.length === 1) {
      throw new TypeError("connection reset after write");
    }
    return Response.json(remoteRun);
  }) as typeof fetch;
  return { patches, remoteAnnotations };
}

describe("GitHub publication observations", () => {
  test("observes compatible review and finding markers across every page without mutation", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (input, init) => {
      methods.push(init?.method ?? "GET");
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reviews")) {
        return url.searchParams.get("page") === "1"
          ? Response.json([
              review({ body: `Review summary\n\n${LEGACY_REVIEW_MARKER}` }),
            ], {
              headers: {
                Link: '<https://api.github.test/reviews?page=2>; rel="next"',
              },
            })
          : Response.json([]);
      }
      return Response.json([
        reviewComment({ body: `Finding body\n\n${LEGACY_FINDING_MARKER}` }),
      ]);
    }) as typeof fetch;

    await expect(
      observeGitHubCompositeReviewByMarkers(
        "token",
        "octo/repo",
        7,
        [REVIEW_MARKER, LEGACY_REVIEW_MARKER],
        HEAD_SHA,
        [{
          marker: FINDING_MARKER,
          compatibleMarkers: [LEGACY_FINDING_MARKER],
        }],
      ),
    ).resolves.toMatchObject({
      reviewId: "41",
      commentIdsByMarker: { [FINDING_MARKER]: "51" },
      missingCommentMarkers: [],
    });
    expect(methods).toEqual(["GET", "GET", "GET"]);
  });

  test("rejects compatible review duplicates found on later pages", async () => {
    let requests = 0;
    globalThis.fetch = (async (_input, _init) => {
      requests += 1;
      return requests === 1
        ? Response.json([review()], {
            headers: {
              Link: '<https://api.github.test/reviews?page=2>; rel="next"',
            },
          })
        : Response.json([
            review({
              id: 42,
              body: `Review summary\n\n${LEGACY_REVIEW_MARKER}`,
            }),
          ]);
    }) as typeof fetch;

    await expect(
      findGitHubReviewByMarkers(
        "token",
        "octo/repo",
        7,
        [REVIEW_MARKER, LEGACY_REVIEW_MARKER],
        HEAD_SHA,
      ),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
    expect(requests).toBe(2);
  });

  test("observes compatible file-comment markers and rejects later duplicates", async () => {
    let requests = 0;
    globalThis.fetch = (async (_input, _init) => {
      requests += 1;
      if (requests === 1) {
        return Response.json([
          reviewComment({
            subject_type: "file",
            body: `Finding body\n\n${LEGACY_FINDING_MARKER}`,
          }),
        ], {
          headers: {
            Link: '<https://api.github.test/comments?page=2>; rel="next"',
          },
        });
      }
      return Response.json([]);
    }) as typeof fetch;

    await expect(
      findGitHubFileCommentByMarkers(
        "token",
        "octo/repo",
        7,
        HEAD_SHA,
        "src/main.ts",
        [FINDING_MARKER, LEGACY_FINDING_MARKER],
      ),
    ).resolves.toMatchObject({ commentId: "51" });
    expect(requests).toBe(2);

    requests = 0;
    globalThis.fetch = (async (_input, _init) => {
      requests += 1;
      return requests === 1
        ? Response.json([reviewComment({ subject_type: "file" })], {
            headers: {
              Link: '<https://api.github.test/comments?page=2>; rel="next"',
            },
          })
        : Response.json([
            reviewComment({
              id: 52,
              subject_type: "file",
              body: `Finding body\n\n${LEGACY_FINDING_MARKER}`,
            }),
          ]);
    }) as typeof fetch;
    await expect(
      findGitHubFileCommentByMarker("token", "octo/repo", 7, {
        commitId: HEAD_SHA,
        path: "src/main.ts",
        body: `Finding body\n\n${FINDING_MARKER}`,
        marker: FINDING_MARKER,
        compatibleMarkers: [LEGACY_FINDING_MARKER],
      }),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
    expect(requests).toBe(2);
  });

  test("exposes check and review-comment state through GET-only APIs", async () => {
    const methods: string[] = [];
    let request = 0;
    globalThis.fetch = (async (input, init) => {
      methods.push(init?.method ?? "GET");
      request += 1;
      if (request === 1) {
        return Response.json({ check_runs: [checkRun()] });
      }
      if (request === 2) {
        return Response.json(checkRun({
          status: "completed",
          conclusion: "success",
          output: {
            title: checkRunCompletionIntent.title,
            summary: checkRunCompletionIntent.summary,
          },
        }));
      }
      if (isCheckRunAnnotationsRequest(input)) {
        return Response.json([checkRunAnnotation()]);
      }
      return Response.json(reviewComment());
    }) as typeof fetch;

    await expect(
      findGitHubCheckRunByExternalId(
        "token",
        "octo/repo",
        checkRunStartIntent,
      ),
    ).resolves.toMatchObject({ checkRunId: "61", status: "in_progress" });
    await expect(
      observeGitHubCheckRunCompletion(
        "token",
        "octo/repo",
        checkRunCompletionIntent,
      ),
    ).resolves.toMatchObject({ checkRunId: "61", desiredState: "applied" });
    await expect(
      observeGitHubReviewComment("token", "octo/repo", {
        commentId: "51",
        commitId: HEAD_SHA,
        path: "src/main.ts",
        expectedMarkers: [FINDING_MARKER, LEGACY_FINDING_MARKER],
        body: `Updated finding\n\n${FINDING_MARKER}`,
      }),
    ).resolves.toMatchObject({ commentId: "51" });
    expect(methods).toEqual(["GET", "GET", "GET", "GET"]);
  });

  test("bounds compatible marker sets and duplicate comment proof before mutation", async () => {
    let requests = 0;
    globalThis.fetch = (async (_input, _init) => {
      requests += 1;
      return requests === 1
        ? Response.json([review()])
        : Response.json([
            reviewComment(),
            reviewComment({ id: 52 }),
            reviewComment({ id: 53 }),
          ]);
    }) as typeof fetch;
    await expect(
      observeGitHubCompositeReviewByMarkers(
        "token",
        "octo/repo",
        7,
        [REVIEW_MARKER],
        HEAD_SHA,
        [FINDING_MARKER],
      ),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
    expect(requests).toBe(2);

    const maximumMarkers = [
      REVIEW_MARKER,
      ...Array.from(
        { length: 15 },
        (_, index) =>
          `<!-- postil-review:v2:${index.toString(16).padStart(64, "0")} -->`,
      ),
    ];
    globalThis.fetch = Object.assign(
      async () => Response.json([review()]),
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    await expect(
      findGitHubReviewByMarkers(
        "token",
        "octo/repo",
        7,
        maximumMarkers,
        HEAD_SHA,
      ),
    ).resolves.toMatchObject({ reviewId: "41" });

    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("unexpected request");
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;
    const tooManyMarkers = Array.from(
      { length: 17 },
      (_, index) => `<!-- postil-review:v2:${index.toString(16).padStart(64, "0")} -->`,
    );
    await expect(
      findGitHubReviewByMarkers(
        "token",
        "octo/repo",
        7,
        tooManyMarkers,
        HEAD_SHA,
      ),
    ).rejects.toThrow("intent is invalid");
    await expect(
      observeGitHubCompositeReviewByMarkers(
        "token",
        "octo/repo",
        7,
        [REVIEW_MARKER],
        HEAD_SHA,
        [
          { marker: FINDING_MARKER, compatibleMarkers: [LEGACY_FINDING_MARKER] },
          { marker: SECOND_FINDING_MARKER, compatibleMarkers: [LEGACY_FINDING_MARKER] },
        ],
      ),
    ).rejects.toThrow("intent is invalid");
  });
});

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

  test("accepts only released marker versions and exact digest widths", async () => {
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json(review());
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    for (const marker of [
      `<!-- postil-review:v2:${"e".repeat(32)} -->`,
      `<!-- postil-review:v3:${"e".repeat(64)} -->`,
    ]) {
      await expect(
        publishGitHubCompositeReview("token", "octo/repo", 7, {
          ...compositeIntent,
          marker,
          body: `Review summary\n\n${marker}`,
        }),
      ).rejects.toThrow("invalid");
    }
    expect(requests).toBe(0);
  });

  test("accepts 64 comments, rejects 65, and caps the serialized request", async () => {
    const comments = Array.from({ length: 65 }, (_, index) => {
      const marker = findingMarker(index + 1);
      return {
        path: `src/file-${index}.ts`,
        line: index + 1,
        side: "RIGHT" as const,
        body: `Finding ${index}\n\n${marker}`,
        marker,
      };
    });
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return new Response(null, { status: 400 });
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, {
        ...compositeIntent,
        comments: comments.slice(0, 64),
      }),
    ).rejects.toBeInstanceOf(GitHubPublicationRejectedError);
    expect(requests).toBe(1);
    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, {
        ...compositeIntent,
        comments,
      }),
    ).rejects.toThrow("intent is invalid");
    expect(requests).toBe(1);

    const escapingComments = Array.from({ length: 31 }, (_, index) => {
      const marker = findingMarker(index + 100);
      return {
        path: `src/escaped-${index}.ts`,
        line: index + 1,
        side: "RIGHT" as const,
        body: marker + "\\".repeat(128 * 1024 - Buffer.byteLength(marker)),
        marker,
      };
    });
    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, {
        ...compositeIntent,
        comments: escapingComments,
      }),
    ).rejects.toThrow("intent is invalid");
    expect(requests).toBe(1);
  });

  test("uses the plan's exact 128 KiB review-body boundary", async () => {
    const exactBody = REVIEW_MARKER +
      "x".repeat(128 * 1024 - Buffer.byteLength(REVIEW_MARKER));
    let requests = 0;
    globalThis.fetch = (async (_input, _init) => {
      requests += 1;
      return Response.json(review({ body: exactBody }));
    }) as typeof fetch;

    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, {
        ...compositeIntent,
        body: exactBody,
        comments: [],
      }),
    ).resolves.toMatchObject({ body: exactBody });
    expect(requests).toBe(1);
    await expect(
      publishGitHubCompositeReview("token", "octo/repo", 7, {
        ...compositeIntent,
        body: `${exactBody}x`,
        comments: [],
      }),
    ).rejects.toThrow("intent is invalid");
    expect(requests).toBe(1);
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

  test("cancels an unused successful summary response body", async () => {
    let request = 0;
    let canceled = false;
    const finalBody = `Final summary\n\n${REVIEW_MARKER}`;
    globalThis.fetch = (async (_input, _init) => {
      request += 1;
      if (request === 1) return Response.json(review());
      if (request === 2) {
        return new Response(new ReadableStream({
          cancel() {
            canceled = true;
          },
        }));
      }
      return Response.json(review({ body: finalBody }));
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
    expect(canceled).toBe(true);
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

  test("uses the plan's exact 4096-byte path boundary", async () => {
    const exactPath = "a".repeat(4_096);
    let requests = 0;
    globalThis.fetch = (async (_input, _init) => {
      requests += 1;
      return Response.json(reviewComment({
        path: exactPath,
        subject_type: "file",
      }), { status: 201 });
    }) as typeof fetch;

    await expect(
      publishGitHubFileComment("token", "octo/repo", 7, {
        ...intent,
        path: exactPath,
      }),
    ).resolves.toMatchObject({ path: exactPath });
    await expect(
      publishGitHubFileComment("token", "octo/repo", 7, {
        ...intent,
        path: `${exactPath}a`,
      }),
    ).rejects.toThrow("intent is invalid");
    expect(requests).toBe(1);
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
  test("creates one exact run and tolerates an App slug rename", async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Response.json(
        checkRun({ app: { id: TEST_GITHUB_APP_ID, slug: "renamed-postil" } }),
      );
    }) as typeof fetch;

    await expect(
      createGitHubCheckRun("token", "octo_emu/repo.name-1", checkRunStartIntent),
    ).resolves.toBe("61");
    expect(requests).toEqual([
      {
        method: "POST",
        url: expect.stringContaining("/repos/octo_emu/repo.name-1/check-runs"),
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

  test("accepts HTTP details URLs at 2048 bytes and rejects credentials", async () => {
    const prefix = "http://example.test/";
    const exactUrl = prefix +
      "x".repeat(2_048 - Buffer.byteLength(prefix));
    let requests = 0;
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requests += 1;
      body = JSON.parse(String(init?.body));
      return Response.json(checkRun());
    }) as typeof fetch;

    await expect(
      createGitHubCheckRun("token", "octo/repo", {
        ...checkRunStartIntent,
        detailsUrl: exactUrl,
      }),
    ).resolves.toBe("61");
    expect(body?.details_url).toBe(exactUrl);
    for (const detailsUrl of [
      `${exactUrl}x`,
      "https://user@example.test/run",
      "https://user:password@example.test/run",
    ]) {
      await expect(
        createGitHubCheckRun("token", "octo/repo", {
          ...checkRunStartIntent,
          detailsUrl,
        }),
      ).rejects.toThrow("intent is invalid");
    }
    expect(requests).toBe(1);
  });

  test("rejects repository traversal and malformed GitHub names before fetch", async () => {
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json(checkRun());
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    for (const repository of [
      "../repo",
      "octo/.",
      "octo/..",
      "octo/repo/name",
      "octo/%2e%2e",
      "octo space/repo",
      "octo/repo space",
    ]) {
      await expect(
        createGitHubCheckRun("token", repository, checkRunStartIntent),
      ).rejects.toThrow("intent is invalid");
    }
    expect(requests).toBe(0);
  });

  test("reconciles one uncertain create across every linked page", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") throw new TypeError("connection reset");
      if (methods.length === 2) {
        return Response.json({
          check_runs: [
            checkRun({
              app: { id: TEST_GITHUB_APP_ID + 1, slug: "other-app" },
            }),
          ],
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

  test("rejects malformed or mismatched immutable App IDs before POST", async () => {
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests += 1;
        return Response.json(checkRun());
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    ) as typeof fetch;

    for (const id of [
      "0123",
      "+123",
      "9007199254740992",
      String(TEST_GITHUB_APP_ID + 1),
    ]) {
      process.env.GITHUB_APP_ID = id;
      await expect(
        createGitHubCheckRun("token", "octo/repo", checkRunStartIntent),
      ).rejects.toThrow("GitHub App configuration is invalid");
    }
    delete process.env.GITHUB_APP_ID;
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

  test("completes 64 annotations through bounded append and terminal patches", async () => {
    const intent = {
      ...checkRunCompletionIntent,
      annotations: Array.from({ length: 64 }, (_, index) =>
        checkAnnotationIntent(index)),
    };
    const state = installChunkedCheckCompletionFake();

    await expect(
      completeGitHubCheckRun("token", "octo/repo", intent),
    ).resolves.toBeUndefined();
    expect(state.patches.map((patch) => patch.status)).toEqual([
      "in_progress",
      "completed",
    ]);
    expect(state.patches.map((patch) =>
      (patch.output as { annotations?: unknown[] }).annotations?.length ?? 0
    )).toEqual([50, 14]);
    expect(state.patches.every((patch) =>
      Buffer.byteLength(JSON.stringify(patch)) <= 4 * 1024 * 1024
    )).toBe(true);
    expect(state.remoteAnnotations).toHaveLength(64);
  });

  test("appends every remaining annotation before a smaller terminal patch", async () => {
    const control = "\u0001";
    const summary = control.repeat(65_535);
    const fullAnnotation = {
      path: control.repeat(4_096),
      startLine: 1,
      endLine: 1,
      annotationLevel: "warning" as const,
      message: control.repeat(65_535),
      title: control.repeat(255),
      rawDetails: control.repeat(65_535),
    };
    const annotations = Array.from({ length: 5 }, () => ({ ...fullAnnotation }));
    const apiAnnotation = (annotation: typeof fullAnnotation) => ({
      path: annotation.path,
      start_line: annotation.startLine,
      end_line: annotation.endLine,
      annotation_level: annotation.annotationLevel,
      message: annotation.message,
      title: annotation.title,
      raw_details: annotation.rawDetails,
    });
    const intermediateBody = (rawDetails: string) => ({
      status: "in_progress",
      output: {
        title: checkRunCompletionIntent.title,
        summary,
        annotations: [
          ...annotations.slice(0, 4).map(apiAnnotation),
          apiAnnotation({ ...fullAnnotation, rawDetails }),
        ],
      },
      details_url: CHECK_DETAILS_URL,
    });
    const oneByteBody = intermediateBody(control);
    const remainingBytes = 4 * 1024 * 1024 -
      Buffer.byteLength(JSON.stringify(oneByteBody));
    const rawDetails = control.repeat(1 + Math.floor(remainingBytes / 6));
    annotations[4] = { ...fullAnnotation, rawDetails };
    expect(Buffer.byteLength(JSON.stringify(intermediateBody(rawDetails))))
      .toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify({
      ...intermediateBody(rawDetails),
      status: "completed",
      conclusion: "success",
    }))).toBeGreaterThan(4 * 1024 * 1024);

    const intent = {
      ...checkRunCompletionIntent,
      summary,
      annotations,
    };
    const remoteAnnotations: Array<Record<string, unknown>> = [];
    const patches: Array<Record<string, unknown>> = [];
    let remoteRun = checkRun();
    globalThis.fetch = (async (input, init) => {
      const method = init?.method ?? "GET";
      if (isCheckRunAnnotationsRequest(input)) {
        return Response.json(remoteAnnotations);
      }
      if (method === "GET") return Response.json(remoteRun);
      const body = JSON.parse(String(init?.body)) as {
        status: string;
        conclusion?: string;
        details_url?: string;
        output: {
          title: string;
          summary: string;
          annotations?: Array<Record<string, unknown>>;
        };
      };
      patches.push(body);
      remoteAnnotations.push(...(body.output.annotations ?? []));
      remoteRun = checkRun({
        status: body.status,
        conclusion: body.conclusion ?? null,
        details_url: body.details_url,
        output: { title: body.output.title, summary: body.output.summary },
      });
      return Response.json(remoteRun);
    }) as typeof fetch;

    await expect(
      completeGitHubCheckRun("token", "octo/repo", intent),
    ).resolves.toBeUndefined();
    expect(patches.map((patch) =>
      (patch.output as { annotations?: unknown[] }).annotations?.length ?? 0
    )).toEqual([5, 0]);
    expect(remoteAnnotations).toHaveLength(5);
  });

  test("resumes an exact 50-annotation prefix without duplicating it", async () => {
    const intent = {
      ...checkRunCompletionIntent,
      annotations: Array.from({ length: 64 }, (_, index) =>
        checkAnnotationIntent(index)),
    };
    const state = installChunkedCheckCompletionFake(50);

    await expect(
      completeGitHubCheckRun("token", "octo/repo", intent),
    ).resolves.toBeUndefined();
    expect(state.patches).toHaveLength(1);
    expect(state.patches[0]?.status).toBe("completed");
    expect(
      (state.patches[0]?.output as { annotations?: unknown[] }).annotations,
    ).toHaveLength(14);
    expect(state.remoteAnnotations).toHaveLength(64);
  });

  test("reconciles an uncertain annotation append by its exact remote prefix", async () => {
    const intent = {
      ...checkRunCompletionIntent,
      annotations: Array.from({ length: 64 }, (_, index) =>
        checkAnnotationIntent(index)),
    };
    const state = installChunkedCheckCompletionFake(0, true);

    await expect(
      completeGitHubCheckRun("token", "octo/repo", intent),
    ).resolves.toBeUndefined();
    expect(state.patches.map((patch) => patch.status)).toEqual([
      "in_progress",
      "completed",
    ]);
    expect(state.remoteAnnotations).toHaveLength(64);
  });

  test("rejects a nonterminal non-prefix and desired-count overflow before patching", async () => {
    const intent = {
      ...checkRunCompletionIntent,
      annotations: Array.from({ length: 64 }, (_, index) =>
        checkAnnotationIntent(index)),
    };
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests += 1;
      if (isCheckRunAnnotationsRequest(input)) {
        return Response.json([
          checkAnnotationResponse(1),
        ]);
      }
      if (init?.method === "PATCH") throw new Error("unexpected patch");
      return Response.json(checkRun());
    }) as typeof fetch;
    await expect(
      completeGitHubCheckRun("token", "octo/repo", intent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
    expect(requests).toBe(2);

    requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests += 1;
      if (isCheckRunAnnotationsRequest(input)) {
        return Response.json(Array.from(
          { length: 65 },
          (_, index) => checkAnnotationResponse(index),
        ));
      }
      if (init?.method === "PATCH") throw new Error("unexpected patch");
      return Response.json(checkRun());
    }) as typeof fetch;
    await expect(
      completeGitHubCheckRun("token", "octo/repo", intent),
    ).rejects.toBeInstanceOf(GitHubPublicationAmbiguousError);
    expect(requests).toBe(2);
  });

  test("uses GitHub's exact 65,535-byte check-summary boundary", async () => {
    const exactSummary = "s".repeat(65_535);
    const intent = {
      ...checkRunCompletionIntent,
      summary: exactSummary,
      annotations: [],
    };
    let requests = 0;
    globalThis.fetch = (async (input) => {
      requests += 1;
      if (isCheckRunAnnotationsRequest(input)) return Response.json([]);
      return Response.json(checkRun({
        status: "completed",
        conclusion: "success",
        output: {
          title: intent.title,
          summary: exactSummary,
        },
      }));
    }) as typeof fetch;
    await expect(
      observeGitHubCheckRunCompletion("token", "octo/repo", intent),
    ).resolves.toMatchObject({ desiredState: "applied" });
    expect(requests).toBe(2);

    await expect(
      observeGitHubCheckRunCompletion("token", "octo/repo", {
        ...intent,
        summary: `${exactSummary}s`,
      }),
    ).rejects.toThrow("intent is invalid");
    expect(requests).toBe(2);
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
      { annotations: Array.from({ length: 65 }, () => checkRunCompletionIntent.annotations[0]!) },
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
