import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CheckRun,
  type GhAttempt,
  type ReviewHeadObservation,
  acquireStateLock,
  discoveryOverlapStart,
  failedRunsForCommit,
  nextPageUrl,
  observationGroupsToPoll,
  observationStatus,
  parseIncludedResponse,
  parseArgs,
  pruneObservations,
  readReviewHeadState,
  requestGhApiPages,
  retryDelayMs,
  reviewHeadsFromTimeline,
  shouldPollObservation,
  shouldRefreshTimeline,
  shouldInvalidateObservation,
  shouldContinueClosedPullPages,
} from "../scripts/list-failed-postil-runs";

function check(overrides: Partial<CheckRun>): CheckRun {
  return {
    id: 1,
    name: "postil/gate",
    status: "completed",
    conclusion: "failure",
    head_sha: "b80bd237",
    started_at: "2026-07-11T17:20:37Z",
    completed_at: "2026-07-11T17:23:49Z",
    details_url: "https://postil.dev/orgs/postil-dev/runs/run-id",
    html_url: "https://github.com/postil-dev/postil/runs/1",
    app: { slug: "postil-dev" },
    output: {
      title: "Merge gate failed",
      summary: "Merge gate failed: one finding",
    },
    ...overrides,
  };
}

function observation(
  overrides: Partial<ReviewHeadObservation> = {},
): ReviewHeadObservation {
  return {
    repo: "postil-dev/postil",
    pr: 354,
    prUrl: "https://github.com/postil-dev/postil/pull/354",
    commit: "b80bd237",
    current: false,
    prState: "closed",
    prUpdatedAt: "2026-07-11T17:30:00Z",
    status: "terminal",
    checks: [check({ conclusion: "success" })],
    checkedAt: "2026-07-11T17:31:00Z",
    statusSince: "2026-07-11T17:31:00Z",
    ...overrides,
  };
}

