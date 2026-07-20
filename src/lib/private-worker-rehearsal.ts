import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { optionalEnv } from "@/lib/env";

const MAX_ARMING_WINDOW_MS = 10 * 60 * 1_000;
const MIN_ARMING_WINDOW_MS = 60 * 1_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PrivateWorkerRehearsalSandbox {
  orgSlug: string;
  repoFullName: string;
}

export interface PrivateWorkerRehearsalTarget extends PrivateWorkerRehearsalSandbox {
  prNumber: number;
  headSha: string;
  reviewPublicId: string;
}

export interface ArmPrivateWorkerRehearsalInput extends PrivateWorkerRehearsalTarget {
  nonce: string;
  operatorGithubId: number;
  expiresAt: Date;
  now?: Date;
}

export interface StagedPrivateWorkerRehearsalInput {
  reviewId: number;
  reviewJobId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  workerInstanceId: string;
  now?: Date;
  sandbox?: PrivateWorkerRehearsalSandbox | null;
}

export interface PrivateWorkerRehearsalReconciliation {
  replacementsVerified: number;
  jobsRequeued: number;
  rehearsalsCompleted: number;
  rehearsalsExpired: number;
  rehearsalsFailed: number;
}

export class WorkerInterruptionRehearsalError extends Error {
  readonly nonce: string;

  constructor(nonce: string) {
    super("private worker interruption rehearsal requested a process restart");
    this.name = "WorkerInterruptionRehearsalError";
    this.nonce = nonce;
  }
}

export function configuredPrivateWorkerRehearsalSandbox(): PrivateWorkerRehearsalSandbox | null {
  if (optionalEnv("POSTIL_WORKER_REHEARSAL_ENABLED", "0") !== "1") return null;
  const source = optionalEnv("POSTIL_WORKER_REHEARSAL_SANDBOX");
  if (!source) {
    throw new Error(
      "POSTIL_WORKER_REHEARSAL_SANDBOX is required when the private worker rehearsal is enabled",
    );
  }
  return parsePrivateWorkerRehearsalSandbox(source);
}

export function parsePrivateWorkerRehearsalSandbox(
  source: string,
): PrivateWorkerRehearsalSandbox {
  const parts = source.split("|");
  if (parts.length !== 2) {
    throw new Error(
      "private worker rehearsal sandbox must be org|owner/repository",
    );
  }
  const [orgSlug, repoFullName] = parts;
  if (!orgSlug || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(orgSlug)) {
    throw new Error("private worker rehearsal organization slug is malformed");
  }
  if (!repoFullName || !REPOSITORY_PATTERN.test(repoFullName)) {
    throw new Error("private worker rehearsal repository is malformed");
  }
  return { orgSlug, repoFullName };
}

export function parseOperatorGithubIds(source: string | undefined): Set<number> {
  if (!source?.trim()) return new Set();
  const result = new Set<number>();
  for (const part of source.split(",")) {
    const value = Number(part.trim());
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("POSTIL_OPERATOR_GITHUB_IDS must contain positive numeric GitHub ids");
    }
    result.add(value);
  }
  return result;
}

export function assertPrivateWorkerRehearsalOperator(
  operatorGithubId: number,
  source = optionalEnv("POSTIL_OPERATOR_GITHUB_IDS"),
): void {
  if (!parseOperatorGithubIds(source).has(operatorGithubId)) {
    throw new Error("operator GitHub id is not authorized for private operations");
  }
}

