import type { Pool } from "pg";

import { redactAndTruncate } from "@/lib/redact";
import type { ReviewTriggerContext } from "@/lib/review-trigger";

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
  sourceDeliveryId?: string;
  /** Optional only for jobs queued by an older release during a rolling deploy. */
  trigger?: ReviewTriggerContext;
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
  sourceDeliveryId?: string;
  trigger?: {
    source: "github_mention";
    webhookDeliveryId: string;
    webhookEvent: "issue_comment" | "pull_request_review_comment" | "issues";
    webhookAction: "created" | "opened";
    sourceCommentId?: number;
    sourceUrl?: string;
    requestedByGithubId?: number;
    requestedByLogin?: string;
  };
}

/** A fixed webhook reply delivered through the marker-reconciled comment path. */
export interface WebhookCommentJobPayload extends Record<string, unknown> {
  installationId: number;
  repoFullName: string;
  number: number;
  body: string;
  sourceDeliveryId: string;
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
  headSha?: string;
  advisoryCheckExternalId?: string;
  gateCheckExternalId?: string;
  advisoryCheckRunMayExist?: boolean;
  gateCheckRunMayExist?: boolean;
  message: string;
  detailsUrl?: string;
  intent?: "fail" | "neutralize";
}

export interface WebhookDispatchJobPayload extends Record<string, unknown> {
  deliveryId: string;
}

export interface StoredWebhookDelivery {
  deliveryId: string;
  event: string;
  action: string | null;
  payload: unknown;
}

/** A dispatch job refers to inbox state that cannot become valid through retry. */
export class WebhookDeliveryStateError extends Error {
  override name = "WebhookDeliveryStateError";
}

/**
 * Commit a signed GitHub delivery and its dispatch job together. The advisory
 * transaction lock serializes concurrent attempts for one delivery without
 * holding a database connection while the event is processed. A manual
 * redelivery revives an incomplete delivery after its prior job exhausts.
 */
export async function acceptWebhookDelivery(
  pool: Pool,
  input: StoredWebhookDelivery,
): Promise<"queued" | "inflight" | "duplicate"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `postil:webhook-delivery:${input.deliveryId}`,
    ]);
    const existing = await client.query<{ completed_at: Date | null }>(
      `SELECT completed_at FROM webhook_deliveries WHERE delivery_id = $1`,
      [input.deliveryId],
    );
    if (existing.rows[0]?.completed_at) {
      await client.query("COMMIT");
      return "duplicate";
    }
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO webhook_deliveries (delivery_id, event, action, payload, completed_at)
         VALUES ($1, $2, $3, $4::jsonb, NULL)`,
        [input.deliveryId, input.event, input.action, JSON.stringify(input.payload)],
      );
    }

    const active = await client.query<{ id: string }>(
      `SELECT id
         FROM jobs
        WHERE kind = 'webhook-dispatch'
          AND status IN ('queued', 'running')
          AND payload->>'deliveryId' = $1
        LIMIT 1`,
      [input.deliveryId],
    );
    if ((active.rowCount ?? 0) > 0) {
      await client.query("COMMIT");
      return "inflight";
    }
    if (active.rowCount === 0) {
      await client.query(
        `INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
         VALUES ('webhook-dispatch', jsonb_build_object('deliveryId', $1::text), 'queued', now(), 5)`,
        [input.deliveryId],
      );
    }
    await client.query("COMMIT");
    return "queued";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loadWebhookDelivery(
  pool: Pool,
  deliveryId: string,
): Promise<StoredWebhookDelivery | null> {
  const result = await pool.query<{
    event: string;
    action: string | null;
    payload: unknown;
    completed_at: Date | null;
  }>(
    `SELECT event, action, payload, completed_at
       FROM webhook_deliveries
      WHERE delivery_id = $1`,
    [deliveryId],
  );
  const row = result.rows[0];
  if (!row) throw new WebhookDeliveryStateError(`webhook delivery ${deliveryId} is missing`);
  if (row.completed_at) return null;
  if (row.payload === null) {
    throw new WebhookDeliveryStateError(
      `webhook delivery ${deliveryId} has no dispatch payload`,
    );
  }
  return {
    deliveryId,
    event: row.event,
    action: row.action,
    payload: row.payload,
  };
}

/** Clear retained payload data only after every dispatch side effect succeeds. */
export async function completeWebhookDelivery(pool: Pool, deliveryId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE webhook_deliveries
        SET payload = NULL, completed_at = now()
      WHERE delivery_id = $1 AND completed_at IS NULL`,
    [deliveryId],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error(`webhook delivery ${deliveryId} could not be completed`);
  }
}

