import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { ClaimedJob } from "@/lib/queue";
import { WorkerInterruptionRehearsalError } from "@/lib/private-worker-rehearsal";
import "./quiet-console";

const OLD_ENV = { ...process.env };

const jobs: ClaimedJob[] = [];
const completed: number[] = [];
const failed: Array<{ id: number; error: string }> = [];
const failureFollowups: Array<Record<string, unknown>> = [];
const permanentFailures: number[] = [];
const retriedIndefinitely: Array<{ id: number; error: string }> = [];
const shutdownRequeues: number[] = [];
let claimCalls = 0;
const claimCapabilities: string[][] = [];
const claimOptions: Array<Record<string, unknown> | undefined> = [];
let reviewRun: (() => Promise<void>) | undefined;
let respondRun: (() => Promise<void>) | undefined;
let respondDeliveryRun: (() => Promise<void>) | undefined;
let respondFailureCommentRun: (() => Promise<void>) | undefined;
let webhookCommentRun: (() => Promise<void>) | undefined;
let githubReactionRun: (() => Promise<void>) | undefined;
let billingContactVerificationRun: (() => Promise<void>) | undefined;
let billingSettlementRun: (() => Promise<void>) | undefined;
let operatorAlertRun: (() => Promise<void>) | undefined;
let customerNotificationEmailRun: (() => Promise<void>) | undefined;
const customerNotificationEmailFailures: Array<{
  payload: Record<string, unknown>;
  terminal: boolean;
}> = [];
let gateStateSyncRun: (() => Promise<void>) | undefined;
let cleanupRun: (() => Promise<void>) | undefined;
let webhookDeliveryLoadError: Error | undefined;
let reviewTiming:
  | { queuedAt: Date; startedAt: Date; lease: ClaimedJob }
  | undefined;
let reviewProcessGroup: string | undefined;
let reviewSignal: AbortSignal | undefined;
let reviewPublicationStartedCallback: (() => void) | undefined;
const operationalFailures: string[] = [];
const operationalWarnings: string[] = [];

class MockWorkerShutdownError extends Error {}
class MockReviewPublicationReconciliationError extends Error {}
class MockReviewInputConvergenceError extends Error {}
class MockPermanentJobError extends Error {
  permanent = true;
}
class MockWebhookDeliveryStateError extends Error {}

mock.module("@/lib/server-observability", () => ({
  reportOperationalFailure: (_processGroup: string, failureClass: string) => {
    operationalFailures.push(failureClass);
  },
  reportOperationalWarning: (_processGroup: string, warning: string) => {
    operationalWarnings.push(warning);
  },
}));

mock.module("@/lib/db", () => ({
  getDb: () => ({}),
  getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  schema: {},
}));

mock.module("@/lib/operator-alerts", () => ({
  ensureOperatorAlertDelivery: async () => undefined,
  normalizeLegacyOperatorAlertPayload: (payload: Record<string, unknown>) =>
    typeof payload.eventKey === "string" ? payload : null,
  recordOperatorAlertDelivered: async () => undefined,
  recordOperatorAlertFailure: async () => undefined,
}));

mock.module("@/lib/paddle-billing", () => ({
  runBillingSettlement: async () => {
    await billingSettlementRun?.();
  },
}));

mock.module("@/lib/customer-notification-email", () => ({
  runCustomerNotificationEmailJob: async () => {
    await customerNotificationEmailRun?.();
  },
  recordCustomerNotificationEmailFailure: async (
    _db: unknown,
    payload: Record<string, unknown>,
    _error: string,
    terminal: boolean,
  ) => {
    customerNotificationEmailFailures.push({ payload, terminal });
  },
}));

