import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { hostname } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { closeDb, getDb, getPool } from "@/lib/db";
import {
  configuredWorkerHeartbeatIntervalMs,
  optionalEnv,
  validateEnv,
} from "@/lib/env";
import { runWebhookRedeliveryPass } from "@/lib/github/webhook-redelivery";
import {
  claimNextJob,
  type ClaimOutcome,
  enqueueGateEnforcementSweepOnce,
  nextClaimPollDelay,
  pruneCompletedWebhookDeliveries,
  requeueJobsOwnedBy,
  WEBHOOK_DELIVERY_RETENTION_BATCH_SIZE,
} from "@/lib/queue";
import { redactSecrets } from "@/lib/redact";
import { recoverRespondDeliveryJobs } from "@/lib/respond-delivery";
import { recordServiceHeartbeat } from "@/lib/private-monitoring";
import {
  configuredPrivateWorkerRehearsalSandbox,
  WorkerInterruptionRehearsalError,
} from "@/lib/private-worker-rehearsal";
import {
  reportOperationalFailure,
  reportOperationalState,
  reportOperationalWarning,
  shutdownServerObservability,
} from "@/lib/server-observability";
import { PROCESSABLE_JOB_KINDS, readPositiveIntEnv, runClaimedJob } from "./runner";
import { tlsSelfTest } from "./tls-selftest";
import { watchdogPass } from "./watchdog";

/**
 * Postil worker: long-running Bun process draining the Postgres job queue.
 *
 * - N concurrent claim loops (default 4), each claiming one job at a time
 *   with FOR UPDATE SKIP LOCKED.
 * - Exponential backoff on retry, permanent failure after maxAttempts.
 * - Watchdog pass every 60s: kills reviews running past the deadline,
 *   durably queues failed check-run completion, and requeues jobs whose
 *   worker died.
 */

const CONCURRENCY = readPositiveIntEnv("WORKER_CONCURRENCY", 4);
const POLL_INTERVAL_MS = readPositiveIntEnv("WORKER_POLL_INTERVAL_MS", 1_000);
const IDLE_POLL_MAX_MS = Math.max(
  POLL_INTERVAL_MS,
  readPositiveIntEnv("WORKER_IDLE_POLL_MAX_MS", POLL_INTERVAL_MS),
);
const WATCHDOG_INTERVAL_MS = readPositiveIntEnv("WORKER_WATCHDOG_INTERVAL_MS", 60_000);
const HEARTBEAT_INTERVAL_MS = configuredWorkerHeartbeatIntervalMs();
const GATE_ENFORCEMENT_SWEEP_INTERVAL_MS = readPositiveIntEnv(
  "POSTIL_GATE_ENFORCEMENT_SWEEP_INTERVAL_MS",
  6 * 60 * 60 * 1000,
);
const WEBHOOK_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const WEBHOOK_RETENTION_MAX_BATCHES = 10;
const WEBHOOK_REDELIVERY_INTERVAL_MS = readPositiveIntEnv(
  "WORKER_WEBHOOK_REDELIVERY_INTERVAL_MS",
  15 * 60 * 1_000,
);
const SHUTDOWN_DRAIN_MS = readPositiveIntEnv("WORKER_SHUTDOWN_DRAIN_MS", 10_000);
const SHUTDOWN_SETTLE_MS = readPositiveIntEnv("WORKER_SHUTDOWN_SETTLE_MS", 15_000);

const workerId = `${hostname()}-${process.pid}-${randomUUID()}`;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;
let wakeWebhookRetention: (() => void) | undefined;
let wakeWebhookRedelivery: (() => void) | undefined;
let wakeHeartbeat: (() => void) | undefined;
let activeWebhookRedeliveryController: AbortController | undefined;
const activeRuns = new Set<Promise<unknown>>();
const activeControllers = new Map<number, AbortController>();
const requeueableReviewIds = new Set<number>();
let pendingClaims = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepUntilWebhookRetention(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (wakeWebhookRetention === finish) wakeWebhookRetention = undefined;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakeWebhookRetention = finish;
  });
}

function sleepUntilWebhookRedelivery(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (wakeWebhookRedelivery === finish) wakeWebhookRedelivery = undefined;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakeWebhookRedelivery = finish;
  });
}

function sleepUntilHeartbeat(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (wakeHeartbeat === finish) wakeHeartbeat = undefined;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakeHeartbeat = finish;
  });
}

