import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ClaimedJob } from "@/lib/queue";
import "./quiet-console";

const OLD_ENV = { ...process.env };

const jobs: ClaimedJob[] = [];
const completed: number[] = [];
const failed: Array<{ id: number; error: string }> = [];
const retriedIndefinitely: Array<{ id: number; error: string }> = [];
let claimCalls = 0;
const claimCapabilities: string[][] = [];
let reviewRun: (() => Promise<void>) | undefined;
let respondRun: (() => Promise<void>) | undefined;
let respondDeliveryRun: (() => Promise<void>) | undefined;
let respondFailureCommentRun: (() => Promise<void>) | undefined;
let billingContactVerificationRun: (() => Promise<void>) | undefined;
let gateStateSyncRun: (() => Promise<void>) | undefined;
let cleanupRun: (() => Promise<void>) | undefined;
let reviewTiming: { queuedAt: Date; startedAt: Date } | undefined;
let reviewProcessGroup: string | undefined;
const operationalFailures: string[] = [];
const operationalWarnings: string[] = [];

mock.module("@/lib/server-observability", () => ({
  reportOperationalFailure: (_processGroup: string, failureClass: string) => {
    operationalFailures.push(failureClass);
  },
  reportOperationalWarning: (_processGroup: string, warning: string) => {
    operationalWarnings.push(warning);
  },
}));

mock.module("@/lib/db", () => ({
  getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));

mock.module("@/lib/queue", () => ({
  claimJob: async (_pool: unknown, _workerId: string, allowedKinds: readonly string[]) => {
    claimCalls += 1;
    claimCapabilities.push([...allowedKinds]);
    return jobs.shift();
  },
  completeJob: async (_pool: unknown, job: ClaimedJob) => {
    completed.push(job.id);
  },
  failJob: async (_pool: unknown, job: ClaimedJob, error: string) => {
    failed.push({ id: job.id, error });
    return "failed";
  },
  retryJobIndefinitely: async (_pool: unknown, job: ClaimedJob, error: string) => {
    retriedIndefinitely.push({ id: job.id, error });
    return "retried";
  },
}));

mock.module("@/worker/watchdog", () => ({
  watchdogPass: async () => undefined,
}));

mock.module("@/worker/review", () => ({
  runCheckRunCleanupJob: async () => {
    await cleanupRun?.();
  },
  runReviewJob: async (
    _payload: unknown,
    timing: { queuedAt: Date; startedAt: Date },
    processGroup: string,
  ) => {
    reviewTiming = timing;
    reviewProcessGroup = processGroup;
    await reviewRun?.();
  },
}));

mock.module("@/worker/respond", () => ({
  postRespondFailureComment: async () => undefined,
  runRespondFailureCommentJob: async () => {
    await respondFailureCommentRun?.();
  },
  runRespondDeliveryJob: async () => {
    await respondDeliveryRun?.();
  },
  runRespondJob: async () => {
    await respondRun?.();
  },
}));

mock.module("@/worker/billing-contact-verification", () => ({
  runBillingContactVerificationJob: async () => {
    await billingContactVerificationRun?.();
  },
}));

mock.module("@/worker/gate-state-sync", () => ({
  runGateStateSyncJob: async () => {
    await gateStateSyncRun?.();
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
  retriedIndefinitely.length = 0;
  claimCalls = 0;
  claimCapabilities.length = 0;
  reviewRun = async () => undefined;
  respondRun = async () => undefined;
  respondDeliveryRun = async () => undefined;
  respondFailureCommentRun = async () => undefined;
  billingContactVerificationRun = async () => undefined;
  gateStateSyncRun = async () => undefined;
  cleanupRun = async () => undefined;
  reviewTiming = undefined;
  reviewProcessGroup = undefined;
  operationalFailures.length = 0;
  operationalWarnings.length = 0;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in OLD_ENV)) delete process.env[key];
  }
  Object.assign(process.env, OLD_ENV);
});

