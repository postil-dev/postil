/**
 * Postil worker. Polls the Postgres job table, spawns the baked-in `postil`
 * binary as a child process, and writes the resulting envelope back to the DB.
 *
 * Run with `bun run src/worker/run.ts`. One process per container is fine; the
 * SELECT FOR UPDATE SKIP LOCKED pattern in `claimNext` keeps it safe to scale
 * horizontally.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { reviews, usageEvents } from "@/db/schema";
import { unsealToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import {
  claimNext,
  complete,
  fail,
  reapStaleLocks,
  type ReviewJobPayload,
} from "@/lib/jobs";
import type { ReviewResult } from "@/db/schema";

const WORKER_ID = `${process.env.HOSTNAME ?? "local"}-${randomUUID().slice(0, 8)}`;
const POLL_MS = 1000;
const REVIEW_TIMEOUT_MS = 8 * 60 * 1000;

async function main() {
  console.log(`postil worker ${WORKER_ID} starting`);
  let shutdown = false;
  process.on("SIGINT", () => {
    shutdown = true;
  });
  process.on("SIGTERM", () => {
    shutdown = true;
  });

  let staleReapAt = 0;
  while (!shutdown) {
    if (Date.now() >= staleReapAt) {
      await reapStaleLocks(db).catch((e) => console.error("reapStaleLocks", e));
      staleReapAt = Date.now() + 60_000;
    }

    let job: Awaited<ReturnType<typeof claimNext>> = null;
    try {
      job = await claimNext(db, WORKER_ID, ["review"]);
    } catch (e) {
      console.error("claimNext error", e);
      await sleep(POLL_MS * 5);
      continue;
    }

    if (!job) {
      await sleep(POLL_MS);
      continue;
    }

    try {
      await runReview(job.id, job.payload as unknown as ReviewJobPayload);
      await complete(db, job.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const willRetry = job.attempts < 3;
      console.error(`job ${job.id} failed (attempt ${job.attempts}, retry=${willRetry})`, e);
      await fail(db, job.id, message, willRetry);
    }
  }
  console.log("postil worker shutdown clean");
  process.exit(0);
}

async function runReview(jobId: string, payload: ReviewJobPayload) {
  const e = env();
  const cliPath = e.POSTIL_CLI_PATH;

  await db
    .update(reviews)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(reviews.id, payload.reviewId));

  const token = await unsealToken(payload.encryptedToken);
  const workDir = await mkdir(join(tmpdir(), `postil-${jobId}`), { recursive: true });
  if (!workDir) throw new Error("could not create work dir");
  const envelopePath = join(workDir, "envelope.json");

  const args = [
    "review",
    "--repo",
    payload.repoFullName,
    "--pr",
    String(payload.pullNumber),
    "--sha",
    payload.headSha,
    "--check-run-id",
    String(payload.checkRunId),
    "--check-name",
    payload.checkName,
    "--output-json",
    envelopePath,
  ];

  const subprocess = spawn(cliPath, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      GITHUB_TOKEN: token,
      OPENROUTER_API_KEY: e.OPENROUTER_API_KEY ?? "",
      POSTIL_GITHUB_API_URL: process.env.POSTIL_GITHUB_API_URL ?? "",
      POSTIL_OPENROUTER_API_URL: process.env.POSTIL_OPENROUTER_API_URL ?? "",
    },
  });

  const timeout = setTimeout(() => {
    subprocess.kill("SIGKILL");
  }, REVIEW_TIMEOUT_MS);

  const exit: number = await new Promise((resolve) => {
    subprocess.on("close", (code) => resolve(code ?? -1));
    subprocess.on("error", () => resolve(-2));
  });
  clearTimeout(timeout);

  let envelope: ReviewResult | null = null;
  try {
    const raw = await readFile(envelopePath, "utf8");
    envelope = JSON.parse(raw) as ReviewResult;
  } catch {
    envelope = null;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (!envelope) {
    throw new Error(`CLI exited ${exit} without writing envelope`);
  }

  const status = exit === 1 ? "completed" : exit === 0 ? "completed" : "failed";
  await db
    .update(reviews)
    .set({
      status,
      result: envelope,
      completedAt: new Date(),
      errorMessage: status === "failed" ? `CLI exit ${exit}` : null,
    })
    .where(eq(reviews.id, payload.reviewId));

  // Usage events power the silence-rate dashboard.
  const isSilent = envelope.findings.length === 0;
  await db.insert(usageEvents).values([
    {
      id: randomUUID(),
      organizationId: await resolveOrg(payload.repoFullName, payload.installationId),
      reviewId: payload.reviewId,
      kind: isSilent ? "review_silent" : "review_completed",
      quantity: 1,
      metadata: { repo: payload.repoFullName, pr: payload.pullNumber },
    },
    {
      id: randomUUID(),
      organizationId: await resolveOrg(payload.repoFullName, payload.installationId),
      reviewId: payload.reviewId,
      kind: "tokens_consumed",
      quantity: envelope.usage?.totalTokens ?? 0,
      metadata: { model: envelope.modelUsed },
    },
  ]);
}

async function resolveOrg(_repoFullName: string, installationId: number): Promise<string> {
  // For the v1 hosted product we key org by installation id; the install
  // webhook handler is what creates the org row. We fall back to a synthetic
  // string when an org row does not yet exist so usage events are never lost.
  return `install:${installationId}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error("worker fatal", e);
  process.exit(1);
});
