import { accessSync, constants } from "node:fs";
import { hostname } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { closeDb, getPool } from "@/lib/db";
import { optionalEnv, validateEnv } from "@/lib/env";
import {
  claimJob,
  completeJob,
  failJob,
  type RespondJobPayload,
  type ReviewJobPayload,
} from "@/lib/queue";
import { isPermanentFailure } from "./failure-classifier";
import { postRespondFailureComment, runRespondJob } from "./respond";
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
    case "respond":
      await runRespondJob(payload as RespondJobPayload);
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
      // Deterministic, non-retryable errors (broken CA store, missing CLI
      // binary, build/loader defect, malformed payload, unsupported forge)
      // fail straight to `failed`: a retry against the same image would fail
      // identically and just burn the attempt budget. Everything else (5xx,
      // 429, timeouts, network/socket) follows the normal backoff retry.
      const permanent = isPermanentFailure(message);
      const outcome = await failJob(pool, job, message, { permanent });
      console.error(
        `[worker ${slot}] job ${job.id} ${outcome}${permanent ? " (permanent)" : ""}: ${message}`,
      );
      // Only the call that performed the permanent transition ("failed", not a
      // backoff retry or a watchdog-lost race) posts the one user-facing reply.
      if (outcome === "failed" && job.kind === "respond") {
        await postRespondFailureComment(job.payload as RespondJobPayload);
      }
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
  validatePostilBin();
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
