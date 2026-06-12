import type { Pool } from "pg";

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
}

export interface ReviewJobPayload extends Record<string, unknown> {
  installationId: number; // GitHub installation id
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}

/** An @postil mention on a PR or issue the bot should reply to. */
export interface RespondJobPayload extends Record<string, unknown> {
  installationId: number;
  repoFullName: string;
  number: number; // PR or issue number
  isPr: boolean;
  comment: string; // the maintainer's message text
  // "path:line" anchor when the mention is a PR review comment, so the bot
  // knows which code the question is about.
  commentAnchor?: string;
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

export async function claimJob(pool: Pool, workerId: string): Promise<ClaimedJob | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT id, kind, payload, attempts, max_attempts
       FROM jobs
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE jobs
       SET status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = $2
       WHERE id = $1`,
      [row.id, workerId],
    );
    await client.query("COMMIT");
    return {
      id: Number(row.id),
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts + 1,
      maxAttempts: row.max_attempts,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function completeJob(pool: Pool, jobId: number): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL WHERE id = $1`,
    [jobId],
  );
}

export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 15 * 60_000);
}

/** Mark a job failed; requeue with backoff while attempts remain. */
export async function failJob(
  pool: Pool,
  job: Pick<ClaimedJob, "id" | "attempts" | "maxAttempts">,
  error: string,
): Promise<"retried" | "failed"> {
  if (job.attempts < job.maxAttempts) {
    const delay = backoffMs(job.attempts);
    await pool.query(
      `UPDATE jobs
       SET status = 'queued', locked_at = NULL, locked_by = NULL,
           last_error = $2, run_after = now() + ($3 || ' milliseconds')::interval
       WHERE id = $1`,
      [job.id, error.slice(0, 2000), String(delay)],
    );
    return "retried";
  }
  await pool.query(
    `UPDATE jobs
     SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = $2
     WHERE id = $1`,
    [job.id, error.slice(0, 2000)],
  );
  return "failed";
}

export async function queueDepth(pool: Pool): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs WHERE status = 'queued'`,
  );
  return Number(res.rows[0]?.count ?? 0);
}
