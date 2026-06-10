/**
 * Postgres-backed job queue. Replaces the Trigger.dev dispatch layer from the
 * previous incarnation, which was a recurring source of credential thrash
 * (`TRIGGER_SECRET_KEY` / `TRIGGER_API_KEY` / `TRIGGER_API_TOKEN` rotation
 * pain) and runtime-image install fragility for the CLI subprocess.
 *
 * We use the canonical "SELECT FOR UPDATE SKIP LOCKED" pattern. Each worker
 * polls, locks a row, runs the job, and writes the terminal status back.
 */

import { and, eq, lte, sql } from "drizzle-orm";

import type { DB } from "@/db/client";
import { jobs } from "@/db/schema";

const STALE_LOCK_MS = 30 * 60 * 1000;

export type JobKind = "review" | "auto_merge";

export type ReviewJobPayload = {
  reviewId: string;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  installationId: number;
  encryptedToken: string;
  tokenExpiresAt: string;
  checkRunId: number;
  checkName: string;
  configPath?: string;
};

export type AutoMergeJobPayload = {
  reviewId: string;
  repoFullName: string;
  pullNumber: number;
  installationId: number;
  encryptedToken: string;
  requiredChecks: string[];
  timeoutMs: number;
  e2eLabelGate: boolean;
};

export async function enqueue(
  db: DB,
  jobId: string,
  kind: JobKind,
  payload: Record<string, unknown>,
  options: { runInMs?: number; maxAttempts?: number } = {},
) {
  const runAt = new Date(Date.now() + (options.runInMs ?? 0));
  await db
    .insert(jobs)
    .values({
      id: jobId,
      kind,
      payload,
      status: "queued",
      runAt,
      maxAttempts: options.maxAttempts ?? 3,
    })
    .onConflictDoNothing();
}

export async function claimNext(
  db: DB,
  workerId: string,
  kinds: JobKind[],
): Promise<{ id: string; kind: JobKind; payload: Record<string, unknown>; attempts: number } | null> {
  const result = await db.execute<{
    id: string;
    kind: JobKind;
    payload: Record<string, unknown>;
    attempts: number;
  }>(sql`
    with claimed as (
      select id from ${jobs}
      where status = 'queued'
        and run_at <= now()
        and kind = any(${kinds})
      order by run_at asc
      for update skip locked
      limit 1
    )
    update ${jobs} j
      set status = 'running',
          locked_at = now(),
          locked_by = ${workerId},
          attempts = attempts + 1
      from claimed
     where j.id = claimed.id
    returning j.id, j.kind, j.payload, j.attempts
  `);
  const row = (result as unknown as { rows?: typeof result }).rows ?? result;
  // postgres.js returns Array-like; normalise.
  const first = Array.isArray(row) ? row[0] : undefined;
  return (first as { id: string; kind: JobKind; payload: Record<string, unknown>; attempts: number } | undefined) ?? null;
}

export async function complete(db: DB, jobId: string) {
  await db
    .update(jobs)
    .set({ status: "completed", completedAt: new Date(), lockedAt: null, lockedBy: null })
    .where(eq(jobs.id, jobId));
}

export async function fail(db: DB, jobId: string, error: string, willRetry: boolean) {
  await db
    .update(jobs)
    .set({
      status: willRetry ? "queued" : "failed",
      lastError: error,
      runAt: willRetry ? new Date(Date.now() + 30_000) : undefined,
      lockedAt: null,
      lockedBy: null,
    })
    .where(eq(jobs.id, jobId));
}

export async function reapStaleLocks(db: DB) {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS);
  await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, lockedBy: null })
    .where(and(eq(jobs.status, "running"), lte(jobs.lockedAt, cutoff)));
}
