import type { Pool } from "pg";

import { redactAndTruncate } from "@/lib/redact";

/**
 * Postgres-native job queue.
 *
 * Claim semantics: a single-row SELECT ... FOR UPDATE SKIP LOCKED inside a
 * transaction, flipping the row to `running` before commit. Two workers can
 * never claim the same job; a crashed worker's lock dies with its
 * connection and the row stays `running` until the watchdog reschedules it.
 *
 * Retry: exponential backoff (30s * 2^attempts, capped at 15 min). A job
 * that exhausts maxAttempts is marked `failed` permanently.
 */

export interface ClaimedJob {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  lockedAt: Date;
  /**
   * The worker id this claim was locked under. failJob/completeJob scope their
   * UPDATEs by this value so a stalled-then-re-claimed job (watchdog requeue +
   * re-claim by another worker) is not clobbered by the original owner's late
   * call: only the current lock holder can transition the row.
   */
  lockedBy: string;
}

export interface ReviewJobPayload extends Record<string, unknown> {
  installationId: number; // GitHub installation id
  repoFullName: string;
  repositoryPrivate?: boolean;
  prNumber: number;
  authorGithubId?: number;
  authorLogin?: string;
  headSha: string;
  baseSha: string;
}

/** An @postil mention on a PR or issue the bot should reply to. */
export interface RespondJobPayload extends Record<string, unknown> {
  installationId: number;
  repoFullName: string;
  repositoryPrivate?: boolean;
  number: number; // PR or issue number
  isPr: boolean;
  comment: string; // the maintainer's message text
  // "path:line" anchor when the mention is a PR review comment, so the bot
  // knows which code the question is about.
  commentAnchor?: string;
}

export interface RespondDeliveryJobPayload extends Record<string, unknown> {
  respondJobId: number;
}

export interface RespondFailureCommentJobPayload extends RespondJobPayload {
  respondJobId: number;
}

export interface CheckRunCleanupJobPayload extends Record<string, unknown> {
  installationId: number;
  repoFullName: string;
  advisoryCheckRunId: number | null;
  gateCheckRunId: number | null;
  message: string;
  intent?: "fail" | "neutralize";
}

export async function enqueueJob(
  pool: Pool,
  kind: string,
  payload: Record<string, unknown>,
  opts: { runAfter?: Date; maxAttempts?: number } = {},
): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
     VALUES ($1, $2, 'queued', COALESCE($3, now()), COALESCE($4, 3))
     RETURNING id`,
    [kind, JSON.stringify(payload), opts.runAfter ?? null, opts.maxAttempts ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error("job insert returned no row");
  return Number(row.id);
}

/** Atomically enqueue one active review for an exact repository, PR, and head. */
export async function enqueueReviewJobOnce(
  pool: Pool,
  payload: ReviewJobPayload,
): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const identity = [payload.repoFullName, String(payload.prNumber), payload.headSha].join(
      "\u001f",
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `postil:active-review:${identity}`,
    ]);
    const result = await client.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       VALUES ('review', $1, 'queued', now(), 3)
       RETURNING id`,
      [JSON.stringify(payload)],
    );
    await client.query("COMMIT");
    return result.rows[0] ? Number(result.rows[0].id) : null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function claimJob(
  pool: Pool,
  workerId: string,
  allowedKinds: readonly string[],
): Promise<ClaimedJob | null> {
  const capabilities = [...new Set(allowedKinds.filter(Boolean))];
  if (capabilities.length === 0) {
    throw new Error("claimJob requires at least one allowed job kind");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
      created_at: Date;
    }>(
      `SELECT id, kind, payload, attempts, max_attempts, created_at
       FROM jobs
       WHERE status = 'queued' AND run_after <= now() AND kind = ANY($1::text[])
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [capabilities],
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const claimed = await client.query<{ locked_at: Date }>(
      `UPDATE jobs
       SET status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = $2
       WHERE id = $1
       RETURNING locked_at`,
      [row.id, workerId],
    );
    const lockedAt = claimed.rows[0]?.locked_at;
    if (!lockedAt) throw new Error("claimed job returned no lock timestamp");
    await client.query("COMMIT");
    return {
      id: Number(row.id),
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts + 1,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      lockedAt,
      lockedBy: workerId,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark a job done. Scoped by `status = 'running' AND locked_by = $lockedBy` so
 * a worker finishing late cannot stamp `done` over a job the watchdog already
 * requeued and a second worker re-claimed under a new lock (which would mask a
 * concurrent double-run). Only the current lock holder can complete the row.
 */
export async function completeJob(
  pool: Pool,
  job: Pick<ClaimedJob, "id" | "lockedBy">,
): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL
     WHERE id = $1 AND status = 'running' AND locked_by = $2`,
    [job.id, job.lockedBy],
  );
}