describe("failed Postil run polling", () => {
  test("validates and normalizes the requested time window", () => {
    expect(
      parseArgs(
        ["--since", "2026-07-11T17:10:00Z", "--until", "2026-07-11T17:46:00Z"],
        new Date("2026-07-12T00:00:00Z"),
      ),
    ).toEqual(expect.objectContaining({
      org: "postil-dev",
      since: "2026-07-11T17:10:00.000Z",
      until: "2026-07-11T17:46:00.000Z",
    }));
    expect(() => parseArgs([])).toThrow("--since is required");
    expect(() =>
      parseArgs(["--since", "2026-07-11T18:00:00Z", "--until", "2026-07-11T17:00:00Z"]),
    ).toThrow("--since must be earlier");
  });

  test("pairs a failed gate with its review metadata", () => {
    const gate = check({ id: 86567071984 });
    const review = check({
      id: 86567071435,
      name: "postil/review",
      conclusion: "success",
      output: {
        title: "1 error, 0 warn, 0 info",
        summary: "A false-positive finding.\n\nModel: moonshotai/kimi-k2.6\n",
      },
    });

    expect(
      failedRunsForCommit(
        "postil-dev/postil",
        354,
        "https://github.com/postil-dev/postil/pull/354",
        "b80bd237",
        [gate, review],
        "2026-07-11T17:10:00Z",
        "2026-07-11T17:46:00Z",
      ),
    ).toEqual([
      {
        repo: "postil-dev/postil",
        pr: 354,
        prUrl: "https://github.com/postil-dev/postil/pull/354",
        prCandidates: [354],
        commit: "b80bd237",
        org: "postil-dev",
        model: "moonshotai/kimi-k2.6",
        startedAt: "2026-07-11T17:20:37Z",
        completedAt: "2026-07-11T17:23:49Z",
        kind: "gate",
        error: "Merge gate failed: one finding",
        gateCheckId: 86567071984,
        gateCheckUrl: "https://github.com/postil-dev/postil/runs/1",
        reviewCheckId: 86567071435,
        detailsUrl: "https://postil.dev/orgs/postil-dev/runs/run-id",
      },
    ]);
  });

  test("pairs reruns on one commit with the nearest review attempt", () => {
    const oldReview = check({
      id: 10,
      name: "postil/review",
      conclusion: "success",
      started_at: "2026-07-11T17:12:00Z",
      completed_at: "2026-07-11T17:13:00Z",
      output: { title: "clean", summary: "Model: old/model\n" },
    });
    const gate = check({ id: 20 });
    const matchingReview = check({
      id: 21,
      name: "postil/review",
      conclusion: "success",
      output: { title: "finding", summary: "Model: matching/model\n" },
    });

    const [failure] = failedRunsForCommit(
      "postil-dev/postil",
      354,
      "https://github.com/postil-dev/postil/pull/354",
      "b80bd237",
      [oldReview, gate, matchingReview],
      "2026-07-11T17:10:00Z",
      "2026-07-11T17:46:00Z",
    );

    expect(failure?.reviewCheckId).toBe(21);
    expect(failure?.model).toBe("matching/model");
  });

  test("classifies fail-closed operational errors by check state, not display title", () => {
    const advisory = check({
      id: 30,
      name: "postil/review",
      conclusion: "neutral",
      details_url: null,
      output: {
        title: "No verdict available",
        summary: "Postil could not complete this review: watchdog deadline exceeded",
      },
    });
    const failedGate = check({
      id: 31,
      details_url: null,
      output: {
        title: "Required review unavailable",
        summary: "The gate fails closed because the review did not complete",
      },
    });

    const [failure] = failedRunsForCommit(
      "postil-dev/postil",
      354,
      "https://github.com/postil-dev/postil/pull/354",
      "b80bd237",
      [failedGate, advisory],
      "2026-07-11T17:10:00Z",
      "2026-07-11T17:46:00Z",
    );

    expect(failure).toMatchObject({
      kind: "operational",
      org: "postil-dev",
      model: null,
      error: "Postil could not complete this review: watchdog deadline exceeded",
      gateCheckId: 31,
      reviewCheckId: 30,
    });
  });

  test("falls back to the nearest same-head check when details URLs differ", () => {
    const gate = check({ id: 40 });
    const review = check({
      id: 41,
      name: "postil/review",
      conclusion: "success",
      details_url: null,
      output: { title: "finding", summary: "Model: fallback/model\n" },
    });

    const [failure] = failedRunsForCommit(
      "postil-dev/postil",
      354,
      "https://github.com/postil-dev/postil/pull/354",
      "b80bd237",
      [gate, review],
      "2026-07-11T17:10:00Z",
      "2026-07-11T17:46:00Z",
    );

    expect(failure?.reviewCheckId).toBe(41);
    expect(failure?.model).toBe("fallback/model");
  });

  test("does not classify a neutral superseded check pair as operational", () => {
    const advisory = check({
      id: 50,
      name: "postil/review",
      conclusion: "neutral",
      output: { title: "Review superseded", summary: "A newer head exists." },
    });
    const gate = check({
      id: 51,
      conclusion: "neutral",
      output: { title: "Review superseded", summary: "A newer head exists." },
    });

    expect(
      failedRunsForCommit(
        "postil-dev/postil",
        354,
        "https://github.com/postil-dev/postil/pull/354",
        "b80bd237",
        [advisory, gate],
        "2026-07-11T17:10:00Z",
        "2026-07-11T17:46:00Z",
      ),
    ).toEqual([]);
  });

  test("ignores other apps and failures outside the half-open window", () => {
    expect(
      failedRunsForCommit(
        "postil-dev/postil",
        354,
        "https://github.com/postil-dev/postil/pull/354",
        "b80bd237",
        [
          check({ app: { slug: "another-app" } }),
          check({ id: 2, completed_at: "2026-07-11T17:46:00Z" }),
          check({ id: 3, pull_requests: [{ number: 999 }] }),
        ],
        "2026-07-11T17:10:00Z",
        "2026-07-11T17:46:00Z",
      ),
    ).toEqual([]);
  });

  test("retains normal and force-push timeline commits", () => {
    const head = {
      repo: "postil-dev/postil",
      pr: 354,
      prUrl: "https://github.com/postil-dev/postil/pull/354",
      commit: "current",
    };
    expect(
      reviewHeadsFromTimeline(head, [
        { event: "committed", sha: "normal-head" },
        { event: "head_ref_force_pushed", commit_id: "force-push-head" },
        { event: "labeled", commit_id: "unrelated" },
      ]).map(({ commit }) => commit),
    ).toEqual(["normal-head", "force-push-head"]);
  });

  test("parses included response headers and pagination links", () => {
    const response = parseIncludedResponse(
      "HTTP/2 200 OK\r\nContent-Type: application/json\r\nLink: <https://api.github.com/page/2>; rel=\"next\", <https://api.github.com/page/4>; rel=\"last\"\r\n\r\n[{\"id\":1}]",
    );
    expect(response).toEqual({
      status: 200,
      headers: {
        "content-type": "application/json",
        link: '<https://api.github.com/page/2>; rel="next", <https://api.github.com/page/4>; rel="last"',
      },
      body: '[{"id":1}]',
    });
    expect(nextPageUrl(response.headers)).toBe("https://api.github.com/page/2");
    expect(nextPageUrl({})).toBeNull();
  });

  test("calculates header-aware retry delays", () => {
    expect(retryDelayMs({
      attempt: 1,
      status: 429,
      headers: { "retry-after": "12" },
      message: "rate limited",
      jitterMs: 250,
    })).toBe(12_250);
    expect(retryDelayMs({
      attempt: 1,
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1060" },
      message: "primary rate limit",
      nowMs: 1_000_000,
      jitterMs: 500,
    })).toBe(60_500);
    expect(retryDelayMs({
      attempt: 2,
      status: 403,
      headers: { "x-ratelimit-remaining": "4935" },
      message: "secondary rate limit",
      jitterMs: 100,
    })).toBe(120_100);
    expect(retryDelayMs({
      attempt: 2,
      message: "EOF while parsing a value",
      jitterMs: 75,
    })).toBe(4_075);
    expect(retryDelayMs({ attempt: 1, status: 404, message: "not found" })).toBeNull();
    expect(retryDelayMs({ attempt: 1, status: 403, message: "forbidden" })).toBeNull();
  });

  test("waits for a secondary limit before retrying successfully", async () => {
    const attempts: GhAttempt[] = [
      {
        exitCode: 1,
        stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)",
        timedOut: false,
        response: {
          status: 403,
          headers: { "x-ratelimit-remaining": "4935" },
          body: '{"message":"You have exceeded a secondary rate limit."}',
        },
      },
      {
        exitCode: 0,
        stderr: "",
        timedOut: false,
        response: { status: 200, headers: {}, body: '[{"id":1}]' },
      },
    ];
    const delays: number[] = [];

    const pages = await requestGhApiPages<Array<{ id: number }>>(
      "repos/postil-dev/postil/pulls?per_page=100",
      {},
      {
        attempt: async () => attempts.shift()!,
        sleep: async (milliseconds) => { delays.push(milliseconds); },
        random: () => 0.25,
        now: () => Date.parse("2026-07-11T17:45:00Z"),
      },
    );

    expect(delays).toEqual([60_250]);
    expect(pages).toEqual([[{ id: 1 }]]);
    expect(attempts).toHaveLength(0);
  });

  test("does not retry a permanent client error", async () => {
    let attempts = 0;
    const request = requestGhApiPages(
      "repos/postil-dev/missing",
      {},
      {
        attempt: async (): Promise<GhAttempt> => {
          attempts += 1;
          return {
            exitCode: 1,
            stderr: "gh: Not Found (HTTP 404)",
            timedOut: false,
            response: { status: 404, headers: {}, body: '{"message":"Not Found"}' },
          };
        },
        sleep: async () => { throw new Error("unexpected retry"); },
        random: () => 0,
        now: () => 0,
      },
    );

    await expect(request).rejects.toThrow("Not Found");
    expect(attempts).toBe(1);
  });

  test("throws after giving a transient CLI failure two backed-off retries", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const request = requestGhApiPages(
      "repos/postil-dev/postil/commits/abc/check-runs",
      {},
      {
        attempt: async (): Promise<GhAttempt> => {
          attempts += 1;
          return {
            exitCode: 1,
            stderr: "Could not parse config file as JSON: EOF while parsing a value",
            timedOut: false,
          };
        },
        sleep: async (milliseconds) => { delays.push(milliseconds); },
        random: () => 0,
        now: () => 0,
      },
    );

    await expect(request).rejects.toThrow("Could not parse config file as JSON");
    expect(attempts).toBe(3);
    expect(delays).toEqual([2_000, 4_000]);
  });

  test("refreshes timelines only for new or changed pull request state", () => {
    const existing = observation({ current: true, prState: "open" });
    const unchanged = {
      number: 354,
      html_url: existing.prUrl,
      head: { sha: existing.commit },
      state: "open" as const,
      updated_at: "2026-07-11T17:40:00Z",
    };
    expect(shouldRefreshTimeline(unchanged, [existing], "2026-07-11T17:10:00Z", false)).toBe(false);
    expect(shouldRefreshTimeline(
      { ...unchanged, head: { sha: "changed" } },
      [existing],
      "2026-07-11T17:10:00Z",
      false,
    )).toBe(true);
    expect(shouldRefreshTimeline(
      { ...unchanged, state: "closed" },
      [existing],
      "2026-07-11T17:10:00Z",
      false,
    )).toBe(true);
    expect(shouldInvalidateObservation(existing, { ...unchanged, state: "closed" })).toBe(true);
    expect(shouldInvalidateObservation(existing, unchanged)).toBe(false);
    expect(shouldRefreshTimeline(
      { ...unchanged, updated_at: "2026-07-10T00:00:00Z" },
      [existing],
      "2026-07-11T17:10:00Z",
      true,
    )).toBe(false);
    expect(discoveryOverlapStart("2026-07-11T17:10:00Z")).toBe("2026-07-11T16:10:00.000Z");
    expect(shouldContinueClosedPullPages([unchanged], "2026-07-11T16:10:00Z")).toBe(true);
    expect(shouldContinueClosedPullPages([
      { ...unchanged, updated_at: "2026-07-11T16:00:00Z" },
    ], "2026-07-11T16:10:00Z")).toBe(false);
  });

  test("polls active and nonterminal heads but skips cached terminal history", () => {
    expect(observationStatus([])).toBe("empty");
    expect(observationStatus([check({ status: "queued", completed_at: null })])).toBe("pending");
    expect(observationStatus([check({ status: "completed" })])).toBe("terminal");
    const now = Date.parse("2026-07-11T17:45:00Z");
    expect(shouldPollObservation(observation({ current: true, prState: "open" }), now)).toBe(true);
    expect(shouldPollObservation(observation({ status: "pending" }), now)).toBe(true);
    expect(shouldPollObservation(observation({
      status: "empty",
      checks: [],
      checkedAt: null,
    }), now)).toBe(true);
    expect(shouldPollObservation(observation({
      status: "empty",
      checks: [],
      checkedAt: "2026-07-11T16:00:00Z",
    }), now)).toBe(false);
    expect(shouldPollObservation(observation({
      status: "empty",
      checks: [],
      checkedAt: "2026-07-11T17:15:00Z",
    }), now)).toBe(true);
    expect(shouldPollObservation(observation(), now)).toBe(false);
    expect(shouldPollObservation(observation({ checkedAt: "2026-07-11T16:00:00Z" }), now)).toBe(false);
  });

  test("deduplicates check-run requests by repository and commit", () => {
    const first = observation({ pr: 354, status: "pending" });
    const duplicate = observation({ pr: 355, status: "terminal" });
    const other = observation({ pr: 356, commit: "other", status: "unobserved" });

    expect(observationGroupsToPoll([first, duplicate, other])).toEqual([
      [first, duplicate],
      [other],
    ]);
  });

  test("prunes old terminal history while retaining recent, pending, and empty heads", () => {
    const oldTerminal = observation({
      commit: "old",
      checks: [check({ completed_at: "2026-07-11T17:00:00Z" })],
      checkedAt: "2026-07-11T16:00:00Z",
    });
    const recentTerminal = observation({
      commit: "recent",
      checks: [check({ completed_at: "2026-07-11T17:20:00Z" })],
    });
    const pending = observation({ commit: "pending", status: "pending" });
    const stalePending = observation({
      commit: "stale-pending",
      status: "pending",
      checkedAt: "2026-07-10T16:00:00Z",
    });
    const empty = observation({ commit: "empty", status: "empty", checks: [] });
    const staleEmpty = observation({
      commit: "stale-empty",
      status: "empty",
      checks: [],
      checkedAt: "2026-07-10T16:00:00Z",
    });
    expect(
      pruneObservations(
        [oldTerminal, recentTerminal, pending, stalePending, empty, staleEmpty],
        "2026-07-11T17:10:00Z",
        Date.parse("2026-07-11T17:30:00Z"),
      ).map(({ commit }) => commit),
    ).toEqual(["recent", "pending", "empty"]);
  });

  test("limits refreshed timeline history to the requested window", () => {
    const head = {
      repo: "postil-dev/postil",
      pr: 354,
      prUrl: "https://github.com/postil-dev/postil/pull/354",
      commit: "current",
    };
    expect(reviewHeadsFromTimeline(head, [
      { event: "committed", sha: "old", created_at: "2026-07-11T16:00:00Z" },
      { event: "committed", sha: "recent", created_at: "2026-07-11T17:20:00Z" },
    ], "2026-07-11T17:10:00Z").map(({ commit }) => commit)).toEqual(["recent"]);
  });

  test("reads legacy v1 state without losing heads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "postil-failed-runs-v1-"));
    const statePath = join(directory, "state.json");
    const head = {
      repo: "postil-dev/postil",
      pr: 354,
      prUrl: "https://github.com/postil-dev/postil/pull/354",
      commit: "legacy",
    };
    try {
      await writeFile(statePath, JSON.stringify({ version: 1, org: "postil-dev", heads: [head] }));
      expect(await readReviewHeadState(statePath, "postil-dev")).toEqual([head]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed state instead of dropping historical heads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "postil-failed-runs-"));
    const statePath = join(directory, "state.json");
    try {
      await writeFile(
        statePath,
        JSON.stringify({
          version: 1,
          org: "postil-dev",
          heads: [{ repo: "postil-dev/postil", pr: 354 }],
        }),
      );
      await expect(readReviewHeadState(statePath, "postil-dev")).rejects.toThrow(
        "is invalid",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects overlapping polls and releases the OS lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "postil-failed-runs-lock-"));
    const lockPath = join(directory, "state.lock");
    try {
      const release = await acquireStateLock(lockPath);
      await expect(acquireStateLock(lockPath)).rejects.toThrow("another failed-run poll");
      await release();

      const releaseAgain = await acquireStateLock(lockPath);
      await releaseAgain();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
