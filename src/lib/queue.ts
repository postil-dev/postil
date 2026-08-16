import type { Pool, PoolClient } from "pg";

import { readPositiveIntEnv } from "@/lib/env";
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
  /** Monotonic per-row lease identity incremented by every successful claim. */
  lockGeneration: bigint;
  /**
   * The worker id this claim was locked under. Queue transitions pair it with
   * lockGeneration so a stalled, requeued, and reclaimed job is not clobbered
   * by a late call, including when the same worker identity is reused.
   */
  lockedBy: string;
}

export interface ReviewJobPayload extends Record<string, unknown> {
  installationId: number; // GitHub installation id
  sourceInstallationId?: number;
  sourceOrgId?: number;
  githubRepoId: number;
  repoFullName: string;
  repositoryPrivate?: boolean;
  prNumber: number;
  authorGithubId?: number;
  authorLogin?: string;
  headSha: string;
  baseSha: string;
  /** Signed event snapshot used to wait for GitHub read-after-write convergence. */
  expectedPullRequestUpdatedAt: string;
  /** Database-assigned arrival order for otherwise equal signed snapshots. */
  reviewInputSequence?: string;
  sourceDeliveryId?: string;
  /** Optional only for jobs queued by an older release during a rolling deploy. */
  trigger?: ReviewTriggerContext;
  /** Use the complete base-to-head diff even when a completed baseline exists. */
  forceFullReview?: boolean;
  /** Durable pointer written after the review result is staged for recovery. */
  recoveryReviewId?: number;
  /** Stable provider-attempt lineage retained when queue rows are promoted. */
  providerRetryLineage?: string;
  /** Private marker that prevents a web-process queue drain from claiming a rehearsal recovery. */
  privateWorkerRehearsalNonce?: string;
  /** Exact lock owner recorded when a private-worker rehearsal interrupts this claim. */
  privateWorkerRehearsalLockedBy?: string;
  /** Exact lock generation recorded with the private-worker rehearsal owner. */
  privateWorkerRehearsalLockGeneration?: string;
}

export const COALESCED_REVIEW_PAYLOAD_KEY = "_postilCoalescedReviewPayload";
export const PROVIDER_RETRY_LINEAGE_KEY = "providerRetryLineage";
export const REVIEW_INPUT_SEQUENCE_KEY = "reviewInputSequence";
const PUBLICATION_CONTROLLER_ACTIVE_PREFIX =
  "publication-controller-release:";
const PUBLICATION_CONTROLLER_READY_PREFIX =
  "publication-controller-consumer-ready:";
const PUBLICATION_CONTROLLER_RECOVERY_PREFIX =
  "publication-controller-recovery:";
const PUBLICATION_CONTROLLER_FENCE_KEY =
  "_postilPublicationControllerFence";
const PUBLICATION_CONTROLLER_RELEASE_KEY =
  "_postilPublicationControllerReleaseSha";
const PUBLICATION_CONTROLLER_RUN_AFTER_KEY =
  "_postilPublicationControllerRunAfter";
const PUBLICATION_CONTROLLER_CLAIM_KEY =
  "_postilPublicationControllerClaimReleaseSha";
const QUEUE_LOCK_GENERATION_CAPABILITY = "queue-lock-generation-v1";
const QUEUE_LOCK_GENERATION_LOCK = "postil:queue-lock-generation-v1";
const PUBLICATION_CONTROLLER_LOCK = "postil:publication-controller-release";
const PUBLICATION_CONTROLLER_CLAIM_LOCK_TIMEOUT_MS = 5_000;

type StoredReviewJobPayload = ReviewJobPayload & {
  [COALESCED_REVIEW_PAYLOAD_KEY]?: ReviewJobPayload;
};

/** An @postil mention on a PR or issue the bot should reply to. */
export interface RespondJobPayload extends Record<string, unknown> {
  installationId: number;
  sourceInstallationId?: number;
  sourceOrgId?: number;
  githubRepoId?: number;
  repoFullName: string;
  repositoryPrivate?: boolean;
  number: number; // PR or issue number
  isPr: boolean;
  sourceHeadSha?: string;
  comment: string; // the maintainer's message text
  // "path:line" anchor when the mention is a PR review comment, so the bot
  // knows which code the question is about.
  commentAnchor?: string;
  /** Bounded Postil-authored root comment for a clarification reply. */
  threadContext?: string;
  /** Root review-comment id used to keep success and failure replies in-thread. */
  replyToReviewCommentId?: number;
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
  sourceInstallationId?: number;
  sourceOrgId?: number;
  githubRepoId?: number;
  repoFullName: string;
  number: number;
  isPr: boolean;
  sourceHeadSha?: string;
  body: string;
  sourceDeliveryId: string;
}

/** Idempotent acknowledgement of an admitted GitHub conversation request. */
export interface GithubReactionJobPayload extends Record<string, unknown> {
  installationId: number;
  sourceInstallationId: number;
  sourceOrgId: number;
  githubRepoId: number;
  repoFullName: string;
  commentId: number;
  commentKind: "issue_comment" | "pull_request_review_comment";
  content: "+1" | "eyes";
  sourceDeliveryId: string;
}

export type JobLease = Pick<ClaimedJob, "id" | "lockedBy" | "lockGeneration">;

export type ExternalSideEffectLease = JobLease;

function reviewPullRequestLockKey(input: {
  githubRepoId: number;
  prNumber: number;
}): string {
  if (!Number.isSafeInteger(input.githubRepoId) || input.githubRepoId <= 0) {
    throw new TypeError("review publication fence requires a positive GitHub repository ID");
  }
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    throw new TypeError("review publication fence requires a positive pull request number");
  }
  return `postil:review-pr:${[
    String(input.githubRepoId),
    String(input.prNumber),
  ].join("\u001f")}`;
}

/**
 * Exclude pull-request queue mutation from the exact external publication
 * window. PostgreSQL releases the session lock if the worker or connection
 * dies, while the CLI deadline bounds how long a healthy worker can hold it.
 */
export async function withReviewPublicationFence<T>(
  pool: Pool,
  input: { githubRepoId: number; prNumber: number },
  publish: () => Promise<T>,
): Promise<T> {
  const key = reviewPullRequestLockKey(input);
  const client = await pool.connect();
  let locked = false;
  let destroyConnection = false;
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [key],
    );
    locked = true;
    return await publish();
  } finally {
    if (locked) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
          [key],
        );
        destroyConnection = result.rows[0]?.unlocked !== true;
      } catch {
        destroyConnection = true;
      }
    }
    client.release(destroyConnection);
  }
}