export const WEBHOOK_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const WEBHOOK_DELIVERY_RETENTION_BATCH_SIZE = 1_000;

/** Delete one bounded batch of completed delivery ids after the dedupe window. */
export async function pruneCompletedWebhookDeliveries(
  pool: Pool,
  options: {
    now?: Date;
    retentionMs?: number;
    batchSize?: number;
  } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const retentionMs = options.retentionMs ?? WEBHOOK_DELIVERY_RETENTION_MS;
  const batchSize = options.batchSize ?? WEBHOOK_DELIVERY_RETENTION_BATCH_SIZE;
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
    throw new Error("webhook delivery retention must be a positive safe integer");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 10_000) {
    throw new Error("webhook delivery retention batch size must be in 1..10000");
  }

  const cutoff = new Date(now.getTime() - retentionMs);
  const result = await pool.query(
    `WITH expired AS (
       SELECT ctid
         FROM webhook_deliveries
        WHERE completed_at IS NOT NULL AND completed_at < $1
        ORDER BY completed_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM webhook_deliveries AS delivery
      USING expired
      WHERE delivery.ctid = expired.ctid`,
    [cutoff, batchSize],
  );
  return result.rowCount ?? 0;
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

/** Enqueue one model-generated response for one signed webhook delivery. */
export async function enqueueRespondJobOnce(
  pool: Pool,
  payload: RespondJobPayload,
): Promise<number | null> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
     VALUES ('respond', $1, 'queued', now(), 2)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [JSON.stringify(payload)],
  );
  return result.rows[0] ? Number(result.rows[0].id) : null;
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
       ON CONFLICT DO NOTHING
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
  options: { webhookDeliveryId?: string } = {},
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
       WHERE status = 'queued'
         AND run_after <= now()
         AND kind = ANY($1::text[])
         AND ($2::text IS NULL OR payload->>'deliveryId' = $2)
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [capabilities, options.webhookDeliveryId ?? null],
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

/** Requeue claims owned by one stopping worker without consuming an attempt. */
export async function requeueJobsOwnedBy(
  pool: Pool,
  lockedByPrefix: string,
  reason: string,
  kinds: readonly string[],
  jobIds: readonly number[],
): Promise<number> {
  if (!lockedByPrefix) throw new Error("requeueJobsOwnedBy requires a lock-owner prefix");
  const allowedKinds = [...new Set(kinds.filter(Boolean))];
  if (allowedKinds.length === 0) {
    throw new Error("requeueJobsOwnedBy requires at least one safe job kind");
  }
  const ownedJobIds = [...new Set(jobIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ownedJobIds.length === 0) return 0;
  const redactedReason = redactAndTruncate(reason, 2000);
  const result = await pool.query(
    `UPDATE jobs
     SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
         locked_at = NULL, locked_by = NULL, last_error = $2, run_after = now()
     WHERE status = 'running'
       AND left(locked_by, length($1)) = $1
       AND kind = ANY($3::text[])
       AND id = ANY($4::bigint[])`,
    [lockedByPrefix, redactedReason, allowedKinds, ownedJobIds],
  );
  return result.rowCount ?? 0;
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
