import { accessSync, constants } from "node:fs";
import { hostname } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { closeDb, getPool } from "@/lib/db";
import { optionalEnv, validateEnv } from "@/lib/env";
import { claimJob } from "@/lib/queue";
import { redactSecrets } from "@/lib/redact";
import { readPositiveIntEnv, runClaimedJob } from "./runner";
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

const workerId = `${hostname()}-${process.pid}`;
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimLoop(slot: number): Promise<void> {
  let idleDelayMs = POLL_INTERVAL_MS;
  while (!shuttingDown) {
    let job;
    try {
      job = await claimJob(getPool(), `${workerId}#${slot}`);
    } catch (err) {
      console.error(`[worker ${slot}] claim error: ${redactSecrets(err)}`);
      await sleep(Math.min(idleDelayMs * 2, IDLE_POLL_MAX_MS));
      idleDelayMs = Math.min(idleDelayMs * 2, IDLE_POLL_MAX_MS);
      continue;
    }
    if (!job) {
      await sleep(jitter(idleDelayMs));
      idleDelayMs = Math.min(idleDelayMs * 2, IDLE_POLL_MAX_MS);
      continue;
    }
    idleDelayMs = POLL_INTERVAL_MS;
    await runClaimedJob(job, `worker ${slot}`);
  }
}

function jitter(delayMs: number): number {
  return delayMs + Math.floor(Math.random() * Math.min(500, Math.max(1, delayMs / 4)));
}

async function watchdogLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const { killed } = await watchdogPass();
      if (killed > 0) console.warn(`[watchdog] killed ${killed} stuck review(s)`);
    } catch (err) {
      console.error(`[watchdog] pass failed: ${redactSecrets(err)}`);
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
  // Fail fast if the image's CA trust store is broken (see tlsSelfTest).
  await tlsSelfTest();
  console.log(
    `postil worker ${workerId} started (concurrency ${CONCURRENCY}, idle poll max ${IDLE_POLL_MAX_MS}ms, watchdog ${WATCHDOG_INTERVAL_MS}ms)`,
  );

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
  // Boot failures (e.g. a malformed DATABASE_URL surfacing from getPool) can
  // embed credentials in the error; redact before it hits platform logs.
  console.error(redactSecrets(err));
  process.exit(1);
});
