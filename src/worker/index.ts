import { hostname } from "node:os";

import { closeDb, getPool } from "@/lib/db";
import { validateEnv } from "@/lib/env";
import { claimJob, completeJob, failJob, type ReviewJobPayload } from "@/lib/queue";
import { runReviewJob } from "./review";
import { watchdogPass } from "./watchdog";

/**
 * Postil worker: long-running Bun process draining the Postgres job queue.
 *
 * - N concurrent claim loops (default 4), each claiming one job at a time
 *   with FOR UPDATE SKIP LOCKED.
 * - Exponential backoff on retry, permanent failure after maxAttempts.
 * - Watchdog pass every 60s: kills reviews running past the deadline and
 *   completes their check-runs as failed; requeues jobs whose worker died.
 */

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);
const POLL_INTERVAL_MS = 1000;
const WATCHDOG_INTERVAL_MS = 60_000;

const workerId = `${hostname()}-${process.pid}`;
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleJob(kind: string, payload: Record<string, unknown>): Promise<void> {
  switch (kind) {
    case "review":
      await runReviewJob(payload as ReviewJobPayload);
      break;
    default:
      throw new Error(`unknown job kind: ${kind}`);
  }
}

async function claimLoop(slot: number): Promise<void> {
  const pool = getPool();
  while (!shuttingDown) {
    let job;
    try {
      job = await claimJob(pool, `${workerId}#${slot}`);
    } catch (err) {
      console.error(`[worker ${slot}] claim error: ${err}`);
      await sleep(POLL_INTERVAL_MS * 5);
      continue;
    }
    if (!job) {
      // Jittered poll to avoid thundering herd across slots.
      await sleep(POLL_INTERVAL_MS + Math.random() * 500);
      continue;
    }
    const started = Date.now();
    console.log(`[worker ${slot}] job ${job.id} (${job.kind}) attempt ${job.attempts}`);
    try {
      await handleJob(job.kind, job.payload);
      await completeJob(pool, job.id);
      console.log(`[worker ${slot}] job ${job.id} done in ${Date.now() - started}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const outcome = await failJob(pool, job, message);
      console.error(`[worker ${slot}] job ${job.id} ${outcome}: ${message}`);
    }
  }
}

async function watchdogLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const { killed } = await watchdogPass();
      if (killed > 0) console.warn(`[watchdog] killed ${killed} stuck review(s)`);
    } catch (err) {
      console.error(`[watchdog] pass failed: ${err}`);
    }
    await sleep(WATCHDOG_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  validateEnv("worker");
  // Fail fast if the database is unreachable.
  await getPool().query("SELECT 1");
  console.log(`postil worker ${workerId} started (concurrency ${CONCURRENCY})`);

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, draining...`);
    shuttingDown = true;
    // Give in-flight jobs a moment, then close.
    setTimeout(async () => {
      await closeDb().catch(() => undefined);
      process.exit(0);
    }, 5000);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const loops = Array.from({ length: CONCURRENCY }, (_, i) => claimLoop(i));
  loops.push(watchdogLoop());
  await Promise.all(loops);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