mock.module("@/lib/queue", () => ({
  WebhookDeliveryStateError: MockWebhookDeliveryStateError,
  isPermanentJobError: (error: unknown) =>
    error instanceof MockPermanentJobError,
  claimJob: async (
    _pool: unknown,
    _workerId: string,
    allowedKinds: readonly string[],
    options?: Record<string, unknown>,
  ) => {
    claimCalls += 1;
    claimCapabilities.push([...allowedKinds]);
    claimOptions.push(options);
    return jobs.shift();
  },
  completeJob: async (_pool: unknown, job: ClaimedJob) => {
    completed.push(job.id);
  },
  continueClaimedJob: async () => undefined,
  completeWebhookDelivery: async () => undefined,
  loadWebhookDelivery: async () => {
    if (webhookDeliveryLoadError) throw webhookDeliveryLoadError;
    return null;
  },
  failJob: async (
    _pool: unknown,
    job: ClaimedJob,
    error: string,
    options?: {
      permanent?: boolean;
      failureFollowup?: { payload: Record<string, unknown> };
    },
  ) => {
    failed.push({ id: job.id, error });
    if (options?.permanent) permanentFailures.push(job.id);
    if (options?.failureFollowup) {
      failureFollowups.push(options.failureFollowup.payload);
    }
    return "failed";
  },
  retryJobIndefinitely: async (
    _pool: unknown,
    job: ClaimedJob,
    error: string,
  ) => {
    retriedIndefinitely.push({ id: job.id, error });
    return "retried";
  },
  requeueClaimedJobs: async (
    _pool: unknown,
    _reason: string,
    _kinds: readonly string[],
    leases: readonly ClaimedJob[],
  ) => {
    shutdownRequeues.push(...leases.map((lease) => lease.id));
    return leases.length;
  },
}));

mock.module("@/worker/watchdog", () => ({
  watchdogPass: async () => undefined,
}));

mock.module("@/worker/review", () => ({
  ReviewInputConvergenceError: MockReviewInputConvergenceError,
  ReviewPublicationReconciliationError:
    MockReviewPublicationReconciliationError,
  WorkerShutdownError: MockWorkerShutdownError,
  validateCheckRunCleanupPayload: (payload: Record<string, unknown>) => {
    if (payload.malformed === true) {
      throw new MockPermanentJobError(
        "check-run cleanup job payload is malformed",
      );
    }
  },
  runCheckRunCleanupJob: async () => {
    await cleanupRun?.();
  },
  runReviewJob: async (
    _payload: unknown,
    timing: { queuedAt: Date; startedAt: Date; lease: ClaimedJob },
    processGroup: string,
    signal?: AbortSignal,
    onPublicationStarted?: () => void,
  ) => {
    reviewTiming = timing;
    reviewProcessGroup = processGroup;
    reviewSignal = signal;
    reviewPublicationStartedCallback = onPublicationStarted;
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
  runWebhookCommentJob: async () => {
    await webhookCommentRun?.();
  },
}));

mock.module("@/worker/github-reaction", () => ({
  runGithubReactionJob: async (payload: Record<string, unknown>) => {
    if (payload.malformed === true) {
      throw new Error("github reaction job payload is malformed");
    }
    await githubReactionRun?.();
  },
}));

mock.module("@/worker/billing-contact-verification", () => ({
  runBillingContactVerificationJob: async () => {
    await billingContactVerificationRun?.();
  },
}));

mock.module("@/worker/operator-alert", () => ({
  validateOperatorAlertPayload: () => undefined,
  runOperatorAlertJob: async () => {
    await operatorAlertRun?.();
    return { messageId: "operator-alert-message" };
  },
}));

mock.module("@/worker/gate-state-sync", () => ({
  runGateStateSyncJob: async () => {
    await gateStateSyncRun?.();
  },
}));

mock.module("@/worker/gate-enforcement-sweep", () => ({
  runGateEnforcementSweepJob: async () => null,
}));

const {
  ActiveClaimExecutionRegistry,
  drainQueueOnce,
  runClaimedJob,
  triggerQueueDrain,
} = await import("@/worker/runner");

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
    lockGeneration: 1n,
    lockedBy: "test",
  };
}

