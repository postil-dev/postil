import type { Pool, PoolClient } from "pg";

import { readNonNegativeIntEnv, readPositiveIntEnv } from "@/lib/env";
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
 * Fairness: a claim skips a `review` or `respond` job whose organization
 * already runs `WORKER_PER_ORG_CONCURRENCY` such jobs, so one organization
 * opening many pull requests at once cannot occupy every worker slot. The cap
 * is best-effort: concurrent claim loops read the running count before any of
 * them commits, so an organization can exceed the cap by up to the number of
 * claim loops. Jobs of other kinds and jobs without an organization carry no
 * cap. A cap of 0 disables the limit.
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
  sourceDeliveryId?: string;
  /** Optional only for jobs queued by an older release during a rolling deploy. */
  trigger?: ReviewTriggerContext;
  /** Use the complete base-to-head diff even when a completed baseline exists. */
  forceFullReview?: boolean;
  /** Durable pointer written after the CLI result and publication receipt are staged. */
  recoveryReviewId?: number;
  /** Private marker that prevents a web-process queue drain from claiming a rehearsal recovery. */
  privateWorkerRehearsalNonce?: string;
}

export const COALESCED_REVIEW_PAYLOAD_KEY = "_postilCoalescedReviewPayload";

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

export interface ExternalSideEffectLease {
  id: number;
  lockedBy: string;
  lockedAt: Date;
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
        AND locked_at = $3
      LIMIT 1`,
    [lease.id, lease.lockedBy, lease.lockedAt],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Revoke every publication path bound to one exact pull request identity. */
export async function cancelPullRequestPublication(
  pool: Pick<Pool, "query">,
  input: {
    installationId: number;
    sourceInstallationId: number;
    sourceOrgId: number;
    githubRepoId: number;
    repoFullName: string;
    prNumber: number;
  },
): Promise<number> {
  const result = await pool.query(
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
  return result.rowCount ?? 0;
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

export interface HostedKeyProvisionJobPayload extends Record<string, unknown> {
  orgId: number;
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
 * review is retained as one coalesced rerun payload on that job.
 */
export async function enqueueReviewJobOnce(
  pool: Pool,
  payload: ReviewJobPayload,
): Promise<number | null> {
  if (!Number.isSafeInteger(payload.githubRepoId) || payload.githubRepoId <= 0) {
    throw new TypeError("review job requires a positive GitHub repository ID");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const identity = reviewJobIdentity(payload);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `postil:review-pr:${[String(payload.githubRepoId), String(payload.prNumber)].join("\u001f")}`,
    ]);
    // Serialize with writers from releases that still key the active-review
    // lock by repository name. The database trigger independently enforces the
    // stable repository-ID identity for every writer during the rollout.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `postil:active-review:${[
        payload.repoFullName,
        String(payload.prNumber),
        payload.headSha,
      ].join("\u001f")}`,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `postil:active-review:${identity}`,
    ]);
    const active = await selectActiveReviewJob(client, payload);
    if (!active) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
         VALUES ('review', $1, 'queued', now(), 3)
         RETURNING id`,
        [JSON.stringify(withoutCoalescedReviewPayload(payload))],
      );
      await client.query("COMMIT");
      return result.rows[0] ? Number(result.rows[0].id) : null;
    }

    const previous =
      active.status === "running"
        ? (active.payload[COALESCED_REVIEW_PAYLOAD_KEY] ?? active.payload)
        : active.payload;
    const merged = mergeReviewJobPayload(previous, payload);
    if (
      active.status === "queued" &&
      !sameReviewPublicationIdentity(active.payload, merged)
    ) {
      const replacement = await client.query<{ id: string }>(
        `WITH retired AS (
           UPDATE jobs
              SET status = 'done', locked_at = NULL, locked_by = NULL,
                  last_error = 'superseded by newer same-head review metadata'
            WHERE id = $1 AND status = 'queued'
          RETURNING id, max_attempts
         )
         INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
         SELECT 'review', $2, 'queued', now(), max_attempts FROM retired
         RETURNING id`,
        [active.id, JSON.stringify(merged)],
      );
      await client.query("COMMIT");
      return replacement.rows[0] ? Number(replacement.rows[0].id) : null;
    }
    const stored: StoredReviewJobPayload =
      active.status === "running"
        ? { ...active.payload, [COALESCED_REVIEW_PAYLOAD_KEY]: merged }
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

function withoutCoalescedReviewPayload(payload: ReviewJobPayload): ReviewJobPayload {
  const { [COALESCED_REVIEW_PAYLOAD_KEY]: _pending, ...clean } =
    payload as StoredReviewJobPayload;
  return clean as ReviewJobPayload;
}