async function claimLoop(slot: number): Promise<void> {
  let idleDelayMs = POLL_INTERVAL_MS;
  while (!shuttingDown) {
    let outcome: ClaimOutcome;
    pendingClaims += 1;
    try {
      outcome = await claimNextJob(getPool(), `${workerId}#${slot}`, PROCESSABLE_JOB_KINDS);
      if (shuttingDown && outcome.status === "claimed") {
        await requeueJobsOwnedBy(
          getPool(),
          `${workerId}#${slot}`,
          "worker stopped before starting the claim",
          [outcome.job.kind],
          [outcome.job.id],
        );
        return;
      }
    } catch (err) {
      console.error(`[worker ${slot}] claim error: ${redactSecrets(err)}`);
      if (shuttingDown) return;
      const backoff = nextClaimPollDelay("error", pollDelayState(idleDelayMs));
      await sleep(backoff.sleepMs);
      idleDelayMs = backoff.idleDelayMs;
      continue;
    } finally {
      pendingClaims -= 1;
    }
    if (outcome.status !== "claimed") {
      const backoff = nextClaimPollDelay(outcome.status, pollDelayState(idleDelayMs));
      await sleep(jitter(backoff.sleepMs));
      idleDelayMs = backoff.idleDelayMs;
      continue;
    }
    const job = outcome.job;
    idleDelayMs = POLL_INTERVAL_MS;
    const controller = new AbortController();
    if (job.kind === "review") requeueableReviewIds.add(job.id);
    // Interrupted reviews stay requeueable through publication: a fresh
    // attempt supersedes the interrupted one's check-runs, so forced
    // shutdown requeues every active review claim.
    const run = runClaimedJob(
      job,
      `worker ${slot}`,
      "worker",
      controller.signal,
    );
    activeRuns.add(run);
    activeControllers.set(job.id, controller);
    try {
      await run;
    } finally {
      activeRuns.delete(run);
      activeControllers.delete(job.id);
      requeueableReviewIds.delete(job.id);
    }
  }
}

async function waitForWorkerIdle(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (activeRuns.size > 0 || pendingClaims > 0) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return true;
}

async function shutdown(signal: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`received ${signal}, draining ${activeRuns.size} active job(s)...`);
    shuttingDown = true;
    wakeWebhookRetention?.();
    wakeWebhookRedelivery?.();
    wakeHeartbeat?.();

    const drained = await waitForWorkerIdle(SHUTDOWN_DRAIN_MS);
    if (!drained) {
      console.warn(
        `shutdown drain expired with ${activeRuns.size} active job(s); interrupting active reviews`,
      );
      for (const controller of activeControllers.values()) controller.abort();
      activeWebhookRedeliveryController?.abort();
      const settled = await waitForWorkerIdle(SHUTDOWN_SETTLE_MS);
      if (!settled) {
        const activeReviewJobIds = [...activeControllers.keys()].filter((jobId) =>
          requeueableReviewIds.has(jobId),
        );
        const requeued = await requeueJobsOwnedBy(
          getPool(),
          `${workerId}#`,
          "worker shutdown interrupted the claim",
          ["review"],
          activeReviewJobIds,
        ).catch((error) => {
          console.error(`failed to requeue shutdown claims: ${redactSecrets(error)}`);
          return 0;
        });
        console.warn(`requeued ${requeued} interrupted review job(s)`);
      }
    }

    await Promise.allSettled([closeDb(), shutdownServerObservability("worker")]);
    process.exit(0);
  })();
  return shutdownPromise;
}

function pollDelayState(idleDelayMs: number): {
  idleDelayMs: number;
  pollIntervalMs: number;
  idlePollMaxMs: number;
} {
  return {
    idleDelayMs,
    pollIntervalMs: POLL_INTERVAL_MS,
    idlePollMaxMs: IDLE_POLL_MAX_MS,
  };
}

function jitter(delayMs: number): number {
  return delayMs + Math.floor(Math.random() * Math.min(500, Math.max(1, delayMs / 4)));
}

async function watchdogLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      await enqueueGateEnforcementSweepOnce(getPool(), {
        minIntervalMs: GATE_ENFORCEMENT_SWEEP_INTERVAL_MS,
      });
      const { killed } = await watchdogPass();
      if (killed > 0) console.warn(`[watchdog] killed ${killed} stuck review(s)`);
    } catch (err) {
      console.error(`[watchdog] pass failed: ${redactSecrets(err)}`);
    }
    await sleep(WATCHDOG_INTERVAL_MS);
  }
}

async function heartbeatLoop(intervalMs: number): Promise<void> {
  while (!shuttingDown) {
    try {
      await recordServiceHeartbeat(getPool(), "worker", workerId);
    } catch (err) {
      console.error(`[heartbeat] worker heartbeat failed: ${redactSecrets(err)}`);
    }
    await sleepUntilHeartbeat(intervalMs);
  }
}

