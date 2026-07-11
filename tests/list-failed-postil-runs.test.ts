import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CheckRun,
  acquireStateLock,
  failedRunsForCommit,
  parseArgs,
  readReviewHeadState,
  reviewHeadsFromTimeline,
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

  test("classifies fail-closed operational errors by their review output", () => {
    const advisory = check({
      id: 30,
      name: "postil/review",
      conclusion: "neutral",
      details_url: null,
      output: {
        title: "Review did not complete",
        summary: "Postil could not complete this review: watchdog deadline exceeded",
      },
    });
    const failedGate = check({
      id: 31,
      details_url: null,
      output: {
        title: "Review did not complete",
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