function mergeReviewJobPayload(
  previous: ReviewJobPayload,
  incoming: ReviewJobPayload,
): ReviewJobPayload {
  const previousClean = withoutCoalescedReviewPayload(previous);
  const incomingClean = withoutCoalescedReviewPayload(incoming);
  const triggerPriority: Record<ReviewTriggerContext["source"], number> = {
    unknown: 0,
    automatic_pull_request: 1,
    github_check_rerun: 2,
    requested_review: 3,
  };
  const previousPriority = triggerPriority[previousClean.trigger?.source ?? "unknown"];
  const incomingPriority = triggerPriority[incomingClean.trigger?.source ?? "unknown"];
  const trigger = previousPriority > incomingPriority
    ? previousClean.trigger
    : incomingClean.trigger;
  const forceFullReview =
    previousClean.forceFullReview === true || incomingClean.forceFullReview === true;
  return {
    ...incomingClean,
    ...(trigger ? { trigger } : {}),
    ...(forceFullReview ? { forceFullReview: true } : {}),
  };
}

/**
 * Spend-bearing kinds. Only these carry the per-organization cap, both as the
 * candidate being claimed and as the running work counted against the budget;
 * every other kind is cheap and stays claimable at any depth.
 */
const ORGANIZATION_BUDGETED_JOB_KINDS = ["review", "respond"] as const;

const PER_ORGANIZATION_CONCURRENCY = readNonNegativeIntEnv(
  "WORKER_PER_ORG_CONCURRENCY",
  2,
);