export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 15 * 60_000);
}

/**
 * Mark a job failed; requeue with backoff while attempts remain.
 *
 * Returns "retried" if requeued, "failed" if this call performed the
 * permanent transition, or "lost" if another path (the watchdog, or a
 * re-claim after a watchdog requeue) already owns the row. Both the retry
 * and the final-fail UPDATEs are conditioned on `status = 'running'`, so a
 * late call that lost the row to a re-claim returns "lost" rather than
 * resurrecting or re-failing it. Only "failed" owns post-failure side effects.
 *
 * Pass `opts.permanent` for a deterministic, non-retryable error (e.g. a
 * broken CA store or a missing CLI binary): the job goes straight to `failed`
 * regardless of remaining attempts, since retrying the same job against the
 * same image would fail identically. The permanent path reuses the same
 * conditional `running` -> `failed` UPDATE as the exhausted-attempts path, so
 * the single-post guard (only the winner of that transition returns "failed")
 * still holds for the user-facing failure comment.
 */
export async function failJob(
  pool: Pool,
  job: Pick<ClaimedJob, "id" | "attempts" | "maxAttempts" | "lockedBy">,
  error: string,
  opts: { permanent?: boolean } = {},
): Promise<"retried" | "failed" | "lost"> {
  const redactedError = redactAndTruncate(error, 2000);
  if (!opts.permanent && job.attempts < job.maxAttempts) {
    const delay = backoffMs(job.attempts);
    // Guarded by `status = 'running'` (mirroring the final-fail path below).
    // If the watchdog already requeued this stalled job and a second worker
    // re-claimed it (`status` now 'queued' or 'running' under a new owner with
    // a higher attempt count), a late transient-retry from the original worker
    // must NOT reset it back to 'queued': that would resurrect a job another
    // worker owns and let a third worker run it concurrently (double review /
    // reply / check-runs / LLM spend). rowCount 0 means we lost the row; report
    // "lost" and do not resurrect it.
    const res = await pool.query(
      `UPDATE jobs
       SET status = 'queued', locked_at = NULL, locked_by = NULL,
           last_error = $2, run_after = now() + ($3 || ' milliseconds')::interval
       WHERE id = $1 AND status = 'running' AND locked_by = $4`,
      [job.id, redactedError, String(delay), job.lockedBy],
    );
    return (res.rowCount ?? 0) > 0 ? "retried" : "lost";
  }
  // Conditional transition (reached on exhausted attempts or a permanent
  // error): only the caller that flips `running` -> `failed` gets rowCount 1.
  // If the watchdog already failed this job (worker died mid-run), this
  // affects 0 rows. The winner is the single owner of any follow-up side
  // effect (e.g. posting a user-facing failure comment).
  const res = await pool.query(
    `UPDATE jobs
     SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = $2,
         run_after = now()
     WHERE id = $1 AND status = 'running' AND locked_by = $3`,
    [job.id, redactedError, job.lockedBy],
  );
  return (res.rowCount ?? 0) > 0 ? "failed" : "lost";
}

/** Requeue reconciliation work until its target state is superseded or published. */
export async function retryJobIndefinitely(
  pool: Pool,
  job: Pick<ClaimedJob, "id" | "attempts" | "lockedBy">,
  error: string,
): Promise<"retried" | "lost"> {
  const redactedError = redactAndTruncate(error, 2000);
  const delay = backoffMs(job.attempts);
  const res = await pool.query(
    `UPDATE jobs
     SET status = 'queued', locked_at = NULL, locked_by = NULL,
         last_error = $2, run_after = now() + ($3 || ' milliseconds')::interval
     WHERE id = $1 AND status = 'running' AND locked_by = $4`,
    [job.id, redactedError, String(delay), job.lockedBy],
  );
  return (res.rowCount ?? 0) > 0 ? "retried" : "lost";
}

export async function queueDepth(pool: Pool): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs WHERE status = 'queued'`,
  );
  return Number(res.rows[0]?.count ?? 0);
}