describe("drainQueueOnce", () => {
  test("claims only job kinds implemented by this web release", async () => {
    expect(await drainQueueOnce("capability-drain", { maxJobs: 1 })).toBe(0);
    expect(claimCapabilities).toEqual([[
      "review",
      "respond",
      "respond-delivery",
      "billing-contact-verification",
      "gate-state-sync",
      "check-run-cleanup",
      "respond-failure-comment",
    ]]);
  });

  test("dispatches durable respond delivery jobs independently", async () => {
    const job = reviewJob(1);
    job.kind = "respond-delivery";
    job.payload = { respondJobId: 7 };
    let called = false;
    respondDeliveryRun = async () => {
      called = true;
    };
    jobs.push(job);

    expect(await drainQueueOnce("test-drain", { maxJobs: 1 })).toBe(1);
    expect(called).toBe(true);
    expect(completed).toEqual([1]);
  });

  test("dispatches durable billing contact verification jobs", async () => {
    const job = reviewJob(1);
    job.kind = "billing-contact-verification";
    job.payload = { orgId: 7, tokenDigest: "a".repeat(43) };
    let called = false;
    billingContactVerificationRun = async () => {
      called = true;
    };
    jobs.push(job);

    expect(await drainQueueOnce("test-drain", { maxJobs: 1 })).toBe(1);
    expect(called).toBe(true);
    expect(completed).toEqual([1]);
  });

  test("dispatches durable gate state synchronization jobs", async () => {
    const job = reviewJob(1);
    job.kind = "gate-state-sync";
    job.payload = {
      reviewId: 7,
      reviewPublicId: "00000000-0000-4000-8000-000000000007",
    };
    let called = false;
    gateStateSyncRun = async () => {
      called = true;
    };
    jobs.push(job);

    expect(await drainQueueOnce("test-drain", { maxJobs: 1 })).toBe(1);
    expect(called).toBe(true);
    expect(completed).toEqual([1]);
  });

  test("retries gate state synchronization through transient outages", async () => {
    const job = reviewJob(1);
    job.kind = "gate-state-sync";
    job.payload = {
      reviewId: 7,
      reviewPublicId: "00000000-0000-4000-8000-000000000007",
    };
    gateStateSyncRun = async () => {
      throw new Error("GitHub PATCH timed out");
    };
    jobs.push(job);

    expect(await drainQueueOnce("test-drain", { maxJobs: 1 })).toBe(1);
    expect(retriedIndefinitely).toEqual([
      { id: 1, error: "GitHub PATCH timed out" },
    ]);
    expect(failed).toEqual([]);
    expect(operationalWarnings).toEqual(["job_retrying"]);
  });

  test("dispatches durable check-run cleanup jobs", async () => {
    const job = reviewJob(1);
    job.kind = "check-run-cleanup";
    job.payload = {
      installationId: 42,
      repoFullName: "octo/repo",
      advisoryCheckRunId: 101,
      gateCheckRunId: 102,
      message: "watchdog: deadline exceeded",
    };
    let called = false;
    cleanupRun = async () => {
      called = true;
    };
    jobs.push(job);

    expect(await drainQueueOnce("test-drain", { maxJobs: 1 })).toBe(1);
    expect(called).toBe(true);
    expect(completed).toEqual([1]);
  });

  test("dispatches durable respond failure comment jobs", async () => {
    const job = reviewJob(1);
    job.kind = "respond-failure-comment";
    job.payload = {
      installationId: 42,
      repoFullName: "octo/repo",
      number: 7,
      isPr: true,
      comment: "@postil please look",
    };
    let called = false;
    respondFailureCommentRun = async () => {
      called = true;
    };
    jobs.push(job);

    expect(await drainQueueOnce("test-drain", { maxJobs: 1 })).toBe(1);
    expect(called).toBe(true);
    expect(completed).toEqual([1]);
  });

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
    expect(reviewProcessGroup).toBe("web");
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
    expect(operationalFailures).toEqual(["job_permanently_failed"]);
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