/** Verify a queue claim without retaining a row or connection lock. */
export async function externalSideEffectLeaseActive(
  pool: Pick<Pool, "query">,
  lease: ExternalSideEffectLease,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM jobs
      WHERE id = $1
        AND status = 'running'
        AND locked_by = $2
        AND lock_generation = $3
      LIMIT 1`,
    [lease.id, lease.lockedBy, lease.lockGeneration],
  );
  return (result.rowCount ?? 0) === 1;
}

export type ReviewInputLeaseState = "inactive" | "current" | "newer-pending";

/** Return whether a retained edit is newer than the running review input. */
export function pendingReviewInputSupersedes(
  runningUpdatedAt: string | undefined,
  pendingUpdatedAt: string | undefined,
  runningSequence?: string,
  pendingSequence?: string,
): boolean {
  if (!pendingUpdatedAt) return false;
  const pendingTime = Date.parse(pendingUpdatedAt);
  if (!Number.isFinite(pendingTime)) return false;
  if (!runningUpdatedAt) return true;
  const runningTime = Date.parse(runningUpdatedAt);
  if (!Number.isFinite(runningTime) || pendingTime > runningTime) return true;
  if (pendingTime < runningTime) return false;
  if (!validReviewInputSequence(pendingSequence)) return false;
  // Missing sequence authority is never proof that an equal-timestamp input
  // is current. This only occurs for a legacy claim or malformed row, and a
  // later retained sequence must conservatively supersede it.
  if (!validReviewInputSequence(runningSequence)) return true;
  return BigInt(pendingSequence) > BigInt(runningSequence);
}

/**
 * Verify the exact review claim and detect a newer same-head edit retained for
 * its rerun. This query is the final queue-side authorization before the CLI
 * starts, so a worker cannot rely only on the payload snapshot it claimed.
 */
export async function reviewInputLeaseState(
  pool: Pick<Pool, "query">,
  lease: ExternalSideEffectLease,
  runningUpdatedAt: string | undefined,
  runningSequence?: string,
): Promise<ReviewInputLeaseState> {
  const result = await pool.query<{
    running_sequence: string | null;
    pending_updated_at: string | null;
    pending_sequence: string | null;
  }>(
    `SELECT payload->>$4::text AS running_sequence,
            payload #>> ($5::text[]) AS pending_updated_at,
            payload #>> ($6::text[]) AS pending_sequence
       FROM jobs
      WHERE id = $1
        AND status = 'running'
        AND locked_by = $2
        AND lock_generation = $3
      LIMIT 1`,
    [
      lease.id,
      lease.lockedBy,
      lease.lockGeneration,
      REVIEW_INPUT_SEQUENCE_KEY,
      [COALESCED_REVIEW_PAYLOAD_KEY, "expectedPullRequestUpdatedAt"],
      [COALESCED_REVIEW_PAYLOAD_KEY, REVIEW_INPUT_SEQUENCE_KEY],
    ],
  );
  const row = result.rows[0];
  if (!row) return "inactive";
  // The database row is authoritative: a worker can have claimed an
  // old-binary payload before migration backfilled its sequence.
  const storedRunningSequence = validReviewInputSequence(row.running_sequence)
    ? row.running_sequence
    : runningSequence;
  return pendingReviewInputSupersedes(
    runningUpdatedAt,
    row.pending_updated_at ?? undefined,
    storedRunningSequence,
    row.pending_sequence ?? undefined,
  )
    ? "newer-pending"
    : "current";
}

/** Revoke every publication path bound to one exact pull request identity. */
export async function cancelPullRequestPublication(
  pool: Pool,
  input: {
    installationId: number;
    sourceInstallationId: number;
    sourceOrgId: number;
    githubRepoId: number;
    repoFullName: string;
    prNumber: number;
  },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [reviewPullRequestLockKey(input)],
    );
    const result = await client.query(
    `WITH matching_jobs AS MATERIALIZED (
       SELECT id
         FROM jobs
        WHERE kind IN ('review', 'respond', 'respond-failure-comment', 'webhook-comment')
          AND status IN ('queued', 'running')
          AND payload->>'installationId' = $1::text
          AND payload->>'sourceInstallationId' = $2::text
          AND payload->>'sourceOrgId' = $3::text
          AND payload->>'githubRepoId' = $4::text
          AND lower(payload->>'repoFullName') = lower($5)
          AND COALESCE((payload->>'prNumber')::integer, (payload->>'number')::integer) = $6
          AND COALESCE((payload->>'isPr')::boolean, kind = 'review')
     ), cancelled_deliveries AS (
       UPDATE respond_deliveries delivery
          SET state = 'cancelled',
              publication_lease_id = NULL,
              publication_lease_expires_at = NULL,
              delivery_lease_expires_at = NULL,
              cancelled_at = now(),
              updated_at = now()
        WHERE delivery.source_github_installation_id = $1::bigint
          AND delivery.source_installation_id = $2::bigint
          AND delivery.source_org_id = $3::bigint
          AND delivery.source_github_repo_id = $4::bigint
          AND lower(delivery.repo_full_name) = lower($5)
          AND delivery.issue_number = $6
          AND delivery.is_pr
          AND delivery.state IN ('prepared', 'delivering')
      RETURNING delivery.job_id
     ), delivery_jobs AS (
       SELECT job.id
         FROM jobs job
         JOIN cancelled_deliveries delivery
           ON job.kind = 'respond-delivery'
          AND job.payload->>'respondJobId' = delivery.job_id::text
        WHERE job.status IN ('queued', 'running')
     ), terminal_ids AS (
       SELECT id FROM matching_jobs
       UNION SELECT id FROM delivery_jobs
     )
     UPDATE jobs job
        SET status = 'done', locked_at = NULL, locked_by = NULL,
            last_error = 'pull request closed'
      WHERE job.id IN (SELECT id FROM terminal_ids)
        AND job.status IN ('queued', 'running')`,
    [
      String(input.installationId),
      String(input.sourceInstallationId),
      String(input.sourceOrgId),
      String(input.githubRepoId),
      input.repoFullName,
      input.prNumber,
    ],
    );
    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface RespondDeliveryJobPayload extends Record<string, unknown> {
  respondJobId: number;
}

export interface RespondFailureCommentJobPayload extends RespondJobPayload {
  respondJobId: number;
}

export interface CheckRunCleanupJobPayload extends Record<string, unknown> {
  reviewId?: number;
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
  publicationIncomplete?: boolean;
}

export interface GateEnforcementSweepJobPayload extends Record<string, unknown> {
  scopeKey: string;
  orgId?: number;
  afterRepositoryId?: number;
  requestedAt: string;
}

export type GateEnforcementSweepStatus = "queued" | "running" | "done" | "failed";

export async function enqueueGateEnforcementSweepOnce(
  pool: Pool,
  input: { orgId?: number; minIntervalMs?: number } = {},
): Promise<number | null> {
  const scopeKey = input.orgId === undefined ? "global" : `org:${input.orgId}`;
  const payload: GateEnforcementSweepJobPayload = {
    scopeKey,
    ...(input.orgId === undefined ? {} : { orgId: input.orgId }),
    requestedAt: new Date().toISOString(),
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`postil:gate-enforcement-sweep:${scopeKey}`],
    );
    const result = await client.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       SELECT 'gate-enforcement-sweep', $1::jsonb, 'queued', now(), 20
       WHERE NOT EXISTS (
         SELECT 1 FROM jobs
         WHERE kind = 'gate-enforcement-sweep'
           AND payload->>'scopeKey' = $3
           AND (
             status IN ('queued', 'running')
             OR ($2::bigint IS NOT NULL AND created_at >= now() - ($2 || ' milliseconds')::interval)
           )
       )
       RETURNING id`,
      [JSON.stringify(payload), input.minIntervalMs ?? null, scopeKey],
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

export async function findActiveGateEnforcementSweep(
  pool: Pick<Pool, "query">,
  orgId: number,
): Promise<number | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM jobs
      WHERE kind = 'gate-enforcement-sweep'
        AND status IN ('queued', 'running')
        AND payload->>'scopeKey' = $1
      ORDER BY id LIMIT 1`,
    [`org:${orgId}`],
  );
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

export async function getGateEnforcementSweepStatus(
  pool: Pick<Pool, "query">,
  input: { jobId: number; orgId: number },
): Promise<GateEnforcementSweepStatus | null> {
  if (!Number.isInteger(input.jobId) || input.jobId <= 0) return null;
  const result = await pool.query<{ status: GateEnforcementSweepStatus }>(
    `SELECT status FROM jobs
      WHERE id = $1
        AND kind = 'gate-enforcement-sweep'
        AND payload->>'scopeKey' = $2
        AND status IN ('queued', 'running', 'done', 'failed')
      LIMIT 1`,
    [input.jobId, `org:${input.orgId}`],
  );
  return result.rows[0]?.status ?? null;
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

const PERMANENT_JOB_ERROR = Symbol.for("postil.permanent-job-error");

/** Deterministic job failure that must not consume the queue retry budget. */
export class PermanentJobError extends Error {
  readonly [PERMANENT_JOB_ERROR] = true;
  override name = "PermanentJobError";
}

/** Structural marker survives module duplication in bundled worker runtimes. */
export function isPermanentJobError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, PERMANENT_JOB_ERROR) === true
  );
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

/** Serialize the rolling cap check with response admission. */
export async function enqueueRespondJobWithinHourlyCap(
  pool: Pool,
  payload: RespondJobPayload,
  hourlyCap: number,
): Promise<{ id: number | null; rateLimited: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `postil:respond-rate:${payload.installationId}`,
    ]);
    if (payload.sourceDeliveryId) {
      const existing = await client.query(
        `SELECT 1 FROM jobs
          WHERE kind = 'respond'
            AND payload->>'sourceDeliveryId' = $1
          LIMIT 1`,
        [payload.sourceDeliveryId],
      );
      if ((existing.rowCount ?? 0) > 0) {
        await client.query("COMMIT");
        return { id: null, rateLimited: false };
      }
    }
    const count = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM jobs
        WHERE kind = 'respond'
          AND created_at >= now() - interval '1 hour'
          AND payload->>'installationId' = $1`,
      [String(payload.installationId)],
    );
    if (Number(count.rows[0]?.count ?? 0) >= hourlyCap) {
      await client.query("COMMIT");
      return { id: null, rateLimited: true };
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       VALUES ('respond', $1, 'queued', now(), 2)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [JSON.stringify(payload)],
    );
    await client.query("COMMIT");
    return {
      id: inserted.rows[0] ? Number(inserted.rows[0].id) : null,
      rateLimited: false,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Enqueue one reaction for one signed webhook delivery. The lifetime lookup,
 * serialized by an advisory lock, covers terminal jobs too: a redelivery must
 * not recreate an external side effect after its first job completes.
 */
export async function enqueueGithubReactionJobOnce(
  pool: Pool,
  payload: GithubReactionJobPayload,
): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `postil:github-reaction:${payload.sourceDeliveryId}`,
    ]);
    const result = await client.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       SELECT 'github-reaction', $1::jsonb, 'queued', now(), 3
       WHERE NOT EXISTS (
         SELECT 1
           FROM jobs
          WHERE kind = 'github-reaction'
            AND payload->>'sourceDeliveryId' = $2
       )
       RETURNING id`,
      [JSON.stringify(payload), payload.sourceDeliveryId],
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

/**
 * Atomically retain the newest review intent for an exact repository, PR, and
 * head. Queued work is upgraded in place. Work requested during a running
 * review is retained as one unclaimable rerun payload on that job. A newer
 * edit timestamp in that payload also cancels the running worker's input; the
 * rerun becomes claimable only after the outer attempt releases its claim.
 */
export async function enqueueReviewJobOnce(
  pool: Pool,
  payload: ReviewJobPayload,
): Promise<number | null> {
  if (!Number.isSafeInteger(payload.githubRepoId) || payload.githubRepoId <= 0) {
    throw new TypeError("review job requires a positive GitHub repository ID");
  }
  if (!validReviewEventTimestamp(payload.expectedPullRequestUpdatedAt)) {
    throw new TypeError("review job requires a valid pull request update timestamp");
  }
  const incomingPayload = withoutAssignedReviewInputSequence(payload);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const identity = reviewJobIdentity(incomingPayload);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      reviewPullRequestLockKey(incomingPayload),
    ]);
    // Serialize with writers from releases that still key the active-review
    // lock by repository name. The database trigger independently enforces the
    // stable repository-ID identity for every writer during the rollout.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `postil:active-review:${[
        incomingPayload.repoFullName,
        String(incomingPayload.prNumber),
        incomingPayload.headSha,
      ].join("\u001f")}`,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `postil:active-review:${identity}`,
    ]);
    const active = await selectActiveReviewJob(client, incomingPayload);
    if (!active) {
      const reviewInputSequence = await nextReviewInputSequence(client);
      const result = await client.query<{ id: string }>(
        `INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
         VALUES ('review', $1, 'queued', now(), 3)
         RETURNING id`,
        [JSON.stringify({
          ...withoutCoalescedReviewPayload(incomingPayload),
          reviewInputSequence,
        })],
      );
      if (result.rows[0]) {
        await client.query(
          `UPDATE jobs
              SET payload = payload || jsonb_build_object(
                $2::text, $3::text,
                $4::text, $5::text
              )
            WHERE id = $1`,
          [
            result.rows[0].id,
            PROVIDER_RETRY_LINEAGE_KEY,
            `review-job:${result.rows[0].id}`,
            REVIEW_INPUT_SEQUENCE_KEY,
            reviewInputSequence,
          ],
        );
      }
      await client.query("COMMIT");
      return result.rows[0] ? Number(result.rows[0].id) : null;
    }

    const providerRetryLineage = validProviderRetryLineage(
      active.payload.providerRetryLineage,
    )
      ? active.payload.providerRetryLineage
      : `review-job:${active.id}`;
    const activePayload: StoredReviewJobPayload = {
      ...active.payload,
      providerRetryLineage,
      reviewInputSequence: validReviewInputSequence(
          active.payload.reviewInputSequence,
        )
        ? active.payload.reviewInputSequence
        : await nextReviewInputSequence(client),
    };
    const recoveryPending = activePayload.recoveryReviewId !== undefined;
    const pendingPayload = activePayload[COALESCED_REVIEW_PAYLOAD_KEY];
    if (
      sameReviewSourceDelivery(activePayload, incomingPayload) ||
      (pendingPayload !== undefined &&
        sameReviewSourceDelivery(pendingPayload, incomingPayload))
    ) {
      await client.query("COMMIT");
      return null;
    }
    const previousRaw = pendingPayload ?? activePayload;
    const previous = {
      ...previousRaw,
      reviewInputSequence: validReviewInputSequence(previousRaw.reviewInputSequence)
        ? previousRaw.reviewInputSequence
        : activePayload.reviewInputSequence,
    };
    const sequencedIncoming = {
      ...incomingPayload,
      reviewInputSequence: await nextReviewInputSequence(client),
    };
    const merged = {
      ...mergeReviewJobPayload(previous, sequencedIncoming),
      providerRetryLineage,
    };
    if (!reviewJobPayloadAdvances(previous, sequencedIncoming)) {
      await client.query("COMMIT");
      return null;
    }
    if (recoveryPending) {
      const stored = {
        ...activePayload,
        [COALESCED_REVIEW_PAYLOAD_KEY]: withoutRecoveryReviewControl(merged),
      };
      const updated = await client.query<{ id: string }>(
        `UPDATE jobs
            SET payload = $2
          WHERE id = $1 AND status = $3
            AND payload IS DISTINCT FROM $2::jsonb
          RETURNING id`,
        [active.id, JSON.stringify(stored), active.status],
      );
      await client.query("COMMIT");
      return updated.rows[0] ? Number(updated.rows[0].id) : null;
    }
    const queuedInputSuperseded =
      active.status === "queued" &&
      pendingReviewInputSupersedes(
        activePayload.expectedPullRequestUpdatedAt,
        merged.expectedPullRequestUpdatedAt,
      );
    if (
      active.status === "queued" &&
      (queuedInputSuperseded ||
        !sameReviewPublicationIdentity(active.payload, merged))
    ) {
      const replacement = await client.query<{ id: string }>(
        `WITH retired AS (
           UPDATE jobs
              SET status = 'done', locked_at = NULL, locked_by = NULL,
                  last_error = 'superseded by newer same-head review metadata'
            WHERE id = $1 AND status = 'queued'
          RETURNING id, max_attempts
         )
         INSERT INTO jobs (
           kind, payload, status, attempts, run_after, max_attempts, created_at
         )
         SELECT 'review', $2, 'queued', 0, clock_timestamp(), max_attempts,
                clock_timestamp()
           FROM retired
         RETURNING id`,
        [active.id, JSON.stringify(merged)],
      );
      await client.query("COMMIT");
      return replacement.rows[0] ? Number(replacement.rows[0].id) : null;
    }
    const stored: StoredReviewJobPayload =
      active.status === "running"
        ? { ...activePayload, [COALESCED_REVIEW_PAYLOAD_KEY]: merged }
        : merged;
    const updated = await client.query<{ id: string }>(
      `UPDATE jobs
          SET payload = $2
        WHERE id = $1 AND status = $3
          AND payload IS DISTINCT FROM $2::jsonb
        RETURNING id`,
      [active.id, JSON.stringify(stored), active.status],
    );
    await client.query("COMMIT");
    return updated.rows[0] ? Number(updated.rows[0].id) : null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface ObservedReviewSnapshot {
  headSha: string;
  baseSha: string;
  updatedAt: string;
  authorGithubId?: number;
  authorLogin?: string;
}

/** Retain the live PR snapshot observed while processing an older queued input. */
export async function enqueueObservedReviewSnapshot(
  pool: Pool,
  payload: ReviewJobPayload,
  observed: ObservedReviewSnapshot,
): Promise<number | null> {
  const {
    sourceDeliveryId: _sourceDeliveryId,
    ...ordinaryPayload
  } = withoutRecoveryReviewControl(payload);
  return enqueueReviewJobOnce(pool, {
    ...ordinaryPayload,
    headSha: observed.headSha,
    baseSha: observed.baseSha,
    expectedPullRequestUpdatedAt: observed.updatedAt,
    ...(observed.authorGithubId !== undefined
      ? { authorGithubId: observed.authorGithubId }
      : {}),
    ...(observed.authorLogin ? { authorLogin: observed.authorLogin } : {}),
  });
}

async function selectActiveReviewJob(
  client: Pick<PoolClient, "query">,
  payload: ReviewJobPayload,
): Promise<{
  id: number;
  status: "queued" | "running";
  payload: StoredReviewJobPayload;
} | null> {
  const result = await client.query<{
    id: string;
    status: "queued" | "running";
    payload: StoredReviewJobPayload;
  }>(
    `SELECT id, status, payload
       FROM jobs
      WHERE kind = 'review'
        AND status IN ('queued', 'running')
        AND (
          payload->>'githubRepoId' = $1
          OR (NOT payload ? 'githubRepoId' AND payload->>'repoFullName' = $2)
        )
        AND payload->>'prNumber' = $3
        AND payload->>'headSha' = $4
      ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, id
      FOR UPDATE
      LIMIT 1`,
    [
      String(payload.githubRepoId),
      payload.repoFullName,
      String(payload.prNumber),
      payload.headSha,
    ],
  );
  const row = result.rows[0];
  return row
    ? { id: Number(row.id), status: row.status, payload: row.payload }
    : null;
}

function reviewJobIdentity(payload: ReviewJobPayload): string {
  return [String(payload.githubRepoId), String(payload.prNumber), payload.headSha].join("\u001f");
}

function sameReviewPublicationIdentity(
  left: ReviewJobPayload,
  right: ReviewJobPayload,
): boolean {
  return left.installationId === right.installationId &&
    left.sourceOrgId === right.sourceOrgId &&
    left.sourceInstallationId === right.sourceInstallationId &&
    left.githubRepoId === right.githubRepoId &&
    left.repoFullName === right.repoFullName &&
    left.prNumber === right.prNumber &&
    left.headSha === right.headSha &&
    left.baseSha === right.baseSha;
}

function sameReviewSourceDelivery(
  left: ReviewJobPayload,
  right: ReviewJobPayload,
): boolean {
  return typeof left.sourceDeliveryId === "string" &&
    left.sourceDeliveryId.length > 0 &&
    left.sourceDeliveryId === right.sourceDeliveryId &&
    left.expectedPullRequestUpdatedAt === right.expectedPullRequestUpdatedAt &&
    sameReviewPublicationIdentity(left, right);
}

function withoutAssignedReviewInputSequence(
  payload: ReviewJobPayload,
): ReviewJobPayload {
  const { reviewInputSequence: _sequence, ...unassigned } = payload;
  return unassigned as ReviewJobPayload;
}

function withoutCoalescedReviewPayload(payload: ReviewJobPayload): ReviewJobPayload {
  const { [COALESCED_REVIEW_PAYLOAD_KEY]: _pending, ...clean } =
    payload as StoredReviewJobPayload;
  return clean as ReviewJobPayload;
}

function withoutRecoveryReviewControl(
  payload: ReviewJobPayload,
): ReviewJobPayload {
  const {
    recoveryReviewId: _recoveryReviewId,
    privateWorkerRehearsalNonce: _privateWorkerRehearsalNonce,
    privateWorkerRehearsalLockedBy: _privateWorkerRehearsalLockedBy,
    privateWorkerRehearsalLockGeneration: _privateWorkerRehearsalLockGeneration,
    ...ordinary
  } = withoutCoalescedReviewPayload(payload);
  return ordinary as ReviewJobPayload;
}

function validReviewEventTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validReviewInputSequence(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
}

async function nextReviewInputSequence(
  client: Pick<PoolClient, "query">,
): Promise<string> {
  const result = await client.query<{ sequence: string }>(
    `SELECT nextval(
       COALESCE(
         to_regclass('review_input_arrival_sequence'),
         pg_get_serial_sequence('jobs', 'id')::regclass
       )
     )::text AS sequence`,
  );
  const sequence = result.rows[0]?.sequence;
  if (!validReviewInputSequence(sequence)) {
    throw new Error("review input sequence allocation returned no value");
  }
  return sequence;
}

export function validProviderRetryLineage(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

export function providerRetryLineageForJob(
  payload: Pick<ReviewJobPayload, "providerRetryLineage">,
  jobId: number,
): string {
  return validProviderRetryLineage(payload.providerRetryLineage)
    ? payload.providerRetryLineage
    : `review-job:${jobId}`;
}

function reviewJobPayloadAdvances(
  previous: ReviewJobPayload,
  incoming: ReviewJobPayload,
): boolean {
  const previousTime = Date.parse(previous.expectedPullRequestUpdatedAt);
  const incomingTime = Date.parse(incoming.expectedPullRequestUpdatedAt);
  if (!Number.isFinite(previousTime)) return true;
  if (incomingTime > previousTime) return true;
  if (
    incomingTime === previousTime &&
    !sameReviewPublicationIdentity(previous, incoming)
  ) {
    return true;
  }
  if (
    incomingTime === previousTime &&
    validReviewInputSequence(previous.reviewInputSequence) &&
    validReviewInputSequence(incoming.reviewInputSequence) &&
    BigInt(incoming.reviewInputSequence) > BigInt(previous.reviewInputSequence) &&
    typeof incoming.sourceDeliveryId === "string" &&
    incoming.sourceDeliveryId.length > 0 &&
    incoming.sourceDeliveryId !== previous.sourceDeliveryId
  ) {
    return true;
  }
  if (incoming.forceFullReview === true && previous.forceFullReview !== true) {
    return true;
  }
  return reviewTriggerPriority(incoming.trigger) > reviewTriggerPriority(previous.trigger);
}

function reviewTriggerPriority(trigger: ReviewJobPayload["trigger"]): number {
  const priorities: Record<ReviewTriggerContext["source"], number> = {
    unknown: 0,
    automatic_pull_request: 1,
    github_check_rerun: 2,
    requested_review: 3,
    finding_reconciliation: 4,
  };
  return priorities[trigger?.source ?? "unknown"];
}

function mergeReviewJobPayload(
  previous: ReviewJobPayload,
  incoming: ReviewJobPayload,
): ReviewJobPayload {
  const previousClean = withoutCoalescedReviewPayload(previous);
  const incomingClean = withoutCoalescedReviewPayload(incoming);
  const previousPriority = reviewTriggerPriority(previousClean.trigger);
  const incomingPriority = reviewTriggerPriority(incomingClean.trigger);
  const trigger = previousPriority > incomingPriority
    ? previousClean.trigger
    : incomingClean.trigger;
  const forceFullReview =
    previousClean.forceFullReview === true || incomingClean.forceFullReview === true;
  const previousTime = Date.parse(previousClean.expectedPullRequestUpdatedAt);
  const incomingTime = Date.parse(incomingClean.expectedPullRequestUpdatedAt);
  const incomingSequenceIsNewer =
    previousTime === incomingTime &&
    validReviewInputSequence(previousClean.reviewInputSequence) &&
    validReviewInputSequence(incomingClean.reviewInputSequence) &&
    BigInt(incomingClean.reviewInputSequence) >
      BigInt(previousClean.reviewInputSequence);
  const authoritative = previousTime > incomingTime ||
      (previousTime === incomingTime && !incomingSequenceIsNewer)
    ? previousClean
    : incomingClean;
  return {
    ...authoritative,
    ...(validProviderRetryLineage(previousClean.providerRetryLineage)
      ? { providerRetryLineage: previousClean.providerRetryLineage }
      : validProviderRetryLineage(incomingClean.providerRetryLineage)
        ? { providerRetryLineage: incomingClean.providerRetryLineage }
        : {}),
    ...(trigger ? { trigger } : {}),
    ...(forceFullReview ? { forceFullReview: true } : {}),
  };
}

export async function claimJob(
  pool: Pool,
  workerId: string,
  allowedKinds: readonly string[],
  options: {
    exactWebhookDispatchDeliveryId?: string;
    excludePrivateWorkerRehearsals?: boolean;
    excludePublicationControllerFencedJobs?: boolean;
  } = {},
): Promise<ClaimedJob | null> {
  const capabilities = [...new Set(allowedKinds.filter(Boolean))];
  if (capabilities.length === 0) {
    throw new Error("claimJob requires at least one allowed job kind");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `WITH expired AS (
         SELECT id
           FROM jobs
          WHERE status = 'queued'
            AND kind = ANY($1::text[])
            AND (
              NOT $2::boolean
              OR payload->>'_postilPublicationControllerFence' IS DISTINCT FROM 'true'
            )
            AND reconciliation_deadline_at IS NOT NULL
            AND reconciliation_deadline_at <= clock_timestamp()
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 100
       ), transitioned AS (
       UPDATE jobs job
          SET status = 'failed', locked_at = NULL, locked_by = NULL,
              last_error = CASE
                WHEN last_error IS NULL
                  THEN 'reconciliation budget exhausted before claim'
                ELSE left(
                  last_error ||
                    ' (reconciliation budget exhausted before claim; failing permanently)',
                  2000
                )
              END,
              run_after = clock_timestamp()
        FROM expired
       WHERE job.id = expired.id
       RETURNING job.id, job.kind, job.payload,
                 job.payload -> $3 AS pending, job.max_attempts
       ), promoted AS (
         INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
         SELECT 'review', jsonb_set(
                  pending, '{providerRetryLineage}',
                  to_jsonb(COALESCE(
                    NULLIF(pending->>'providerRetryLineage', ''),
                    NULLIF(payload->>'providerRetryLineage', ''),
                    'review-job:' || id::text
                  )),
                  true
                ), 'queued', clock_timestamp(), max_attempts
           FROM transitioned
          WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
         RETURNING id
       )
       SELECT count(*) FROM transitioned`,
      [
        capabilities,
        options.excludePublicationControllerFencedJobs === true,
        COALESCED_REVIEW_PAYLOAD_KEY,
      ],
    );
    while (true) {
      const result = await client.query<{
        outcome: "claimed" | "expired" | "suppressed" | "terminalized";
        id: string;
        kind: string | null;
        payload: Record<string, unknown> | null;
        attempts: number | null;
        max_attempts: number | null;
        created_at: Date | null;
        locked_at: Date | null;
        lock_generation: string | null;
      }>(
        `WITH candidate AS MATERIALIZED (
         SELECT id
           FROM jobs
          WHERE status = 'queued'
            AND run_after <= clock_timestamp()
            AND kind = ANY($1::text[])
            AND (
              $2::text IS NULL
              OR (kind = 'webhook-dispatch' AND payload->>'deliveryId' = $2)
            )
            AND (
              NOT $3::boolean
              OR NOT payload ? 'privateWorkerRehearsalNonce'
            )
            AND (
              NOT $4::boolean
              OR payload->>'_postilPublicationControllerFence' IS DISTINCT FROM 'true'
            )
          ORDER BY CASE WHEN kind = 'github-reaction' THEN 0 ELSE 1 END, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       ), admission AS MATERIALIZED (
         SELECT candidate.id, clock_timestamp() AS admitted_at
           FROM candidate
       ), claimed AS (
         UPDATE jobs job
            SET status = 'running', attempts = job.attempts + 1,
                locked_at = admission.admitted_at, locked_by = $5,
                lock_generation = job.lock_generation + 1
           FROM admission
          WHERE job.id = admission.id
            AND job.status = 'queued'
            AND (
              job.reconciliation_deadline_at IS NULL
              OR job.reconciliation_deadline_at > admission.admitted_at
            )
        RETURNING job.id, job.status, job.kind, job.payload, job.attempts,
                  job.max_attempts, job.created_at, job.locked_at,
                  job.lock_generation
       ), expired AS (
         UPDATE jobs job
            SET status = 'failed', locked_at = NULL, locked_by = NULL,
                last_error = CASE
                  WHEN job.last_error IS NULL
                    THEN 'reconciliation budget exhausted before claim'
                  ELSE left(
                    job.last_error ||
                      ' (reconciliation budget exhausted before claim; failing permanently)',
                    2000
                  )
                END,
                run_after = admission.admitted_at
           FROM admission
          WHERE job.id = admission.id
            AND NOT EXISTS (SELECT 1 FROM claimed)
            AND job.status = 'queued'
            AND job.reconciliation_deadline_at IS NOT NULL
            AND job.reconciliation_deadline_at <= admission.admitted_at
        RETURNING job.id, job.kind, job.payload,
                  job.payload -> $6 AS pending, job.max_attempts
       ), promoted AS (
         INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
         SELECT 'review', jsonb_set(
                  expired.pending, '{providerRetryLineage}',
                  to_jsonb(COALESCE(
                    NULLIF(expired.pending->>'providerRetryLineage', ''),
                    NULLIF(expired.payload->>'providerRetryLineage', ''),
                    'review-job:' || expired.id::text
                  )),
                  true
                ), 'queued', admission.admitted_at, expired.max_attempts
           FROM expired
           CROSS JOIN admission
          WHERE expired.kind = 'review'
            AND jsonb_typeof(expired.pending) = 'object'
         RETURNING id
       )
       SELECT 'claimed'::text AS outcome, id, kind, payload, attempts,
              max_attempts, created_at, locked_at,
              lock_generation::text AS lock_generation
         FROM claimed
        WHERE status = 'running'
       UNION ALL
       SELECT 'expired'::text AS outcome, id, NULL::text, NULL::jsonb,
              NULL::integer, NULL::integer, NULL::timestamptz,
              NULL::timestamptz, NULL::text
         FROM expired
       UNION ALL
       SELECT 'terminalized'::text AS outcome, id, NULL::text, NULL::jsonb,
              NULL::integer, NULL::integer, NULL::timestamptz,
              NULL::timestamptz, NULL::text
         FROM claimed
        WHERE status <> 'running'
       UNION ALL
       SELECT 'suppressed'::text AS outcome, id, NULL::text, NULL::jsonb,
              NULL::integer, NULL::integer, NULL::timestamptz,
              NULL::timestamptz, NULL::text
         FROM admission
        WHERE NOT EXISTS (SELECT 1 FROM claimed)
          AND NOT EXISTS (SELECT 1 FROM expired)`,
        [
          capabilities,
          options.exactWebhookDispatchDeliveryId ?? null,
          options.excludePrivateWorkerRehearsals === true,
          options.excludePublicationControllerFencedJobs === true,
          workerId,
          COALESCED_REVIEW_PAYLOAD_KEY,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      if (row.outcome === "suppressed") {
        await client.query(
          `UPDATE jobs
              SET status = 'failed', locked_at = NULL, locked_by = NULL,
                  last_error =
                    'active review claim was suppressed by queue identity enforcement',
                  run_after = clock_timestamp()
            WHERE id = $1 AND status = 'queued'`,
          [row.id],
        );
        continue;
      }
      if (row.outcome !== "claimed") continue;
      if (
        !row.kind ||
        !row.payload ||
        row.attempts === null ||
        row.max_attempts === null ||
        !row.created_at ||
        !row.locked_at ||
        row.lock_generation === null
      ) {
        throw new Error("claimed job returned incomplete lease state");
      }
      await client.query("COMMIT");
      return {
        id: Number(row.id),
        kind: row.kind,
        payload: row.payload,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        createdAt: row.created_at,
        lockedAt: row.locked_at,
        lockGeneration: BigInt(row.lock_generation),
        lockedBy: workerId,
      };
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Claim one due review owned by the sole active or exact recovery release. */
export async function claimPublicationControllerReviewJob(
  pool: Pool,
  workerId: string,
  releaseSha: string,
): Promise<ClaimedJob | null> {
  if (!workerId.trim()) {
    throw new Error(
      "claimPublicationControllerReviewJob requires a worker identity",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
    throw new Error(
      "claimPublicationControllerReviewJob requires a full lowercase release SHA",
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('lock_timeout', $1, true)", [
      `${PUBLICATION_CONTROLLER_CLAIM_LOCK_TIMEOUT_MS}ms`,
    ]);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [QUEUE_LOCK_GENERATION_LOCK],
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [PUBLICATION_CONTROLLER_LOCK],
    );
    await client.query(
      `WITH authority_counts AS MATERIALIZED (
         SELECT (
                  SELECT count(*)::integer
                    FROM deployment_capabilities
                   WHERE name LIKE $3 || '%'
                ) AS active_count,
                EXISTS (
                  SELECT 1 FROM deployment_capabilities active
                  JOIN deployment_capabilities ready ON ready.name = $2
                 WHERE active.name = $1
                ) AS active_exact,
                (
                  SELECT count(*)::integer
                    FROM deployment_capabilities
                   WHERE name LIKE $5 || '%'
                ) AS recovery_count,
                EXISTS (
                  SELECT 1 FROM deployment_capabilities recovery
                  JOIN deployment_capabilities ready ON ready.name = $2
                 WHERE recovery.name = $4
                ) AS recovery_exact,
                EXISTS (
                  SELECT 1 FROM deployment_capabilities WHERE name = $6
                ) AS queue_active
       ), authority AS MATERIALIZED (
         SELECT CASE
                  WHEN active_count = 1 AND active_exact
                    AND recovery_count = 0 AND queue_active THEN 'active'
                  WHEN active_count = 0 AND recovery_count = 1
                    AND recovery_exact THEN 'recovery'
                  ELSE NULL
                END AS mode
           FROM authority_counts
       ), admission AS MATERIALIZED (
         SELECT clock_timestamp() AS admitted_at
       ), expired_candidate AS MATERIALIZED (
         SELECT job.id
           FROM jobs job
           CROSS JOIN authority
           CROSS JOIN admission
          WHERE authority.mode = 'active'
            AND job.kind = 'review'
            AND job.status = 'queued'
            AND job.payload->>$7 = 'true'
            AND job.payload->>$8 = $9
            AND job.reconciliation_deadline_at IS NOT NULL
            AND job.reconciliation_deadline_at <= admission.admitted_at
          ORDER BY job.id
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 100
       ), transitioned AS (
         UPDATE jobs job
            SET status = 'failed', locked_at = NULL, locked_by = NULL,
                last_error = CASE
                  WHEN job.last_error IS NULL
                    THEN 'reconciliation budget exhausted before claim'
                  ELSE left(
                    job.last_error ||
                      ' (reconciliation budget exhausted before claim; failing permanently)',
                    2000
                  )
                END,
                run_after = admission.admitted_at
           FROM expired_candidate
           CROSS JOIN admission
          WHERE job.id = expired_candidate.id
            AND job.status = 'queued'
        RETURNING job.id, job.payload,
                  job.payload -> $10 AS pending, job.max_attempts
       ), promoted AS (
         INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
         SELECT 'review', jsonb_set(
                  transitioned.pending, '{providerRetryLineage}',
                  to_jsonb(COALESCE(
                    NULLIF(transitioned.pending->>'providerRetryLineage', ''),
                    NULLIF(transitioned.payload->>'providerRetryLineage', ''),
                    'review-job:' || transitioned.id::text
                  )),
                  true
                ), 'queued', admission.admitted_at,
                transitioned.max_attempts
           FROM transitioned
           CROSS JOIN admission
          WHERE jsonb_typeof(transitioned.pending) = 'object'
         RETURNING id
       )
       SELECT count(*) FROM transitioned`,
      [
        `${PUBLICATION_CONTROLLER_ACTIVE_PREFIX}${releaseSha}`,
        `${PUBLICATION_CONTROLLER_READY_PREFIX}${releaseSha}`,
        PUBLICATION_CONTROLLER_ACTIVE_PREFIX,
        `${PUBLICATION_CONTROLLER_RECOVERY_PREFIX}${releaseSha}`,
        PUBLICATION_CONTROLLER_RECOVERY_PREFIX,
        QUEUE_LOCK_GENERATION_CAPABILITY,
        PUBLICATION_CONTROLLER_FENCE_KEY,
        PUBLICATION_CONTROLLER_RELEASE_KEY,
        releaseSha,
        COALESCED_REVIEW_PAYLOAD_KEY,
      ],
    );
    const result = await client.query<{
      id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
      created_at: Date;
      locked_at: Date;
      lock_generation: string;
    }>(
      `WITH authority_counts AS MATERIALIZED (
         SELECT (
                  SELECT count(*)::integer
                    FROM deployment_capabilities
                   WHERE name LIKE $3 || '%'
                ) AS active_count,
                EXISTS (
                  SELECT 1 FROM deployment_capabilities active
                  JOIN deployment_capabilities ready ON ready.name = $2
                 WHERE active.name = $1
                ) AS active_exact,
                (
                  SELECT count(*)::integer
                    FROM deployment_capabilities
                   WHERE name LIKE $5 || '%'
                ) AS recovery_count,
                EXISTS (
                  SELECT 1 FROM deployment_capabilities recovery
                  JOIN deployment_capabilities ready ON ready.name = $2
                 WHERE recovery.name = $4
                ) AS recovery_exact,
                EXISTS (
                  SELECT 1 FROM deployment_capabilities WHERE name = $6
                ) AS queue_active
       ), authority AS MATERIALIZED (
         SELECT CASE
                  WHEN active_count = 1 AND active_exact
                    AND recovery_count = 0 AND queue_active THEN 'active'
                  WHEN active_count = 0 AND recovery_count = 1
                    AND recovery_exact THEN 'recovery'
                  ELSE NULL
                END AS mode
           FROM authority_counts
       ), admission AS MATERIALIZED (
         SELECT clock_timestamp() AS admitted_at
       ), candidate AS MATERIALIZED (
         SELECT job.id
           FROM jobs job
           CROSS JOIN authority
           CROSS JOIN admission
           CROSS JOIN LATERAL (
             SELECT CASE
               WHEN jsonb_typeof(job.payload->$10) = 'string'
                 AND pg_input_is_valid(job.payload->>$10, 'timestamptz')
                 THEN (job.payload->>$10)::timestamptz
               ELSE NULL
             END AS controller_run_after
           ) schedule
          WHERE authority.mode IS NOT NULL
            AND job.kind = 'review'
            AND job.status = 'queued'
            AND job.payload->>$7 = 'true'
            AND job.payload->>$8 = $9
            AND (
              authority.mode = 'recovery'
              OR schedule.controller_run_after <= admission.admitted_at
            )
            AND (
              authority.mode = 'recovery'
              OR job.reconciliation_deadline_at IS NULL
              OR job.reconciliation_deadline_at > admission.admitted_at
            )
            AND (
              (
                authority.mode = 'active'
                AND NOT job.payload ? 'recoveryReviewId'
              )
              OR (
                job.payload->>'recoveryReviewId' ~ '^[1-9][0-9]*$'
                AND job.payload->>'reviewInputSequence' ~ '^[1-9][0-9]*$'
                AND EXISTS (
                  SELECT 1
                  FROM review_publication_generations generation
                  WHERE generation.review_id =
                    CASE
                      WHEN job.payload->>'recoveryReviewId' ~ '^[1-9][0-9]*$'
                        THEN (job.payload->>'recoveryReviewId')::bigint
                      ELSE NULL
                    END
                    AND generation.review_input_sequence =
                      CASE
                        WHEN job.payload->>'reviewInputSequence' ~ '^[1-9][0-9]*$'
                          THEN (job.payload->>'reviewInputSequence')::bigint
                        ELSE NULL
                      END
                    AND generation.sealed_at IS NOT NULL
                )
              )
            )
          ORDER BY schedule.controller_run_after, job.id
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
       ), claimed AS (
         UPDATE jobs job
            SET status = 'running', attempts = job.attempts + 1,
                locked_at = admission.admitted_at, locked_by = $11,
                lock_generation = job.lock_generation + 1,
                payload = jsonb_set(
                  job.payload,
                  ARRAY[$12]::text[],
                  to_jsonb($9::text),
                  true
                )
           FROM candidate
           CROSS JOIN admission
           CROSS JOIN authority
          WHERE job.id = candidate.id AND job.status = 'queued'
            AND (
              authority.mode = 'recovery'
              OR job.reconciliation_deadline_at IS NULL
              OR job.reconciliation_deadline_at > admission.admitted_at
            )
        RETURNING job.id, job.status, job.kind, job.payload, job.attempts,
                  job.max_attempts, job.created_at, job.locked_at,
                  job.lock_generation
       )
       SELECT id, kind, payload, attempts, max_attempts, created_at,
              locked_at, lock_generation::text AS lock_generation
         FROM claimed
        WHERE status = 'running'`,
      [
        `${PUBLICATION_CONTROLLER_ACTIVE_PREFIX}${releaseSha}`,
        `${PUBLICATION_CONTROLLER_READY_PREFIX}${releaseSha}`,
        PUBLICATION_CONTROLLER_ACTIVE_PREFIX,
        `${PUBLICATION_CONTROLLER_RECOVERY_PREFIX}${releaseSha}`,
        PUBLICATION_CONTROLLER_RECOVERY_PREFIX,
        QUEUE_LOCK_GENERATION_CAPABILITY,
        PUBLICATION_CONTROLLER_FENCE_KEY,
        PUBLICATION_CONTROLLER_RELEASE_KEY,
        releaseSha,
        PUBLICATION_CONTROLLER_RUN_AFTER_KEY,
        workerId,
        PUBLICATION_CONTROLLER_CLAIM_KEY,
      ],
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      lockedAt: row.locked_at,
      lockGeneration: BigInt(row.lock_generation),
      lockedBy: workerId,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Mark a job done. Scoped by the exact running claim so
 * a worker finishing late cannot stamp `done` over a job the watchdog already
 * requeued and a second worker re-claimed under a new generation (which would
 * mask a concurrent double-run). Only the current lease holder can complete
 * the row.
 */
export async function completeJob(
  pool: Pool,
  job: Pick<ClaimedJob, "id" | "lockGeneration" | "lockedBy">,
): Promise<"done" | "coalesced" | "lost"> {
  const result = await pool.query<{ outcome: "done" | "coalesced" | "lost" }>(
    `WITH transitioned AS (
       UPDATE jobs
          SET status = 'done', locked_at = NULL, locked_by = NULL,
              last_error = NULL
        WHERE id = $1 AND status = 'running'
          AND locked_by = $2 AND lock_generation = $3
      RETURNING id, kind, payload -> $4 AS pending, max_attempts
     ), inserted AS (
       INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       SELECT 'review', jsonb_set(
                pending, '{providerRetryLineage}',
                to_jsonb(COALESCE(NULLIF(pending->>'providerRetryLineage', ''), 'review-job:' || id::text)),
                true
              ), 'queued', now(), max_attempts
         FROM transitioned
        WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
       RETURNING id
     )
     SELECT CASE
       WHEN EXISTS (SELECT 1 FROM inserted) THEN 'coalesced'
       WHEN EXISTS (SELECT 1 FROM transitioned) THEN 'done'
       ELSE 'lost'
     END AS outcome`,
    [job.id, job.lockedBy, job.lockGeneration, COALESCED_REVIEW_PAYLOAD_KEY],
  );
  return result.rows[0]?.outcome ?? "lost";
}

export async function continueClaimedJob(
  pool: Pool,
  job: Pick<ClaimedJob, "id" | "lockGeneration" | "lockedBy">,
  payload: Record<string, unknown>,
  options: { runAfter?: Date } = {},
): Promise<void> {
  const result = await pool.query(
    `UPDATE jobs
        SET payload = $3, status = 'queued', attempts = 0,
            run_after = COALESCE($4, now()), locked_at = NULL,
            locked_by = NULL, last_error = NULL
      WHERE id = $1 AND status = 'running'
        AND locked_by = $2 AND lock_generation = $5`,
    [
      job.id,
      job.lockedBy,
      JSON.stringify(payload),
      options.runAfter ?? null,
      job.lockGeneration,
    ],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error("job continuation lost its lease");
  }
}

/** Requeue exact claims held by a stopping worker without consuming an attempt. */
export async function requeueClaimedJobs(
  pool: Pool,
  reason: string,
  kinds: readonly string[],
  leases: readonly JobLease[],
): Promise<number> {
  const allowedKinds = [...new Set(kinds.filter(Boolean))];
  if (allowedKinds.length === 0) {
    throw new Error("requeueClaimedJobs requires at least one safe job kind");
  }
  const exactLeases = [
    ...new Map(
      leases.map((lease) => [
        `${lease.id}:${lease.lockGeneration}:${lease.lockedBy}`,
        lease,
      ]),
    ).values(),
  ];
  for (const lease of exactLeases) {
    if (!Number.isSafeInteger(lease.id) || lease.id <= 0) {
      throw new Error("requeueClaimedJobs requires positive safe job ids");
    }
    if (!lease.lockedBy) {
      throw new Error("requeueClaimedJobs requires an exact lock owner");
    }
    if (lease.lockGeneration <= 0n) {
      throw new Error("requeueClaimedJobs requires a positive lock generation");
    }
  }
  if (exactLeases.length === 0) return 0;
  const redactedReason = redactAndTruncate(reason, 2000);
  const result = await pool.query<{ count: string }>(
    `WITH requested AS MATERIALIZED (
       SELECT id, locked_by, lock_generation
         FROM unnest($1::bigint[], $2::text[], $3::bigint[])
           AS lease(id, locked_by, lock_generation)
     ), transitioned AS (
       UPDATE jobs job
          SET status = CASE
                WHEN job.kind = 'review' AND jsonb_typeof(job.payload -> $6) = 'object'
                  THEN 'done'::job_status
                ELSE 'queued'::job_status
              END,
              attempts = CASE
                WHEN job.kind = 'review' AND jsonb_typeof(job.payload -> $6) = 'object'
                  THEN job.attempts
                ELSE GREATEST(job.attempts - 1, 0)
              END,
              locked_at = NULL, locked_by = NULL,
              last_error = $4,
              run_after = now()
         FROM requested
        WHERE job.status = 'running'
          AND job.id = requested.id
          AND job.locked_by = requested.locked_by
          AND job.lock_generation = requested.lock_generation
          AND job.kind = ANY($5::text[])
      RETURNING job.id, job.kind, job.payload -> $6 AS pending, job.max_attempts
     ), inserted AS (
       INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       SELECT 'review', jsonb_set(
                pending, '{providerRetryLineage}',
                to_jsonb(COALESCE(NULLIF(pending->>'providerRetryLineage', ''), 'review-job:' || id::text)),
                true
              ), 'queued', now(), max_attempts
         FROM transitioned
        WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
       RETURNING id
     )
     SELECT count(*)::text AS count FROM transitioned`,
    [
      exactLeases.map((lease) => String(lease.id)),
      exactLeases.map((lease) => lease.lockedBy),
      exactLeases.map((lease) => String(lease.lockGeneration)),
      redactedReason,
      allowedKinds,
      COALESCED_REVIEW_PAYLOAD_KEY,
    ],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 15 * 60_000);
}

/**
 * Mark a job failed; requeue with backoff while attempts remain.
 *
 * Returns "coalesced" when a pending review intent replaces this attempt,
 * "retried" for an ordinary retry, "failed" for the permanent transition,
 * or "lost" when another path already owns the row. Both retry and final
 * transitions are conditioned on `status = 'running'`, so a late caller
 * cannot resurrect or re-fail work owned by another worker.
 *
 * Pass `opts.permanent` for a deterministic, non-retryable error (e.g. a
 * broken CA store or a missing CLI binary). Without retained review intent,
 * the job goes straight to `failed` because retrying the same work against the
 * same image would fail identically. Retained intent becomes a fresh queued
 * job, preserving the immutable publication identity of the failed attempt.
 */
export async function failJob(
  pool: Pool,
  job: Pick<
    ClaimedJob,
    "id" | "attempts" | "maxAttempts" | "lockGeneration" | "lockedBy"
  >,
  error: string,
  opts: {
    permanent?: boolean;
    failureFollowup?: {
      kind: "respond-failure-comment";
      payload: Record<string, unknown>;
      maxAttempts: number;
    };
  } = {},
): Promise<"retried" | "failed" | "coalesced" | "lost"> {
  const redactedError = redactAndTruncate(error, 2000);
  if (!opts.permanent && job.attempts < job.maxAttempts) {
    const delay = backoffMs(job.attempts);
    // Guarded by the exact running claim (mirroring the final-fail path below).
    // If the watchdog already requeued this stalled job and a second worker
    // re-claimed it (`status` now 'queued' or 'running' under a newer
    // generation), a late transient retry from the original worker must not
    // reset it back to 'queued'. That would resurrect a job another worker owns
    // and let a third worker run it concurrently. rowCount 0 means this caller
    // lost the row, so report "lost" and do not resurrect it.
    const res = await pool.query<{ outcome: "coalesced" | "retried" | "lost" }>(
      `WITH transitioned AS (
         UPDATE jobs
            SET status = CASE
                  WHEN kind = 'review' AND jsonb_typeof(payload -> $6) = 'object'
                    THEN 'failed'::job_status
                  ELSE 'queued'::job_status
                END,
                locked_at = NULL, locked_by = NULL,
                last_error = $2,
                run_after = CASE
                  WHEN kind = 'review' AND jsonb_typeof(payload -> $6) = 'object'
                    THEN now()
                  ELSE now() + ($3 || ' milliseconds')::interval
                END
          WHERE id = $1 AND status = 'running'
            AND locked_by = $4 AND lock_generation = $5
        RETURNING id, status, kind, payload -> $6 AS pending, max_attempts
       ), inserted AS (
         INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
         SELECT 'review', jsonb_set(
                  pending, '{providerRetryLineage}',
                  to_jsonb(COALESCE(NULLIF(pending->>'providerRetryLineage', ''), 'review-job:' || id::text)),
                  true
                ), 'queued', now(), max_attempts
           FROM transitioned
          WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
         RETURNING id
       )
       SELECT CASE
         WHEN EXISTS (SELECT 1 FROM inserted) THEN 'coalesced'
         WHEN EXISTS (SELECT 1 FROM transitioned WHERE status = 'queued') THEN 'retried'
         ELSE 'lost'
       END AS outcome`,
      [
        job.id,
        redactedError,
        String(delay),
        job.lockedBy,
        job.lockGeneration,
        COALESCED_REVIEW_PAYLOAD_KEY,
      ],
    );
    return res.rows[0]?.outcome ?? "lost";
  }
  // Conditional transition (reached on exhausted attempts or a permanent
  // error): only the caller that flips `running` -> `failed` gets rowCount 1.
  // If the watchdog already failed this job (worker died mid-run), this
  // affects 0 rows. The winner is the single owner of any follow-up side
  // effect (e.g. posting a user-facing failure comment).
  const res = opts.failureFollowup
    ? await pool.query<{ outcome: "coalesced" | "failed" | "lost" }>(
        `WITH transitioned AS (
           UPDATE jobs
              SET status = 'failed',
                  locked_at = NULL, locked_by = NULL,
                  last_error = $2, run_after = now()
            WHERE id = $1 AND status = 'running'
              AND locked_by = $3 AND lock_generation = $4
          RETURNING id, status, kind, payload -> $5 AS pending, max_attempts
         ), inserted_review AS (
           INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
           SELECT 'review', jsonb_set(
                    pending, '{providerRetryLineage}',
                    to_jsonb(COALESCE(NULLIF(pending->>'providerRetryLineage', ''), 'review-job:' || id::text)),
                    true
                  ), 'queued', now(), max_attempts
             FROM transitioned
            WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
           RETURNING id
         ), inserted_followup AS (
         INSERT INTO jobs (kind, payload, max_attempts)
         SELECT $6, $7::jsonb, $8
           FROM transitioned
          WHERE status = 'failed'
            AND NOT (kind = 'review' AND jsonb_typeof(pending) = 'object')
         RETURNING id
         )
         SELECT CASE
           WHEN EXISTS (SELECT 1 FROM inserted_review) THEN 'coalesced'
           WHEN EXISTS (SELECT 1 FROM transitioned WHERE status = 'failed') THEN 'failed'
           ELSE 'lost'
         END AS outcome`,
        [
          job.id,
          redactedError,
          job.lockedBy,
          job.lockGeneration,
          COALESCED_REVIEW_PAYLOAD_KEY,
          opts.failureFollowup.kind,
          JSON.stringify(opts.failureFollowup.payload),
          opts.failureFollowup.maxAttempts,
        ],
      )
    : await pool.query<{ outcome: "coalesced" | "failed" | "lost" }>(
        `WITH transitioned AS (
           UPDATE jobs
              SET status = 'failed',
                  locked_at = NULL, locked_by = NULL,
                  last_error = $2, run_after = now()
            WHERE id = $1 AND status = 'running'
              AND locked_by = $3 AND lock_generation = $4
          RETURNING id, status, kind, payload -> $5 AS pending, max_attempts
         ), inserted AS (
           INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
           SELECT 'review', jsonb_set(
                    pending, '{providerRetryLineage}',
                    to_jsonb(COALESCE(NULLIF(pending->>'providerRetryLineage', ''), 'review-job:' || id::text)),
                    true
                  ), 'queued', now(), max_attempts
             FROM transitioned
            WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
           RETURNING id
         )
         SELECT CASE
           WHEN EXISTS (SELECT 1 FROM inserted) THEN 'coalesced'
           WHEN EXISTS (SELECT 1 FROM transitioned WHERE status = 'failed') THEN 'failed'
           ELSE 'lost'
         END AS outcome`,
        [
          job.id,
          redactedError,
          job.lockedBy,
          job.lockGeneration,
          COALESCED_REVIEW_PAYLOAD_KEY,
        ],
      );
  return (res.rows[0] as { outcome?: "coalesced" | "failed" | "lost" } | undefined)
    ?.outcome ?? "lost";
}

/**
 * Wall-clock ceiling on indefinite reconciliation (a job that ignores
 * `max_attempts` because it is waiting out a forge outage rather than
 * retrying its own work). Indefinite retry exists to survive that outage,
 * not to retry forever, so it is bounded by elapsed time since the job was
 * first created rather than by attempt count.
 */
export const PUBLICATION_RECONCILIATION_BUDGET_MS = readPositiveIntEnv(
  "POSTIL_PUBLICATION_RECONCILIATION_BUDGET_MS",
  60 * 60 * 1000,
);

/**
 * Requeue reconciliation work until its target state is superseded or
 * published, or until `budgetMs` has elapsed since the job was created. A
 * retained review input always replaces the stale attempt with one fresh
 * queued job. Without retained input, ordinary retries preserve their backoff
 * and exhaustion makes the attempt terminal.
 */
export async function retryJobIndefinitely(
  pool: Pool,
  job: Pick<ClaimedJob, "id" | "attempts" | "lockGeneration" | "lockedBy">,
  error: string,
  budgetMs: number = PUBLICATION_RECONCILIATION_BUDGET_MS,
): Promise<"retried" | "coalesced" | "lost" | "exhausted"> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) {
    throw new TypeError("reconciliation budget must be a positive safe integer");
  }
  const redactedError = redactAndTruncate(error, 2000);
  const budgetMessage = redactAndTruncate(
    `${error} (reconciliation budget of ${Math.round(budgetMs / 60_000)} minute(s) exhausted; failing permanently)`,
    2000,
  );
  const delay = backoffMs(job.attempts);
  const res = await pool.query<{
    outcome: "coalesced" | "retried" | "exhausted" | "lost";
  }>(
    `WITH claimed AS MATERIALIZED (
       SELECT id, kind, payload, max_attempts,
              COALESCE(
                reconciliation_deadline_at,
                created_at + ($5 || ' milliseconds')::interval
              ) AS deadline_at,
              clock_timestamp() AS database_now
         FROM jobs
        WHERE id = $1
          AND status = 'running'
          AND locked_by = $3
          AND lock_generation = $4
        FOR UPDATE
     ), decision AS MATERIALIZED (
       SELECT *,
              database_now + ($6 || ' milliseconds')::interval < deadline_at
                AS retry_within_budget,
              kind = 'review' AND jsonb_typeof(payload -> $7) = 'object'
                AS has_pending_review,
              kind = 'review' AND payload ? 'recoveryReviewId'
                AS is_publication_recovery
         FROM claimed
     ), transitioned AS (
       UPDATE jobs job
          SET status = CASE
                WHEN decision.has_pending_review
                  AND (NOT decision.is_publication_recovery OR NOT decision.retry_within_budget)
                  THEN 'failed'::job_status
                WHEN decision.retry_within_budget
                  THEN 'queued'::job_status
                ELSE 'failed'::job_status
              END,
              locked_at = NULL,
              locked_by = NULL,
              last_error = CASE
                WHEN decision.retry_within_budget
                  OR (
                    decision.has_pending_review
                    AND NOT decision.is_publication_recovery
                  )
                  THEN $2
                ELSE $8
              END,
              run_after = CASE
                WHEN decision.retry_within_budget
                  AND (
                    NOT decision.has_pending_review
                    OR decision.is_publication_recovery
                  )
                  THEN decision.database_now + ($6 || ' milliseconds')::interval
                ELSE decision.database_now
              END,
              reconciliation_deadline_at = decision.deadline_at
         FROM decision
        WHERE job.id = decision.id
          AND job.status = 'running'
          AND job.locked_by = $3
          AND job.lock_generation = $4
      RETURNING job.id, job.status, decision.kind, decision.payload,
                decision.payload -> $7 AS pending,
                decision.max_attempts,
                decision.retry_within_budget,
                decision.has_pending_review,
                decision.is_publication_recovery
     ), inserted AS (
       INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       SELECT 'review', jsonb_set(
                pending, '{providerRetryLineage}',
                to_jsonb(COALESCE(
                  NULLIF(pending->>'providerRetryLineage', ''),
                  NULLIF(payload->>'providerRetryLineage', ''),
                  'review-job:' || id::text
                )),
                true
              ), 'queued', clock_timestamp(), max_attempts
         FROM transitioned
        WHERE has_pending_review
          AND (NOT is_publication_recovery OR NOT retry_within_budget)
       RETURNING id
     )
     SELECT CASE
       WHEN EXISTS (SELECT 1 FROM inserted) THEN 'coalesced'
       WHEN EXISTS (
         SELECT 1 FROM transitioned
          WHERE status = 'queued' AND retry_within_budget
       ) THEN 'retried'
       WHEN EXISTS (SELECT 1 FROM transitioned WHERE status = 'failed') THEN 'exhausted'
       ELSE 'lost'
     END AS outcome`,
    [
      job.id,
      redactedError,
      job.lockedBy,
      job.lockGeneration,
      String(budgetMs),
      String(delay),
      COALESCED_REVIEW_PAYLOAD_KEY,
      budgetMessage,
    ],
  );
  return res.rows[0]?.outcome ?? "lost";
}

export async function queueDepth(pool: Pool): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs WHERE status = 'queued'`,
  );
  return Number(res.rows[0]?.count ?? 0);
}