export async function claimJob(
  pool: Pool,
  workerId: string,
  allowedKinds: readonly string[],
  options: {
    exactWebhookDispatchDeliveryId?: string;
    excludePrivateWorkerRehearsals?: boolean;
    /** Per-organization running-job cap; 0 disables it. Defaults to WORKER_PER_ORG_CONCURRENCY. */
    perOrganizationConcurrency?: number;
  } = {},
): Promise<ClaimedJob | null> {
  const capabilities = [...new Set(allowedKinds.filter(Boolean))];
  if (capabilities.length === 0) {
    throw new Error("claimJob requires at least one allowed job kind");
  }
  const perOrganizationConcurrency =
    options.perOrganizationConcurrency ?? PER_ORGANIZATION_CONCURRENCY;
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
       FROM jobs candidate
       WHERE status = 'queued'
         AND run_after <= now()
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
           $4::int <= 0
           OR NOT (kind = ANY($5::text[]))
           OR candidate.payload->>'sourceOrgId' IS NULL
           OR (
             SELECT count(*)
               FROM jobs running
              WHERE running.status = 'running'
                AND running.kind = ANY($5::text[])
                AND running.payload->>'sourceOrgId'
                    = candidate.payload->>'sourceOrgId'
           ) < $4::int
         )
       ORDER BY CASE WHEN kind = 'github-reaction' THEN 0 ELSE 1 END, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [
        capabilities,
        options.exactWebhookDispatchDeliveryId ?? null,
        options.excludePrivateWorkerRehearsals === true,
        perOrganizationConcurrency,
        [...ORGANIZATION_BUDGETED_JOB_KINDS],
      ],
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const claimed = await client.query<{ locked_at: Date }>(
      `UPDATE jobs
       SET status = 'running', attempts = attempts + 1,
           locked_at = date_trunc('milliseconds', clock_timestamp()), locked_by = $2
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
): Promise<"done" | "coalesced" | "lost"> {
  const result = await pool.query<{ outcome: "done" | "coalesced" | "lost" }>(
    `WITH transitioned AS (
       UPDATE jobs
          SET status = 'done', locked_at = NULL, locked_by = NULL,
              last_error = NULL
        WHERE id = $1 AND status = 'running' AND locked_by = $2
      RETURNING kind, payload -> $3 AS pending, max_attempts
     ), inserted AS (
       INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       SELECT 'review', pending, 'queued', now(), max_attempts
         FROM transitioned
        WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
       RETURNING id
     )
     SELECT CASE
       WHEN EXISTS (SELECT 1 FROM inserted) THEN 'coalesced'
       WHEN EXISTS (SELECT 1 FROM transitioned) THEN 'done'
       ELSE 'lost'
     END AS outcome`,
    [job.id, job.lockedBy, COALESCED_REVIEW_PAYLOAD_KEY],
  );
  return result.rows[0]?.outcome ?? "lost";
}

export async function continueClaimedJob(
  pool: Pool,
  job: Pick<ClaimedJob, "id" | "lockedBy">,
  payload: Record<string, unknown>,
  options: { runAfter?: Date } = {},
): Promise<void> {
  const result = await pool.query(
    `UPDATE jobs
        SET payload = $3, status = 'queued', attempts = 0,
            run_after = COALESCE($4, now()), locked_at = NULL,
            locked_by = NULL, last_error = NULL
      WHERE id = $1 AND status = 'running' AND locked_by = $2`,
    [job.id, job.lockedBy, JSON.stringify(payload), options.runAfter ?? null],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error("job continuation lost its lease");
  }
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
  const result = await pool.query<{ count: string }>(
    `WITH transitioned AS (
       UPDATE jobs
          SET status = CASE
                WHEN kind = 'review' AND jsonb_typeof(payload -> $5) = 'object'
                  THEN 'done'::job_status
                ELSE 'queued'::job_status
              END,
              attempts = CASE
                WHEN kind = 'review' AND jsonb_typeof(payload -> $5) = 'object'
                  THEN attempts
                ELSE GREATEST(attempts - 1, 0)
              END,
              locked_at = NULL, locked_by = NULL,
              last_error = $2,
              run_after = now()
        WHERE status = 'running'
          AND left(locked_by, length($1)) = $1
          AND kind = ANY($3::text[])
          AND id = ANY($4::bigint[])
      RETURNING kind, payload -> $5 AS pending, max_attempts
     ), inserted AS (
       INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
       SELECT 'review', pending, 'queued', now(), max_attempts
         FROM transitioned
        WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
       RETURNING id
     )
     SELECT count(*)::text AS count FROM transitioned`,
    [
      lockedByPrefix,
      redactedReason,
      allowedKinds,
      ownedJobIds,
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
  job: Pick<ClaimedJob, "id" | "attempts" | "maxAttempts" | "lockedBy">,
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
    // Guarded by `status = 'running'` (mirroring the final-fail path below).
    // If the watchdog already requeued this stalled job and a second worker
    // re-claimed it (`status` now 'queued' or 'running' under a new owner with
    // a higher attempt count), a late transient-retry from the original worker
    // must NOT reset it back to 'queued': that would resurrect a job another
    // worker owns and let a third worker run it concurrently (double review /
    // reply / check-runs / LLM spend). rowCount 0 means we lost the row; report
    // "lost" and do not resurrect it.
    const res = await pool.query<{ outcome: "coalesced" | "retried" | "lost" }>(
      `WITH transitioned AS (
         UPDATE jobs
            SET status = CASE
                  WHEN kind = 'review' AND jsonb_typeof(payload -> $5) = 'object'
                    THEN 'failed'::job_status
                  ELSE 'queued'::job_status
                END,
                locked_at = NULL, locked_by = NULL,
                last_error = $2,
                run_after = CASE
                  WHEN kind = 'review' AND jsonb_typeof(payload -> $5) = 'object'
                    THEN now()
                  ELSE now() + ($3 || ' milliseconds')::interval
                END
          WHERE id = $1 AND status = 'running' AND locked_by = $4
        RETURNING status, kind, payload -> $5 AS pending, max_attempts
       ), inserted AS (
         INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
         SELECT 'review', pending, 'queued', now(), max_attempts
           FROM transitioned
          WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
         RETURNING id
       )
       SELECT CASE
         WHEN EXISTS (SELECT 1 FROM inserted) THEN 'coalesced'
         WHEN EXISTS (SELECT 1 FROM transitioned WHERE status = 'queued') THEN 'retried'
         ELSE 'lost'
       END AS outcome`,
      [job.id, redactedError, String(delay), job.lockedBy, COALESCED_REVIEW_PAYLOAD_KEY],
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
            WHERE id = $1 AND status = 'running' AND locked_by = $3
          RETURNING status, kind, payload -> $4 AS pending, max_attempts
         ), inserted_review AS (
           INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
           SELECT 'review', pending, 'queued', now(), max_attempts
             FROM transitioned
            WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
           RETURNING id
         ), inserted_followup AS (
         INSERT INTO jobs (kind, payload, max_attempts)
         SELECT $5, $6::jsonb, $7
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
            WHERE id = $1 AND status = 'running' AND locked_by = $3
          RETURNING status, kind, payload -> $4 AS pending, max_attempts
         ), inserted AS (
           INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
           SELECT 'review', pending, 'queued', now(), max_attempts
             FROM transitioned
            WHERE kind = 'review' AND jsonb_typeof(pending) = 'object'
           RETURNING id
         )
         SELECT CASE
           WHEN EXISTS (SELECT 1 FROM inserted) THEN 'coalesced'
           WHEN EXISTS (SELECT 1 FROM transitioned WHERE status = 'failed') THEN 'failed'
           ELSE 'lost'
         END AS outcome`,
        [job.id, redactedError, job.lockedBy, COALESCED_REVIEW_PAYLOAD_KEY],
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
 * published, or until `budgetMs` has elapsed since the job was created. Past
 * the budget the job fails permanently instead of requeuing: a forge outage
 * long enough to exceed it needs operator attention, not another retry.
 */
export async function retryJobIndefinitely(
  pool: Pool,
  job: Pick<ClaimedJob, "id" | "attempts" | "lockedBy" | "createdAt">,
  error: string,
  budgetMs: number = PUBLICATION_RECONCILIATION_BUDGET_MS,
): Promise<"retried" | "lost" | "exhausted"> {
  const redactedError = redactAndTruncate(error, 2000);
  const elapsedMs = Date.now() - job.createdAt.getTime();
  if (elapsedMs > budgetMs) {
    const budgetMessage = redactAndTruncate(
      `${error} (reconciliation budget of ${Math.round(budgetMs / 60_000)} minute(s) exhausted after ${Math.round(elapsedMs / 60_000)} minute(s); failing permanently)`,
      2000,
    );
    const res = await pool.query(
      `UPDATE jobs
       SET status = 'failed', locked_at = NULL, locked_by = NULL,
           last_error = $2, run_after = now()
       WHERE id = $1 AND status = 'running' AND locked_by = $3`,
      [job.id, budgetMessage, job.lockedBy],
    );
    return (res.rowCount ?? 0) > 0 ? "exhausted" : "lost";
  }
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