async function webhookRetentionLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      let pruned = 0;
      for (let batch = 0; batch < WEBHOOK_RETENTION_MAX_BATCHES; batch += 1) {
        const count = await pruneCompletedWebhookDeliveries(getPool());
        pruned += count;
        if (count < WEBHOOK_DELIVERY_RETENTION_BATCH_SIZE) break;
      }
      if (pruned > 0) console.log(`[retention] pruned ${pruned} completed webhook delivery id(s)`);
    } catch (err) {
      console.error(`[retention] webhook delivery prune failed: ${redactSecrets(err)}`);
    }
    await sleepUntilWebhookRetention(WEBHOOK_RETENTION_INTERVAL_MS);
  }
}

async function webhookRedeliveryLoop(): Promise<void> {
  while (!shuttingDown) {
    const controller = new AbortController();
    activeWebhookRedeliveryController = controller;
    const pass = runWebhookRedeliveryPass(getPool(), {
      owner: workerId,
      signal: controller.signal,
    });
    activeRuns.add(pass);
    try {
      const result = await pass;
      if (result.accepted > 0 || result.recovered > 0) {
        console.log(
          `[webhook recovery] accepted=${result.accepted} recovered=${result.recovered}`,
        );
      }
      if (result.retryable > 0) {
        reportOperationalWarning("worker", "webhook_recovery_retrying");
      }
      if (result.terminal > 0 || result.exhausted > 0) {
        reportOperationalFailure(
          "worker",
          "webhook_recovery_failed",
          new Error(
            `GitHub webhook recovery stopped for ${result.terminal + result.exhausted} delivery attempt(s)`,
          ),
        );
      }
    } catch (err) {
      if (!(controller.signal.aborted && shuttingDown)) {
        reportOperationalFailure("worker", "webhook_recovery_failed", err);
        console.error(`[webhook recovery] pass failed: ${redactSecrets(err)}`);
      }
    } finally {
      activeRuns.delete(pass);
      if (activeWebhookRedeliveryController === controller) {
        activeWebhookRedeliveryController = undefined;
      }
    }
    if (!shuttingDown) {
      await sleepUntilWebhookRedelivery(WEBHOOK_REDELIVERY_INTERVAL_MS);
    }
  }
}

/**
 * Fail fast if the postil CLI the worker spawns is missing or not
 * executable. Compose sets POSTIL_BIN unconditionally, so an image built
 * without vendor/postil would otherwise boot clean and fail every job.
 */
function validatePostilBin(): void {
  const bin = optionalEnv("POSTIL_BIN", "postil") as string;
  const candidates =
    isAbsolute(bin) || bin.includes("/")
      ? [bin]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, bin));
  const found = candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(
      `Postil worker cannot start: postil CLI not found or not executable at '${bin}'` +
        `${candidates.length > 1 ? " (searched PATH)" : ""}.\n` +
        `Every review/respond job spawns this binary, so booting without it would fail every job.\n` +
        `Fix: build the image with vendor/postil present, or point POSTIL_BIN at an executable postil binary.`,
    );
  }
}

async function main(): Promise<void> {
  validateEnv("worker");
  configuredPrivateWorkerRehearsalSandbox();
  validatePostilBin();
  // Fail fast if the database is unreachable.
  await getPool().query("SELECT 1");
  const recoveredDeliveries = await recoverRespondDeliveryJobs(getDb());
  console.log(`respond delivery recovery: queued=${recoveredDeliveries}`);
  // Fail fast if the image's CA trust store is broken (see tlsSelfTest).
  await tlsSelfTest();
  console.log(
    `postil worker ${workerId} started (concurrency ${CONCURRENCY}, idle poll max ${IDLE_POLL_MAX_MS}ms, watchdog ${WATCHDOG_INTERVAL_MS}ms)`,
  );
  reportOperationalState("worker", "worker_started");

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const loops = Array.from({ length: CONCURRENCY }, (_, i) => claimLoop(i));
  loops.push(watchdogLoop());
  if (HEARTBEAT_INTERVAL_MS !== null) {
    loops.push(heartbeatLoop(HEARTBEAT_INTERVAL_MS));
  }
  loops.push(webhookRetentionLoop());
  loops.push(webhookRedeliveryLoop());
  await Promise.all(loops);
}

main().catch(async (err) => {
  if (err instanceof WorkerInterruptionRehearsalError) {
    console.warn(`[rehearsal] consumed one-shot request ${err.nonce}; exiting worker`);
    process.exit(86);
  }
  // Boot failures (e.g. a malformed DATABASE_URL surfacing from getPool) can
  // embed credentials in the error; redact before it hits platform logs.
  reportOperationalFailure("worker", "worker_boot_failed", err);
  console.error(redactSecrets(err));
  await shutdownServerObservability("worker");
  process.exit(1);
});