beforeEach(() => {
  Object.assign(process.env, OLD_ENV);
  jobs.length = 0;
  completed.length = 0;
  failed.length = 0;
  failureFollowups.length = 0;
  permanentFailures.length = 0;
  retriedIndefinitely.length = 0;
  shutdownRequeues.length = 0;
  claimCalls = 0;
  claimCapabilities.length = 0;
  claimOptions.length = 0;
  reviewRun = async () => undefined;
  respondRun = async () => undefined;
  respondDeliveryRun = async () => undefined;
  respondFailureCommentRun = async () => undefined;
  webhookCommentRun = async () => undefined;
  githubReactionRun = async () => undefined;
  billingContactVerificationRun = async () => undefined;
  billingSettlementRun = async () => undefined;
  operatorAlertRun = async () => undefined;
  customerNotificationEmailRun = async () => undefined;
  customerNotificationEmailFailures.length = 0;
  gateStateSyncRun = async () => undefined;
  cleanupRun = async () => undefined;
  webhookDeliveryLoadError = undefined;
  reviewTiming = undefined;
  reviewProcessGroup = undefined;
  reviewSignal = undefined;
  reviewPublicationStartedCallback = undefined;
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
  test("old generation completion cannot erase newer generation tracking", () => {
    const executions = new ActiveClaimExecutionRegistry();
    const oldJob = reviewJob(91);
    const currentJob = {
      ...oldJob,
      lockGeneration: oldJob.lockGeneration + 1n,
    };
    const oldController = new AbortController();
    const currentController = new AbortController();
    const oldExecution = executions.add(oldJob, oldController);
    const currentExecution = executions.add(currentJob, currentController);

    expect(executions.values().map((execution) => execution.job.lockGeneration))
      .toEqual([1n, 2n]);
    expect(executions.delete(oldExecution)).toBe(true);
    expect(executions.values()).toEqual([currentExecution]);
    expect(executions.delete(oldExecution)).toBe(false);

    const shutdownExecutions = executions.values();
    for (const execution of shutdownExecutions) execution.controller.abort();
    const shutdownReviewLeases = shutdownExecutions
      .filter((execution) => execution.job.kind === "review")
      .map((execution) => execution.job);
    expect(oldController.signal.aborted).toBe(false);
    expect(currentController.signal.aborted).toBe(true);
    expect(shutdownReviewLeases).toEqual([currentJob]);
  });

  test("forwards worker cancellation to review execution", async () => {
    const controller = new AbortController();
    const onPublicationStarted = () => undefined;
    await runClaimedJob(
      reviewJob(1),
      "worker 0",
      "worker",
      controller.signal,
      onPublicationStarted,
    );

    expect(reviewSignal).toBe(controller.signal);
    expect(reviewPublicationStartedCallback).toBe(onPublicationStarted);
  });

  test("requeues an interrupted review without consuming an attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    reviewRun = async () => {
      throw new MockWorkerShutdownError(
        "review interrupted by worker shutdown",
      );
    };

    await runClaimedJob(reviewJob(7), "worker 0", "worker", controller.signal);

    expect(shutdownRequeues).toEqual([7]);
    expect(failed).toEqual([]);
    expect(completed).toEqual([]);
    expect(operationalWarnings).toEqual([]);
  });

  test("leaves a rehearsal recovery job claimed while the worker exits", async () => {
    reviewRun = async () => {
      throw new WorkerInterruptionRehearsalError(
        "20000000-0000-4000-8000-000000000012",
      );
    };

    await expect(runClaimedJob(reviewJob(17), "worker 0", "worker"))
      .rejects.toBeInstanceOf(WorkerInterruptionRehearsalError);
    expect(shutdownRequeues).toEqual([]);
    expect(retriedIndefinitely).toEqual([]);
    expect(failed).toEqual([]);
    expect(completed).toEqual([]);
  });

  test("retries staged publication reconciliation without exhausting attempts", async () => {
    reviewRun = async () => {
      throw new MockReviewPublicationReconciliationError(
        "exact terminal checks are not observable yet",
      );
    };

    await runClaimedJob(reviewJob(9), "worker 0", "worker");

    expect(retriedIndefinitely).toEqual([
      { id: 9, error: "exact terminal checks are not observable yet" },
    ]);
    expect(failed).toEqual([]);
    expect(completed).toEqual([]);
  });

  test("retries GitHub input convergence without consuming ordinary attempts", async () => {
    reviewRun = async () => {
      throw new MockReviewInputConvergenceError(
        "GitHub pull request snapshot has not converged",
      );
    };

    await runClaimedJob(reviewJob(19), "worker 0", "worker");

    expect(retriedIndefinitely).toEqual([
      { id: 19, error: "GitHub pull request snapshot has not converged" },
    ]);
    expect(failed).toEqual([]);
    expect(completed).toEqual([]);
  });

  test("does not mask an ordinary failure that races with shutdown", async () => {
    const controller = new AbortController();
    controller.abort();
    reviewRun = async () => {
      throw new Error("provider rejected the request");
    };

    await runClaimedJob(reviewJob(8), "worker 0", "worker", controller.signal);

    expect(shutdownRequeues).toEqual([]);
    expect(failed).toEqual([{ id: 8, error: "provider rejected the request" }]);
    expect(completed).toEqual([]);
  });

  test("fails deterministic review startup errors without retrying", async () => {
    reviewRun = async () => {
      throw new MockPermanentJobError(
        "review job cannot start: repository octo/repo is disabled",
      );
    };

    await runClaimedJob(reviewJob(8), "worker 0", "worker");

    expect(failed).toEqual([
      {
        id: 8,
        error: "review job cannot start: repository octo/repo is disabled",
      },
    ]);
    expect(permanentFailures).toEqual([8]);
    expect(completed).toEqual([]);
    expect(operationalFailures).toEqual(["job_permanently_failed"]);
  });

  test("worker shutdown drains, interrupts, and requeues only owned claims", () => {
    const worker = readFileSync("src/worker/index.ts", "utf8");
    const fly = readFileSync("fly.toml", "utf8");
    const shutdown = worker.slice(
      worker.indexOf("async function shutdown"),
      worker.indexOf("function jitter"),
    );
    const webhookRedeliveryLoop = worker.slice(
      worker.indexOf("async function webhookRedeliveryLoop"),
      worker.indexOf("function validatePostilBin"),
    );

    expect(worker).toContain(
      'readPositiveIntEnv("WORKER_SHUTDOWN_DRAIN_MS", 10_000)',
    );
    expect(worker).toContain(
      'readPositiveIntEnv("WORKER_SHUTDOWN_SETTLE_MS", 15_000)',
    );
    expect(worker).toContain("activeClaimExecutions.add(job, controller)");
    expect(worker).toContain("activeClaimExecutions.delete(execution)");
    expect(worker).not.toContain("new Map<number, AbortController>()");
    expect(worker).not.toContain("new Map<number, JobLease>()");
    expect(worker).toContain("if (shuttingDown && job)");
    expect(worker).toContain("[job]");
    expect(shutdown).toContain("controller.abort()");
    expect(shutdown).toContain("await waitForWorkerIdle(SHUTDOWN_SETTLE_MS)");
    expect(shutdown).toContain(
      "const activeReviewLeases = activeClaimExecutions",
    );
    expect(shutdown).toContain("execution.controller.abort()");
    expect(shutdown).toContain('execution.job.kind === "review"');
    expect(shutdown).toContain(".map((execution) => execution.job)");
    expect(shutdown).toContain("await requeueClaimedJobs(");
    expect(shutdown).toContain('["review"]');
    expect(shutdown.indexOf("controller.abort()")).toBeLessThan(
      shutdown.indexOf("await waitForWorkerIdle(SHUTDOWN_SETTLE_MS)"),
    );
    expect(
      shutdown.indexOf("await waitForWorkerIdle(SHUTDOWN_SETTLE_MS)"),
    ).toBeLessThan(shutdown.indexOf("await requeueClaimedJobs("));
    expect(webhookRedeliveryLoop).toContain(
      "if (!shuttingDown) {\n      await sleepUntilWebhookRedelivery",
    );
    expect(fly).toContain('kill_signal = "SIGTERM"');
    expect(fly).toContain('kill_timeout = "120s"');
  });

  test("hosted process launcher drops privileges and forwards termination", () => {
    const fly = readFileSync("fly.toml", "utf8");
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const compose = readFileSync("docker-compose.yml", "utf8");
    const launcher = readFileSync("scripts/start-managed-process.ts", "utf8");
    const web = readFileSync("scripts/start-web.ts", "utf8");
    const webhook = readFileSync("src/lib/github/webhook-handler.ts", "utf8");

    expect(fly).toContain('web = "bun scripts/start-managed-process.ts web"');
    expect(fly).toContain('worker = "bun scripts/start-managed-process.ts worker"');
    expect(fly).toContain('monitor = "bun scripts/start-managed-process.ts monitor"');
    expect(dockerfile).toContain(
      'CMD ["bun", "scripts/start-managed-process.ts", "web"]',
    );
    expect(dockerfile).not.toContain("USER bun");
    expect(dockerfile).toContain("RUN chown bun:bun /app");
    expect(dockerfile).toContain("POSTIL_CACHE_DIR=/tmp/postil");
    expect(compose).toContain(
      'command: ["bun", "scripts/start-managed-process.ts", "worker"]',
    );
    expect(compose).toContain(
      'command: ["bun", "scripts/start-managed-process.ts", "monitor"]',
    );
    expect(launcher).toContain("process.setgid(targetGid)");
    expect(launcher).toContain("process.setuid(targetUid)");
    expect(launcher).toContain("process.setgroups([targetGid])");
    expect(launcher).toContain("actualUid !== targetUid");
    expect(launcher).toContain("actualGid !== targetGid");
    expect(launcher).toContain("supplementaryGroups.includes(0)");
    expect(launcher).toContain(
      "supplementaryGroups.some((group) => group !== targetGid)",
    );
    expect(launcher.indexOf("process.setgroups([targetGid])")).toBeLessThan(
      launcher.indexOf("process.setgid(targetGid)"),
    );
    expect(launcher.indexOf("process.setgid(targetGid)")).toBeLessThan(
      launcher.indexOf("process.setuid(targetUid)"),
    );
    expect(launcher).toContain('child.kill("SIGINT")');
    expect(launcher).toContain('child.kill("SIGTERM")');
    expect(launcher).toContain("const exitCode = await child.exited");
    expect(web).toContain("await startServer({");
    expect(web).toContain('process.env.POSTIL_BIND_HOST?.trim() || "0.0.0.0"');
    expect(web).not.toContain("process.env.HOSTNAME");
    expect(webhook).toContain("after(async () => {");
    expect(webhook).toContain("await drainWebhookDispatch(deliveryId");
  });

  test("claims only job kinds implemented by this web release", async () => {
    expect(await drainQueueOnce("capability-drain", { maxJobs: 1 })).toBe(0);
    expect(claimCapabilities).toEqual([
      [
        "webhook-dispatch",
        "review",
        "respond",
        "respond-delivery",
        "billing-contact-verification",
        "billing-settlement",
        "operator-alert",
        "customer-notification-email",
        "gate-state-sync",
        "check-run-cleanup",
        "respond-failure-comment",
        "webhook-comment",
        "github-reaction",
      ],
    ]);
    expect(claimOptions).toEqual([{ excludePrivateWorkerRehearsals: true }]);
  });

  test("dispatches fixed webhook comments through a durable job", async () => {
    const job = reviewJob(2);
    job.kind = "webhook-comment";
    job.payload = {
      installationId: 42,
      repoFullName: "octo/repo",
      number: 7,
      body: "Review commands only work on pull requests.",
      sourceDeliveryId: "delivery-2",
    };
    let called = false;
    webhookCommentRun = async () => {
      called = true;
    };
    jobs.push(job);

    expect(await drainQueueOnce("test-drain", { maxJobs: 1 })).toBe(1);
    expect(called).toBe(true);
    expect(completed).toEqual([2]);
  });

  test("dispatches GitHub reaction acknowledgements through a durable job", async () => {
    const job = reviewJob(12);
    job.kind = "github-reaction";
    job.payload = { sourceDeliveryId: "reaction-delivery" };
    let called = false;
    githubReactionRun = async () => {
      called = true;
    };
    jobs.push(job);

    expect(await drainQueueOnce("reaction-drain", { maxJobs: 1 })).toBe(1);
    expect(called).toBe(true);
    expect(completed).toContain(12);
  });

  test("retries transient GitHub reaction failures indefinitely", async () => {
    const job = reviewJob(13);
    job.kind = "github-reaction";
    job.payload = { sourceDeliveryId: "reaction-delivery" };
    githubReactionRun = async () => {
      throw new Error("GitHub POST failed: HTTP 503 unavailable");
    };

    await runClaimedJob(job, "reaction-retry", "worker");
    expect(retriedIndefinitely).toEqual([
      { id: 13, error: "GitHub POST failed: HTTP 503 unavailable" },
    ]);
    expect(permanentFailures).toEqual([]);
  });

  test("fails malformed GitHub reaction jobs permanently", async () => {
    const job = reviewJob(14);
    job.kind = "github-reaction";
    job.payload = { malformed: true };

    await runClaimedJob(job, "reaction-malformed", "worker");
    expect(permanentFailures).toContain(14);
    expect(retriedIndefinitely).toEqual([]);
  });

  test("retries durable webhook dispatch until the delivery completes", async () => {
    const job = reviewJob(9);
    job.kind = "webhook-dispatch";
    job.payload = { deliveryId: "delivery-9" };
    job.attempts = job.maxAttempts;
    webhookDeliveryLoadError = new Error("database temporarily unavailable");

    await runClaimedJob(job, "worker 0", "worker");

    expect(retriedIndefinitely).toEqual([
      { id: 9, error: "database temporarily unavailable" },
    ]);
    expect(failed).toEqual([]);
    expect(operationalWarnings).toEqual(["job_retrying"]);
  });

  test("fails an orphaned webhook dispatch instead of retrying forever", async () => {
    const job = reviewJob(10);
    job.kind = "webhook-dispatch";
    job.payload = { deliveryId: "delivery-10" };
    webhookDeliveryLoadError = new MockWebhookDeliveryStateError(
      "webhook delivery delivery-10 is missing",
    );

    await runClaimedJob(job, "worker 0", "worker");

    expect(failed).toEqual([
      { id: 10, error: "webhook delivery delivery-10 is missing" },
    ]);
    expect(retriedIndefinitely).toEqual([]);
    expect(operationalFailures).toEqual(["job_permanently_failed"]);
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

  test("queues a respond failure comment in the terminal job transition", async () => {
    const job = reviewJob(12);
    job.kind = "respond";
    job.attempts = job.maxAttempts;
    job.payload = {
      installationId: 42,
      repoFullName: "octo/repo",
      number: 7,
      isPr: true,
      comment: "@postil explain",
    };
    respondRun = async () => {
      throw new Error("provider request failed");
    };

    await runClaimedJob(job, "worker 0", "worker");

    expect(failed).toEqual([{ id: 12, error: "provider request failed" }]);
    expect(failureFollowups).toEqual([{ ...job.payload, respondJobId: 12 }]);
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

  test("dispatches durable operator alert jobs", async () => {
    const job = reviewJob(1);
    job.kind = "operator-alert";
    job.payload = {
      event: "trial_started",
      eventKey: "trial-started:7",
      orgId: 7,
    };
    let called = false;
    operatorAlertRun = async () => {
      called = true;
    };
    jobs.push(job);

    expect(await drainQueueOnce("test-drain", { maxJobs: 1 })).toBe(1);
    expect(called).toBe(true);
    expect(completed).toEqual([1]);
  });

  test("dispatches durable customer notification email jobs", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.BREVO_API_KEY = "test-api-key";
    const job = reviewJob(1);
    job.kind = "customer-notification-email";
    job.payload = { deliveryId: "00000000-0000-4000-8000-000000000001" };
    let called = false;
    customerNotificationEmailRun = async () => {
      called = true;
    };
    jobs.push(job);

    expect(await drainQueueOnce("test-drain", { maxJobs: 1 })).toBe(1);
    expect(called).toBe(true);
    expect(completed).toEqual([1]);
  });

  test("records terminal customer notification email delivery failure", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.BREVO_API_KEY = "test-api-key";
    const job = reviewJob(2);
    job.kind = "customer-notification-email";
    job.attempts = job.maxAttempts;
    job.payload = { deliveryId: "00000000-0000-4000-8000-000000000002" };
    customerNotificationEmailRun = async () => {
      throw new Error("customer email transport failed");
    };

    await runClaimedJob(job, "worker 0", "worker");

    expect(failed).toEqual([
      { id: 2, error: "customer email transport failed" },
    ]);
    expect(customerNotificationEmailFailures).toEqual([
      { payload: job.payload, terminal: true },
    ]);
  });

  test("records missing customer email configuration without escaping the worker loop", async () => {
    delete process.env.POSTIL_PUBLIC_URL;
    delete process.env.BREVO_API_KEY;
    const job = reviewJob(3);
    job.kind = "customer-notification-email";
    job.attempts = job.maxAttempts;
    job.payload = { deliveryId: "00000000-0000-4000-8000-000000000003" };
    jobs.push(job);

    expect(await drainQueueOnce("test-drain", { maxJobs: 1 })).toBe(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.id).toBe(3);
    expect(failed[0]?.error).toContain(
      "Missing required environment variable POSTIL_PUBLIC_URL",
    );
    expect(customerNotificationEmailFailures).toEqual([
      { payload: job.payload, terminal: true },
    ]);
  });

  test("dispatches durable billing settlement jobs", async () => {
    const job = reviewJob(1);
    job.kind = "billing-settlement";
    job.payload = { settlementId: "00000000-0000-4000-8000-000000000001" };
    let called = false;
    billingSettlementRun = async () => {
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

  test("fails terminal check reconciliation when its retry budget is exhausted", async () => {
    const job = reviewJob(2);
    job.kind = "check-run-cleanup";
    job.attempts = job.maxAttempts;
    job.payload = {
      installationId: 42,
      repoFullName: "octo/repo",
      advisoryCheckRunId: 101,
      gateCheckRunId: 102,
      message: "GitHub 503",
    };
    cleanupRun = async () => {
      throw new Error(
        "check-run cleanup remains incomplete: ambiguous gate check-run postil:run:gate is not visible on GitHub",
      );
    };

    await runClaimedJob(job, "worker 0", "worker");

    expect(retriedIndefinitely).toEqual([]);
    expect(failed).toEqual([
      {
        id: 2,
        error:
          "check-run cleanup remains incomplete: ambiguous gate check-run postil:run:gate is not visible on GitHub",
      },
    ]);
    expect(operationalFailures).toEqual(["job_permanently_failed"]);
  });

  test("rejects malformed terminal cleanup instead of retrying forever", async () => {
    const job = reviewJob(3);
    job.kind = "check-run-cleanup";
    job.payload = { malformed: true };

    await runClaimedJob(job, "worker 0", "worker");

    expect(permanentFailures).toEqual([3]);
    expect(retriedIndefinitely).toEqual([]);
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

    const drained = await drainQueueOnce("test-drain", {
      maxJobs: 1,
      deadlineMs: 60_000,
    });

    expect(drained).toBe(1);
    expect(completed).toEqual([1]);
    expect(jobs.map((job) => job.id)).toEqual([2]);
    expect(reviewTiming).toEqual({
      queuedAt: new Date("2026-07-10T12:00:00.000Z"),
      startedAt: new Date("2026-07-10T12:00:05.000Z"),
      lease: expect.objectContaining({ id: 1, lockedBy: "test" }),
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
      const drained = await drainQueueOnce("deadline-drain", {
        maxJobs: 2,
        deadlineMs: 1_000,
      });
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

  test("coalesces triggers during one drain into one bounded follow-up", async () => {
    process.env.POSTIL_WEBHOOK_DRAIN_ENABLED = "1";
    jobs.push(reviewJob(1), reviewJob(2));
    const releases: Array<() => void> = [];
    reviewRun = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });

    triggerQueueDrain("enabled");
    triggerQueueDrain("enabled");
    triggerQueueDrain("enabled");
    await waitFor(() => claimCalls === 1 && releases.length === 1);

    expect(claimCalls).toBe(1);
    releases.shift()!();
    await waitFor(() => claimCalls === 2 && releases.length === 1);
    expect(completed).toEqual([1]);

    releases.shift()!();
    await waitFor(() => completed.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(claimCalls).toBe(2);
    expect(completed).toEqual([1, 2]);
  });

  test("starts a new drain for a trigger after the prior drain settles", async () => {
    process.env.POSTIL_WEBHOOK_DRAIN_ENABLED = "1";
    jobs.push(reviewJob(1));

    triggerQueueDrain("first");
    await waitFor(() => completed.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    jobs.push(reviewJob(2));
    triggerQueueDrain("after-settlement");
    await waitFor(() => completed.length === 2);

    expect(completed).toEqual([1, 2]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