export async function armPrivateWorkerRehearsal(
  pool: Pool,
  input: ArmPrivateWorkerRehearsalInput,
  configuredSandbox = configuredPrivateWorkerRehearsalSandbox(),
): Promise<{ nonce: string; reviewId: number; jobId: number }> {
  const now = input.now ?? new Date();
  assertExactSandbox(input, configuredSandbox);
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    throw new Error("private worker rehearsal pull request number is malformed");
  }
  if (!SHA_PATTERN.test(input.headSha)) {
    throw new Error("private worker rehearsal head SHA must contain 40 hexadecimal characters");
  }
  assertUuid(input.reviewPublicId, "private worker rehearsal public review id");
  assertUuid(input.nonce, "private worker rehearsal nonce");
  if (!Number.isSafeInteger(input.operatorGithubId) || input.operatorGithubId <= 0) {
    throw new Error("private worker rehearsal operator GitHub id is malformed");
  }
  const durationMs = input.expiresAt.getTime() - now.getTime();
  if (
    !Number.isFinite(input.expiresAt.getTime()) ||
    durationMs < MIN_ARMING_WINDOW_MS ||
    durationMs > MAX_ARMING_WINDOW_MS
  ) {
    throw new Error("private worker rehearsal expiry must be between one and ten minutes");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query<{
      org_id: string;
      repository_id: string;
      review_id: string;
      job_id: string;
    }>(
      `SELECT organization.id AS org_id,
              repository.id AS repository_id,
              review.id AS review_id,
              job.id AS job_id
         FROM organizations organization
         JOIN repositories repository
           ON repository.full_name = $2
         JOIN installations installation
           ON installation.id = repository.installation_id
          AND installation.org_id = organization.id
         JOIN reviews review
           ON review.repository_id = repository.id
          AND review.pr_number = $3
          AND review.head_sha = $4
          AND review.public_id = $5
          AND review.status = 'running'
         JOIN jobs job
           ON job.kind = 'review'
          AND job.status = 'running'
          AND lower(job.payload->>'repoFullName') = lower(repository.full_name)
          AND job.payload->>'prNumber' = review.pr_number::text
          AND job.payload->>'headSha' = review.head_sha
        WHERE organization.slug = $1
        ORDER BY job.id DESC
        LIMIT 1
        FOR UPDATE OF review, job`,
      [
        input.orgSlug,
        input.repoFullName,
        input.prNumber,
        input.headSha,
        input.reviewPublicId,
      ],
    );
    const row = target.rows[0];
    if (!row) {
      throw new Error("private worker rehearsal target is not one exact running sandbox review");
    }
    const inserted = await client.query(
      `INSERT INTO private_worker_rehearsals
         (nonce, state, operator_github_id, org_id, repository_id, review_id,
          job_id, org_slug, repo_full_name, pr_number, head_sha,
          review_public_id, armed_at, expires_at, updated_at)
       VALUES
         ($1, 'armed', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $12)
       ON CONFLICT DO NOTHING
       RETURNING nonce`,
      [
        input.nonce,
        input.operatorGithubId,
        row.org_id,
        row.repository_id,
        row.review_id,
        row.job_id,
        input.orgSlug,
        input.repoFullName,
        input.prNumber,
        input.headSha,
        input.reviewPublicId,
        now,
        input.expiresAt,
      ],
    );
    if ((inserted.rowCount ?? 0) !== 1) {
      throw new Error("private worker rehearsal nonce or review was already armed");
    }
    await client.query("COMMIT");
    return {
      nonce: input.nonce,
      reviewId: Number(row.review_id),
      jobId: Number(row.job_id),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function consumePrivateWorkerRehearsalAfterStaging(
  pool: Pool,
  input: StagedPrivateWorkerRehearsalInput,
): Promise<string | null> {
  const sandbox = input.sandbox === undefined
    ? configuredPrivateWorkerRehearsalSandbox()
    : input.sandbox;
  if (!sandbox) return null;
  const now = input.now ?? new Date();
  if (
    input.repoFullName !== sandbox.repoFullName
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.workerInstanceId)) {
    throw new Error("private worker rehearsal instance id is malformed");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const request = await client.query<{
      nonce: string;
      review_public_id: string;
    }>(
      `SELECT rehearsal.nonce, rehearsal.review_public_id
         FROM private_worker_rehearsals rehearsal
         JOIN organizations organization
           ON organization.id = rehearsal.org_id
          AND organization.slug = rehearsal.org_slug
         JOIN repositories repository
           ON repository.id = rehearsal.repository_id
          AND repository.full_name = rehearsal.repo_full_name
         JOIN reviews review
           ON review.id = rehearsal.review_id
          AND review.repository_id = rehearsal.repository_id
          AND review.public_id = rehearsal.review_public_id
          AND review.pr_number = rehearsal.pr_number
          AND review.head_sha = rehearsal.head_sha
          AND review.status = 'running'
          AND review.envelope IS NOT NULL
         JOIN review_publication_receipts receipt
           ON receipt.review_id = review.id
         JOIN jobs job
           ON job.id = rehearsal.job_id
          AND job.kind = 'review'
          AND job.status = 'running'
          AND job.payload->>'recoveryReviewId' = review.id::text
          AND left(job.locked_by, length($6) + 1) = $6 || '#'
         JOIN service_heartbeats heartbeat
           ON heartbeat.component = 'worker'
          AND heartbeat.instance_id = $6
        WHERE rehearsal.state = 'armed'
          AND rehearsal.expires_at > $7
          AND rehearsal.org_slug = $8
          AND rehearsal.review_id = $1
          AND rehearsal.job_id = $2
          AND rehearsal.repo_full_name = $3
          AND rehearsal.pr_number = $4
          AND rehearsal.head_sha = $5
        FOR UPDATE OF rehearsal`,
      [
        input.reviewId,
        input.reviewJobId,
        input.repoFullName,
        input.prNumber,
        input.headSha,
        input.workerInstanceId,
        now,
        sandbox.orgSlug,
      ],
    );
    const row = request.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    const counts = await captureCounts(client, input.reviewId);
    const consumed = await client.query(
      `UPDATE private_worker_rehearsals
          SET state = 'awaiting_replacement',
              consumed_at = $2,
              interrupted_worker_instance = $3,
              before_review_count = $4,
              before_usage_count = $5,
              before_check_count = $6,
              before_publication_count = $7,
              updated_at = $2
        WHERE nonce = $1
          AND state = 'armed'
        RETURNING nonce`,
      [
        row.nonce,
        now,
        input.workerInstanceId,
        counts.reviewCount,
        counts.usageCount,
        counts.checkCount,
        counts.publicationCount,
      ],
    );
    if ((consumed.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    const marked = await client.query(
      `UPDATE jobs
          SET payload = payload || jsonb_build_object(
            'privateWorkerRehearsalNonce', $2::text
          )
        WHERE id = $1
          AND kind = 'review'
          AND status = 'running'
          AND payload->>'recoveryReviewId' = $3
          AND left(locked_by, length($4) + 1) = $4 || '#'`,
      [input.reviewJobId, row.nonce, String(input.reviewId), input.workerInstanceId],
    );
    if ((marked.rowCount ?? 0) !== 1) {
      throw new Error("private worker rehearsal lost its exact recovery job lease");
    }
    await client.query("COMMIT");
    return row.nonce;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcilePrivateWorkerRehearsals(
  pool: Pool,
  now = new Date(),
  sandbox = configuredPrivateWorkerRehearsalSandbox(),
): Promise<PrivateWorkerRehearsalReconciliation> {
  const result: PrivateWorkerRehearsalReconciliation = {
    replacementsVerified: 0,
    jobsRequeued: 0,
    rehearsalsCompleted: 0,
    rehearsalsExpired: 0,
    rehearsalsFailed: 0,
  };
  if (!sandbox) return result;

  const expired = await pool.query(
    `UPDATE private_worker_rehearsals
        SET state = 'expired',
            failure_reason = 'Arming window expired before the staged review matched.',
            completed_at = $1,
            updated_at = $1
      WHERE state = 'armed'
        AND expires_at <= $1
        AND org_slug = $2
        AND repo_full_name = $3`,
    [now, sandbox.orgSlug, sandbox.repoFullName],
  );
  result.rehearsalsExpired = expired.rowCount ?? 0;

  const awaiting = await pool.query<{
    nonce: string;
    job_id: string;
    review_id: string;
    interrupted_worker_instance: string;
    replacement_worker_instance: string;
    replacement_observed_at: Date;
  }>(
    `SELECT rehearsal.nonce, rehearsal.job_id, rehearsal.review_id,
            rehearsal.interrupted_worker_instance,
            heartbeat.instance_id AS replacement_worker_instance,
            heartbeat.observed_at AS replacement_observed_at
       FROM private_worker_rehearsals rehearsal
       JOIN service_heartbeats heartbeat
         ON heartbeat.component = 'worker'
        AND heartbeat.instance_id <> rehearsal.interrupted_worker_instance
        AND heartbeat.observed_at > rehearsal.consumed_at
      WHERE rehearsal.state = 'awaiting_replacement'
        AND rehearsal.org_slug = $1
        AND rehearsal.repo_full_name = $2
      FOR UPDATE OF rehearsal`,
    [
      sandbox.orgSlug,
      sandbox.repoFullName,
    ],
  );
  for (const rehearsal of awaiting.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const verified = await client.query(
        `UPDATE private_worker_rehearsals
            SET state = 'replacement_verified',
                replacement_worker_instance = $2,
                replacement_observed_at = $3,
                updated_at = $4
          WHERE nonce = $1
            AND state = 'awaiting_replacement'
          RETURNING nonce`,
        [
          rehearsal.nonce,
          rehearsal.replacement_worker_instance,
          rehearsal.replacement_observed_at,
          now,
        ],
      );
      if ((verified.rowCount ?? 0) !== 1) {
        await client.query("ROLLBACK");
        continue;
      }
      result.replacementsVerified += 1;
      const requeued = await client.query(
        `UPDATE jobs
            SET status = 'queued',
                locked_at = NULL,
                locked_by = NULL,
                run_after = $2,
                last_error = concat_ws(' ', NULLIF(last_error, ''),
                  '[private rehearsal: replacement worker verified]')
          WHERE id = $1
            AND kind = 'review'
            AND status = 'running'
            AND payload->>'recoveryReviewId' = $3
            AND payload->>'privateWorkerRehearsalNonce' = $4
            AND left(locked_by, length($5) + 1) = $5 || '#'
          RETURNING id`,
        [
          rehearsal.job_id,
          now,
          rehearsal.review_id,
          rehearsal.nonce,
          rehearsal.interrupted_worker_instance,
        ],
      );
      if ((requeued.rowCount ?? 0) === 1) {
        result.jobsRequeued += 1;
      } else {
        const review = await client.query<{ status: string }>(
          "SELECT status FROM reviews WHERE id = $1",
          [rehearsal.review_id],
        );
        if (review.rows[0]?.status !== "completed") {
          await client.query(
            `UPDATE private_worker_rehearsals
                SET state = 'failed',
                    failure_reason = 'Replacement worker arrived but the recovery job could not be requeued.',
                    completed_at = $2,
                    updated_at = $2
              WHERE nonce = $1`,
            [rehearsal.nonce, now],
          );
          result.rehearsalsFailed += 1;
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const completed = await pool.query<{ nonce: string; review_id: string }>(
    `SELECT rehearsal.nonce, rehearsal.review_id
       FROM private_worker_rehearsals rehearsal
       JOIN reviews review
         ON review.id = rehearsal.review_id
        AND review.status = 'completed'
      WHERE rehearsal.state = 'replacement_verified'
        AND rehearsal.org_slug = $1
        AND rehearsal.repo_full_name = $2
      FOR UPDATE OF rehearsal`,
    [
      sandbox.orgSlug,
      sandbox.repoFullName,
    ],
  );
  for (const rehearsal of completed.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const counts = await captureCounts(client, Number(rehearsal.review_id));
      const updated = await client.query(
        `UPDATE private_worker_rehearsals
            SET state = 'completed',
                after_review_count = $2,
                after_usage_count = $3,
                after_check_count = $4,
                after_publication_count = $5,
                completed_at = $6,
                updated_at = $6
          WHERE nonce = $1
            AND state = 'replacement_verified'
          RETURNING nonce`,
        [
          rehearsal.nonce,
          counts.reviewCount,
          counts.usageCount,
          counts.checkCount,
          counts.publicationCount,
          now,
        ],
      );
      await client.query("COMMIT");
      result.rehearsalsCompleted += updated.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return result;
}

export function newPrivateWorkerRehearsalNonce(): string {
  return randomUUID();
}

function assertExactSandbox(
  input: PrivateWorkerRehearsalSandbox,
  configuredSandbox: PrivateWorkerRehearsalSandbox | null,
): void {
  if (!configuredSandbox) throw new Error("private worker rehearsal is disabled");
  if (
    input.orgSlug !== configuredSandbox.orgSlug ||
    input.repoFullName !== configuredSandbox.repoFullName
  ) {
    throw new Error("private worker rehearsal target does not match the sandbox allowlist");
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} is malformed`);
}

async function captureCounts(
  client: PoolClient,
  reviewId: number,
): Promise<{
  reviewCount: number;
  usageCount: number;
  checkCount: number;
  publicationCount: number;
}> {
  const result = await client.query<{
    review_count: number;
    usage_count: number;
    check_count: number;
    publication_count: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM reviews WHERE id = $1) AS review_count,
       (SELECT count(*)::int FROM usage_events WHERE review_id = $1) AS usage_count,
       (SELECT
          ((advisory_check_run_id IS NOT NULL)::int +
           (gate_check_run_id IS NOT NULL)::int)
          FROM reviews WHERE id = $1) AS check_count,
       ((SELECT count(*)::int FROM review_publication_receipts WHERE review_id = $1) +
        (SELECT count(*)::int FROM finding_publications WHERE review_id = $1)) AS publication_count`,
    [reviewId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("private worker rehearsal count snapshot is unavailable");
  return {
    reviewCount: row.review_count,
    usageCount: row.usage_count,
    checkCount: row.check_count,
    publicationCount: row.publication_count,
  };
}
