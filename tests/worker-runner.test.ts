import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ClaimedJob } from "@/lib/queue";

const OLD_ENV = { ...process.env };

const jobs: ClaimedJob[] = [];
const completed: number[] = [];
const failed: Array<{ id: number; error: string }> = [];
let claimCalls = 0;
let reviewRun: (() => Promise<void>) | undefined;
let respondRun: (() => Promise<void>) | undefined;
let reviewTiming: { queuedAt: Date; startedAt: Date } | undefined;

mock.module("@/lib/db", () => ({
  getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));

mock.module("@/lib/queue", () => ({
  claimJob: async () => {
    claimCalls += 1;
    return jobs.shift();
  },
  completeJob: async (_pool: unknown, job: ClaimedJob) => {
    completed.push(job.id);
  },
  failJob: async (_pool: unknown, job: ClaimedJob, error: string) => {
    failed.push({ id: job.id, error });
    return "failed";
  },
}));

mock.module("@/worker/watchdog", () => ({
  watchdogPass: async () => undefined,
}));

mock.module("@/worker/review", () => ({
  runReviewJob: async (
    _payload: unknown,
    timing: { queuedAt: Date; startedAt: Date },
  ) => {
    reviewTiming = timing;
    await reviewRun?.();
  },
}));

mock.module("@/worker/respond", () => ({
  postRespondFailureComment: async () => undefined,
  runRespondJob: async () => {
    await respondRun?.();
  },
}));

const { drainQueueOnce, triggerQueueDrain } = await import("@/worker/runner");

function reviewJob(id: number): ClaimedJob {
  return {
    id,
    kind: "review",
    payload: {
      installationId: 42,
      repoFullName: "octo/repo",
      prNumber: 7,
      headSha: "head",
      baseSha: "base",
    },
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date("2026-07-10T12:00:00.000Z"),
    lockedAt: new Date("2026-07-10T12:00:05.000Z"),
    lockedBy: "test",
  };
}

beforeEach(() => {
  Object.assign(process.env, OLD_ENV);
  jobs.length = 0;
  completed.length = 0;
  failed.length = 0;
  claimCalls = 0;
  reviewRun = async () => undefined;
  respondRun = async () => undefined;
  reviewTiming = undefined;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in OLD_ENV)) delete process.env[key];
  }
  Object.assign(process.env, OLD_ENV);
});

describe("drainQueueOnce", () => {
  test("processes no more than maxJobs", async () => {
    jobs.push(reviewJob(1), reviewJob(2));

    const drained = await drainQueueOnce("test-drain", { maxJobs: 1, deadlineMs: 60_000 });

    expect(drained).toBe(1);
    expect(completed).toEqual([1]);
    expect(jobs.map((job) => job.id)).toEqual([2]);
    expect(reviewTiming).toEqual({
      queuedAt: new Date("2026-07-10T12:00:00.000Z"),
      startedAt: new Date("2026-07-10T12:00:05.000Z"),
    });
  });

  test("redacts secret-looking tokens from the error handed to failJob and the log", async () => {
    jobs.push(reviewJob(1));
    const token = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
    reviewRun = async () => {
      throw new Error(`upstream rejected credential ${token}`);
    };
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await drainQueueOnce("redact-drain", { maxJobs: 1, deadlineMs: 60_000 });
    } finally {
      console.error = realError;
    }

    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).not.toContain(token);
    expect(failed[0]!.error).toContain("[redacted github token]");
    expect(logged.join("\n")).not.toContain(token);
  });

  test("stops after the drain deadline before claiming another job", async () => {
    jobs.push(reviewJob(1), reviewJob(2));
    const realNow = Date.now;
    let now = 0;
    Date.now = () => now;
    reviewRun = async () => {
      now = 2_000;
    };
    try {
      const drained = await drainQueueOnce("deadline-drain", { maxJobs: 2, deadlineMs: 1_000 });
      expect(drained).toBe(1);
      expect(completed).toEqual([1]);
      expect(jobs.map((job) => job.id)).toEqual([2]);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("triggerQueueDrain", () => {
  test("does nothing when webhook drain is disabled", async () => {
    process.env.POSTIL_WEBHOOK_DRAIN_ENABLED = "0";
    jobs.push(reviewJob(1));

    triggerQueueDrain("disabled");
    await Promise.resolve();

    expect(claimCalls).toBe(0);
    expect(completed).toEqual([]);
  });

  test("starts one background drain at a time", async () => {
    process.env.POSTIL_WEBHOOK_DRAIN_ENABLED = "1";
    jobs.push(reviewJob(1), reviewJob(2));
    let release: (() => void) | undefined;
    reviewRun = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    triggerQueueDrain("enabled");
    triggerQueueDrain("enabled");
    await waitFor(() => claimCalls > 0);

    expect(claimCalls).toBe(1);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toEqual([1]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
