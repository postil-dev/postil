import type { Pool, PoolClient } from "pg";

import { HOSTED_REVIEW_UNAVAILABLE_MESSAGE } from "@/lib/review-outcome";

export const RELEASE_V1_JOB_KINDS = [
  "billing-contact-verification",
  "respond-delivery",
  "webhook-comment",
] as const;

const CAPABILITY = "release-v1-jobs";
const ADVISORY_LOCK_NAME = "postil:release-v1-jobs";
const RELEASE_V1_RUN_AFTER = "_postilReleaseV1RunAfter";
export const PRIVATE_REVIEW_AUTHOR_CAPABILITY = "private-review-author-v1";
const PRIVATE_REVIEW_AUTHOR_LOCK = "postil:private-review-author-v1";
const HOSTED_INFERENCE_CAPABILITY_PREFIX = "hosted-inference-release:";
const HOSTED_INFERENCE_DARK_PREFIX = "hosted-inference-dark:";
const HOSTED_INFERENCE_FLEET_ACTIVE = "hosted-inference-fleet-active";
export const HOSTED_INFERENCE_LOCK = "postil:hosted-inference-release";
const PUBLICATION_CONTROLLER_CAPABILITY_PREFIX =
  "publication-controller-release:";
const PUBLICATION_CONTROLLER_DARK_PREFIX = "publication-controller-dark:";
const PUBLICATION_CONTROLLER_CLI_VERIFIED_PREFIX =
  "publication-controller-cli-verified:";
const PUBLICATION_CONTROLLER_LEGACY_REVIEW_MARKER =
  "_postilPublicationControllerReleaseSha";
export const PUBLICATION_CONTROLLER_LOCK =
  "postil:publication-controller-release";
export const QUEUE_LOCK_GENERATION_CAPABILITY = "queue-lock-generation-v1";
const QUEUE_LOCK_GENERATION_LOCK = "postil:queue-lock-generation-v1";
const QUEUE_LOCK_GENERATION_MARKER = "_postilLockGenerationFence";
const QUEUE_LOCK_GENERATION_RUN_AFTER = "_postilLockGenerationRunAfter";
const QUEUE_ROLLOUT_BATCH_SIZE = 500;
const QUEUE_ROLLOUT_LOCK_TIMEOUT_MS = 5_000;
const QUEUE_ROLLOUT_TIMEOUT_MS = 15 * 60_000;

interface QueueQuiesceOptions {
  timeoutMs?: number;
  pollMs?: number;
  batchSize?: number;
  onWait?: (running: number) => void;
}

/** Hold queued work and wait for every pre-generation queue claim to drain. */
export async function quiesceQueueForLockGeneration(
  pool: Pool,
  options: QueueQuiesceOptions = {},
): Promise<number> {
  await fenceQueuedJobsForLockGeneration(pool, options);

  const timeoutMs = Math.max(0, options.timeoutMs ?? 15 * 60_000);
  const pollMs = Math.max(10, options.pollMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  let running = await runningQueueJobCount(pool);
  while (running > 0 && Date.now() < deadline) {
    options.onWait?.(running);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    running = await runningQueueJobCount(pool);
  }
  if (running > 0) {
    throw new Error(
      `${running} pre-generation queue claim(s) are still running after drain`,
    );
  }
  return running;
}

/** Release fenced jobs after the deployment verifier proves fleet homogeneity. */
export async function activateQueueLockGeneration(
  pool: Pool,
  options: Pick<QueueQuiesceOptions, "batchSize" | "timeoutMs"> = {},
): Promise<number> {
  await fenceQueuedJobsForLockGeneration(pool, options);

  const batchSize = queueRolloutBatchSize(options.batchSize);
  const deadline = Date.now() + Math.max(
    QUEUE_ROLLOUT_LOCK_TIMEOUT_MS,
    options.timeoutMs ?? QUEUE_ROLLOUT_TIMEOUT_MS,
  );
  const client = await pool.connect();
  let releasedTotal = 0;
  try {
    while (true) {
      await beginQueueRolloutTransaction(client);
      const active = await queueLockGenerationActive(client);
      if (!active) {
        const running = await runningQueueJobCount(client);
        if (running > 0) {
          throw new Error(
            `${running} queue claim(s) are running before lock-generation activation`,
          );
        }
        if (await unfencedQueuedJobsRemain(client)) {
          throw new Error(
            "queued jobs remain outside the lock-generation fence before activation",
          );
        }
        await client.query(
          `INSERT INTO deployment_capabilities (name)
           VALUES ($1)
           ON CONFLICT (name) DO NOTHING`,
          [QUEUE_LOCK_GENERATION_CAPABILITY],
        );
      }
      const released = await releaseFencedQueuedJobBatch(client, batchSize);
      const remaining = await fencedQueuedJobsRemain(client);
      await client.query("COMMIT");
      releasedTotal += released;
      if (!remaining) return releasedTotal;
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out releasing lock-generation queue batches; rerun activation to resume",
        );
      }
      if (released === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function fenceQueuedJobsForLockGeneration(
  pool: Pool,
  options: Pick<QueueQuiesceOptions, "batchSize" | "timeoutMs">,
): Promise<void> {
  await backfillActiveReviewInputSequences(pool, options);

  const batchSize = queueRolloutBatchSize(options.batchSize);
  const deadline = Date.now() + Math.max(
    QUEUE_ROLLOUT_LOCK_TIMEOUT_MS,
    options.timeoutMs ?? QUEUE_ROLLOUT_TIMEOUT_MS,
  );
  const client = await pool.connect();
  try {
    while (true) {
      await beginQueueRolloutTransaction(client);
      if (await queueLockGenerationActive(client)) {
        await client.query("COMMIT");
        return;
      }
      const fenced = await fenceQueuedJobBatch(client, batchSize);
      const remaining = await unfencedQueuedJobsRemain(client);
      await client.query("COMMIT");
      if (!remaining) return;
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out fencing lock-generation queue batches; rerun quiesce to resume",
        );
      }
      if (fenced === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function backfillActiveReviewInputSequences(
  pool: Pool,
  options: Pick<QueueQuiesceOptions, "batchSize" | "timeoutMs">,
): Promise<void> {
  const batchSize = queueRolloutBatchSize(options.batchSize);
  const deadline = Date.now() + Math.max(
    QUEUE_ROLLOUT_LOCK_TIMEOUT_MS,
    options.timeoutMs ?? QUEUE_ROLLOUT_TIMEOUT_MS,
  );
  const client = await pool.connect();
  try {
    while (true) {
      await beginQueueRolloutTransaction(client);
      if (await queueLockGenerationActive(client)) {
        await client.query("COMMIT");
        return;
      }
      const backfilled = await backfillReviewInputSequenceBatch(
        client,
        batchSize,
      );
      const remaining = await activeReviewInputSequencesRemain(client);
      await client.query("COMMIT");
      if (!remaining) return;
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out backfilling review input sequence batches; rerun quiesce to resume",
        );
      }
      if (backfilled === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function beginQueueRolloutTransaction(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('lock_timeout', $1, true)",
    [`${QUEUE_ROLLOUT_LOCK_TIMEOUT_MS}ms`],
  );
  // The jobs trigger takes the release lock before the queue lock. Rollout
  // transactions use the same global order so concurrent activations cannot
  // form a two-lock cycle.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [ADVISORY_LOCK_NAME],
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [QUEUE_LOCK_GENERATION_LOCK],
  );
}

async function queueLockGenerationActive(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $1
     ) AS active`,
    [QUEUE_LOCK_GENERATION_CAPABILITY],
  );
  return result.rows[0]?.active === true;
}

async function fenceQueuedJobBatch(
  client: PoolClient,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH batch AS MATERIALIZED (
       SELECT id
         FROM jobs
        WHERE status = 'queued'
          AND (
            payload->>$1 IS DISTINCT FROM 'true'
            OR jsonb_typeof(payload->$2) IS DISTINCT FROM 'string'
            OR run_after IS DISTINCT FROM 'infinity'::timestamptz
          )
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     UPDATE jobs job
        SET payload = job.payload || jsonb_build_object($1::text, true)
       FROM batch
      WHERE job.id = batch.id`,
    [
      QUEUE_LOCK_GENERATION_MARKER,
      QUEUE_LOCK_GENERATION_RUN_AFTER,
      batchSize,
    ],
  );
  return result.rowCount ?? 0;
}

async function releaseFencedQueuedJobBatch(
  client: PoolClient,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH batch AS MATERIALIZED (
       SELECT id
         FROM jobs
        WHERE status = 'queued'
          AND payload->>$1 = 'true'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $4
     )
     UPDATE jobs job
        SET payload = job.payload - $1 - $2,
            run_after = CASE
              WHEN job.kind = ANY($3::text[])
                AND NOT EXISTS (
                  SELECT 1 FROM deployment_capabilities
                   WHERE name = 'release-v1-jobs'
                ) THEN 'infinity'::timestamptz
              ELSE COALESCE(
                (job.payload->>$2)::timestamptz,
                clock_timestamp()
              )
            END
       FROM batch
      WHERE job.id = batch.id`,
    [
      QUEUE_LOCK_GENERATION_MARKER,
      QUEUE_LOCK_GENERATION_RUN_AFTER,
      RELEASE_V1_JOB_KINDS,
      batchSize,
    ],
  );
  return result.rowCount ?? 0;
}

async function unfencedQueuedJobsRemain(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ remaining: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM jobs
        WHERE status = 'queued'
          AND (
            payload->>$1 IS DISTINCT FROM 'true'
            OR jsonb_typeof(payload->$2) IS DISTINCT FROM 'string'
            OR run_after IS DISTINCT FROM 'infinity'::timestamptz
          )
     ) AS remaining`,
    [QUEUE_LOCK_GENERATION_MARKER, QUEUE_LOCK_GENERATION_RUN_AFTER],
  );
  return result.rows[0]?.remaining === true;
}

async function backfillReviewInputSequenceBatch(
  client: PoolClient,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH batch AS MATERIALIZED (
       SELECT id
         FROM jobs
        WHERE kind = 'review'
          AND status IN ('queued', 'running')
          AND (
            NOT payload ? 'reviewInputSequence'
            OR (
              jsonb_typeof(payload->'_postilCoalescedReviewPayload') = 'object'
              AND NOT (
                (payload->'_postilCoalescedReviewPayload') ?
                  'reviewInputSequence'
              )
            )
          )
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE jobs job
        SET payload = job.payload
       FROM batch
      WHERE job.id = batch.id`,
    [batchSize],
  );
  return result.rowCount ?? 0;
}

async function activeReviewInputSequencesRemain(
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query<{ remaining: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM jobs
        WHERE kind = 'review'
          AND status IN ('queued', 'running')
          AND (
            NOT payload ? 'reviewInputSequence'
            OR (
              jsonb_typeof(payload->'_postilCoalescedReviewPayload') = 'object'
              AND NOT (
                (payload->'_postilCoalescedReviewPayload') ?
                  'reviewInputSequence'
              )
            )
          )
     ) AS remaining`,
  );
  return result.rows[0]?.remaining === true;
}

async function fencedQueuedJobsRemain(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ remaining: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM jobs
        WHERE status = 'queued'
          AND payload->>$1 = 'true'
     ) AS remaining`,
    [QUEUE_LOCK_GENERATION_MARKER],
  );
  return result.rows[0]?.remaining === true;
}

function queueRolloutBatchSize(value: number | undefined): number {
  return Math.min(
    5_000,
    Math.max(1, Math.floor(value ?? QUEUE_ROLLOUT_BATCH_SIZE)),
  );
}

async function runningQueueJobCount(
  client: Pick<PoolClient, "query">,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM jobs WHERE status = 'running'",
  );
  return Number(result.rows[0]?.count ?? 0);
}

function normalizedReleaseSha(releaseSha: string): string {
  const normalized = releaseSha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(normalized)) {
    throw new Error("hosted inference activation requires a release SHA");
  }
  return normalized;
}

export function hostedInferenceCapability(releaseSha: string): string {
  return `${HOSTED_INFERENCE_CAPABILITY_PREFIX}${normalizedReleaseSha(releaseSha)}`;
}

function hostedInferenceDarkCapability(releaseSha: string): string {
  return `${HOSTED_INFERENCE_DARK_PREFIX}${normalizedReleaseSha(releaseSha)}`;
}

/** An exact managed release owns durable publication-controller activation. */
export function publicationControllerCapability(releaseSha: string): string {
  return `${PUBLICATION_CONTROLLER_CAPABILITY_PREFIX}${normalizedReleaseSha(releaseSha)}`;
}

function publicationControllerDarkCapability(releaseSha: string): string {
  return `${PUBLICATION_CONTROLLER_DARK_PREFIX}${normalizedReleaseSha(releaseSha)}`;
}

function publicationControllerCliVerifiedCapability(releaseSha: string): string {
  return `${PUBLICATION_CONTROLLER_CLI_VERIFIED_PREFIX}${normalizedReleaseSha(releaseSha)}`;
}

/** A legacy review claimed while publication ownership is fenced. */
export class PublicationControllerReleaseFenceError extends Error {
  override name = "PublicationControllerReleaseFenceError";

  constructor(readonly releaseSha: string) {
    super("managed publication-controller release fences legacy review publication");
  }
}

/** True when this release may hand publication authority to the controller. */
export async function publicationControllerReleaseActivated(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const result = await pool.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $1
     ) AS active`,
    [publicationControllerCapability(releaseSha)],
  );
  return result.rows[0]?.active === true;
}

/**
 * A release-scoped dark or active controller capability prevents the legacy
 * review runner from becoming an independent publication authority.
 */
export async function publicationControllerLegacyReviewFenced(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  normalizedReleaseSha(releaseSha);
  const result = await pool.query<{ fenced: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM deployment_capabilities
        WHERE name LIKE $1 OR name LIKE $2
     ) AS fenced`,
    [
      `${PUBLICATION_CONTROLLER_DARK_PREFIX}%`,
      `${PUBLICATION_CONTROLLER_CAPABILITY_PREFIX}%`,
    ],
  );
  return result.rows[0]?.fenced === true;
}

/** Record the exact image's local CLI-plan preflight before activation. */
export async function recordPublicationControllerCliPreflight(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const normalized = normalizedReleaseSha(releaseSha);
  const darkCapability = publicationControllerDarkCapability(normalized);
  const verifiedCapability = publicationControllerCliVerifiedCapability(normalized);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [PUBLICATION_CONTROLLER_LOCK],
    );
    const dark = await client.query<{ dark: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AS dark`,
      [darkCapability],
    );
    if (!dark.rows[0]?.dark) {
      throw new Error(
        "publication-controller CLI preflight requires a dark exact release",
      );
    }
    const recorded = await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [verifiedCapability],
    );
    await client.query("COMMIT");
    return (recorded.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Activate one exact controller release after the managed-fleet and CLI
 * preflights. Existing review jobs remain durably held for the controller.
 */
export async function activatePublicationControllerRelease(
  pool: Pool,
  releaseSha: string,
): Promise<{ activated: boolean; adopted: number }> {
  const normalized = normalizedReleaseSha(releaseSha);
  const capability = publicationControllerCapability(normalized);
  const darkCapability = publicationControllerDarkCapability(normalized);
  const verifiedCapability = publicationControllerCliVerifiedCapability(normalized);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [PUBLICATION_CONTROLLER_LOCK],
    );
    const alreadyActive = await client.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AS active`,
      [capability],
    );
    if (alreadyActive.rows[0]?.active) {
      await client.query("COMMIT");
      return { activated: false, adopted: 0 };
    }
    const prerequisites = await client.query<{
      dark: boolean;
      verified: boolean;
      otherActive: boolean;
    }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AS dark,
       EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $2
       ) AS verified,
       EXISTS (
         SELECT 1
           FROM deployment_capabilities
          WHERE name LIKE $3 AND name <> $4
       ) AS "otherActive"`,
      [
        darkCapability,
        verifiedCapability,
        `${PUBLICATION_CONTROLLER_CAPABILITY_PREFIX}%`,
        capability,
      ],
    );
    if (!prerequisites.rows[0]?.dark) {
      throw new Error(
        "publication-controller activation requires a dark exact release",
      );
    }
    if (!prerequisites.rows[0]?.verified) {
      throw new Error(
        "publication-controller activation requires a successful CLI-plan preflight",
      );
    }
    if (prerequisites.rows[0]?.otherActive) {
      throw new Error(
        "publication-controller activation requires prior release deactivation",
      );
    }
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [capability],
    );
    const adopted = await client.query(
      `UPDATE jobs
          SET payload = payload - $1 || jsonb_build_object($1::text, $2::text)
        WHERE kind = 'review'
          AND status = 'queued'
          AND payload ? $1`,
      [PUBLICATION_CONTROLLER_LEGACY_REVIEW_MARKER, normalized],
    );
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name LIKE $1",
      [`${PUBLICATION_CONTROLLER_DARK_PREFIX}%`],
    );
    await client.query("COMMIT");
    return { activated: true, adopted: adopted.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Prepare deploy and rollback by removing every controller activation first. */
export async function deactivatePublicationControllerRelease(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const normalized = normalizedReleaseSha(releaseSha);
  const darkCapability = publicationControllerDarkCapability(normalized);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [PUBLICATION_CONTROLLER_LOCK],
    );
    const removed = await client.query(
      "DELETE FROM deployment_capabilities WHERE name LIKE $1",
      [`${PUBLICATION_CONTROLLER_CAPABILITY_PREFIX}%`],
    );
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name LIKE $1",
      [`${PUBLICATION_CONTROLLER_CLI_VERIFIED_PREFIX}%`],
    );
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [darkCapability],
    );
    await client.query("COMMIT");
    return (removed.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Keep a claimed legacy review durable but unavailable to the legacy runner. */
export async function deferLegacyReviewForPublicationController(
  pool: Pool,
  job: { id: number; lockedBy: string; lockGeneration: bigint },
  releaseSha: string,
): Promise<void> {
  const normalized = normalizedReleaseSha(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [PUBLICATION_CONTROLLER_LOCK],
    );
    const fenced = await client.query<{ fenced: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM deployment_capabilities
          WHERE name LIKE $1 OR name LIKE $2
       ) AS fenced`,
      [
        `${PUBLICATION_CONTROLLER_DARK_PREFIX}%`,
        `${PUBLICATION_CONTROLLER_CAPABILITY_PREFIX}%`,
      ],
    );
    if (!fenced.rows[0]?.fenced) {
      throw new Error("publication-controller legacy review fence is no longer active");
    }
    const deferred = await client.query(
      `UPDATE jobs
          SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
              run_after = 'infinity'::timestamptz,
              locked_at = NULL, locked_by = NULL, last_error = NULL,
              payload = payload - $4 || jsonb_build_object($4::text, $5::text)
        WHERE id = $1 AND kind = 'review'
          AND status = 'running' AND locked_by = $2
          AND lock_generation = $3`,
      [
        job.id,
        job.lockedBy,
        job.lockGeneration,
        PUBLICATION_CONTROLLER_LEGACY_REVIEW_MARKER,
        normalized,
      ],
    );
    if ((deferred.rowCount ?? 0) !== 1) {
      throw new Error("publication-controller deferral lost its queue claim");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A managed worker claimed hosted work before its exact release was activated. */
export class HostedInferenceReleaseDarkError extends Error {
  override name = "HostedInferenceReleaseDarkError";

  constructor(readonly releaseSha: string) {
    super("managed hosted inference release is awaiting activation");
  }
}

/** True only after this exact managed release passes its fleet and provider preflight. */
export async function hostedInferenceReleaseActivated(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const result = await pool.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $1
     ) AS active`,
    [hostedInferenceCapability(releaseSha)],
  );
  return result.rows[0]?.active === true;
}

/** Activate managed hosted inference for one exact release after its smoke test. */
export async function activateHostedInferenceRelease(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const capability = hostedInferenceCapability(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const activated = await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [capability],
    );
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET activated_at = now()`,
      [HOSTED_INFERENCE_FLEET_ACTIVE],
    );
    await client.query(
      `
      WITH candidates AS (
        SELECT grant_row.org_id
        FROM self_service_trial_grants grant_row
        JOIN organization_entitlements entitlement
          ON entitlement.org_id = grant_row.org_id
        LEFT JOIN org_settings settings
          ON settings.org_id = grant_row.org_id
        WHERE grant_row.requested_mode = 'hosted'
          AND grant_row.granted_mode = 'byok'
          AND entitlement.subscription_mode = 'byok'
          AND entitlement.status = 'trialing'
          AND entitlement.updated_by = 'self-service-trial'
          AND entitlement.trial_ends_at > now()
          AND settings.api_key_ciphertext IS NULL
      ), promoted AS (
        UPDATE organization_entitlements entitlement
        SET subscription_mode = 'hosted',
            updated_by = 'hosted-release-activation',
            updated_at = now()
        FROM candidates
        WHERE entitlement.org_id = candidates.org_id
          AND entitlement.subscription_mode = 'byok'
          AND entitlement.status = 'trialing'
          AND entitlement.updated_by = 'self-service-trial'
          AND entitlement.trial_ends_at > now()
        RETURNING entitlement.org_id
      )
      UPDATE self_service_trial_grants grant_row
      SET granted_mode = 'hosted'
      FROM promoted
      WHERE grant_row.org_id = promoted.org_id
        AND grant_row.requested_mode = 'hosted'
        AND grant_row.granted_mode = 'byok'
    `);
    const dark = await client.query<{ activated_at: Date }>(
      `SELECT min(activated_at) AS activated_at
         FROM deployment_capabilities
        WHERE name LIKE $1`,
      [`${HOSTED_INFERENCE_DARK_PREFIX}%`],
    );
    const darkStartedAt = dark.rows[0]?.activated_at;
    if (darkStartedAt) {
      // Reconcile automatic review requests recorded as unavailable inside the
      // durable dark window. Revive only the exact source job, and only when no
      // active or completed same-head review owns inference or publication.
      await client.query(
        `WITH candidates AS (
           SELECT job.id
             FROM jobs AS job
             JOIN repositories AS repository
               ON repository.github_repo_id::text = job.payload->>'githubRepoId'
              AND repository.installation_id::text =
                  job.payload->>'sourceInstallationId'
             JOIN reviews AS paused
               ON paused.repository_id = repository.id
              AND paused.pr_number::text = job.payload->>'prNumber'
              AND paused.head_sha = job.payload->>'headSha'
              AND paused.status = 'failed'
              AND paused.error_message = $2
              AND paused.trigger_source = 'automatic_pull_request'
              AND paused.trigger_context->>'webhookDeliveryId' =
                  job.payload->>'sourceDeliveryId'
            WHERE job.kind = 'review'
              AND job.status = 'done'
              AND job.created_at >= $1
              AND paused.finished_at >= $1
              AND job.payload#>>'{trigger,source}' = 'automatic_pull_request'
              AND NOT EXISTS (
                SELECT 1
                  FROM reviews AS owner
                 WHERE owner.repository_id = paused.repository_id
                   AND owner.pr_number = paused.pr_number
                   AND owner.head_sha = paused.head_sha
                   AND owner.status IN ('queued', 'running', 'completed')
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM jobs AS active
                 WHERE active.kind = 'review'
                   AND active.status IN ('queued', 'running')
                   AND active.id <> job.id
                   AND active.payload->>'githubRepoId' = job.payload->>'githubRepoId'
                   AND active.payload->>'prNumber' = job.payload->>'prNumber'
                   AND active.payload->>'headSha' = job.payload->>'headSha'
              )
            FOR UPDATE OF job SKIP LOCKED
         )
         UPDATE jobs AS job
            SET status = 'queued', attempts = 0, run_after = now(),
                locked_at = NULL, locked_by = NULL, last_error = NULL
           FROM candidates
          WHERE job.id = candidates.id`,
        [darkStartedAt, HOSTED_REVIEW_UNAVAILABLE_MESSAGE],
      );
    }
    await client.query(
      `UPDATE jobs
          SET run_after = now(),
              payload = payload - 'releaseDarkSha'
        WHERE kind = 'review'
          AND status = 'queued'
          AND run_after = 'infinity'::timestamptz
          AND payload ? 'releaseDarkSha'`,
    );
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name LIKE $1",
      [`${HOSTED_INFERENCE_DARK_PREFIX}%`],
    );
    await client.query("COMMIT");
    return (activated.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Deploy and rollback preparation always make the target release dark first. */
export async function deactivateHostedInferenceRelease(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  const capability = hostedInferenceCapability(releaseSha);
  const darkCapability = hostedInferenceDarkCapability(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const result = await client.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [capability],
    );
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [HOSTED_INFERENCE_FLEET_ACTIVE],
    );
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [darkCapability],
    );
    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Atomically park a claimed hosted review until a verified managed release activates. */
export async function deferHostedReviewForRelease(
  pool: Pool,
  job: { id: number; lockedBy: string; lockGeneration: bigint },
  releaseSha: string,
): Promise<"deferred" | "released"> {
  const normalized = normalizedReleaseSha(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [HOSTED_INFERENCE_LOCK],
    );
    const active = await client.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AS active`,
      [HOSTED_INFERENCE_FLEET_ACTIVE],
    );
    const activated = active.rows[0]?.active === true;
    const updated = await client.query(
      `UPDATE jobs
          SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
              run_after = CASE
                WHEN $4::boolean THEN now()
                ELSE 'infinity'::timestamptz
              END,
              locked_at = NULL, locked_by = NULL, last_error = NULL,
              payload = CASE
                WHEN $4::boolean THEN payload - 'releaseDarkSha'
                ELSE payload || jsonb_build_object('releaseDarkSha', $5::text)
              END
        WHERE id = $1 AND kind = 'review'
          AND status = 'running' AND locked_by = $2
          AND lock_generation = $3`,
      [job.id, job.lockedBy, job.lockGeneration, activated, normalized],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new Error("hosted review release deferral lost its queue claim");
    }
    await client.query("COMMIT");
    return activated ? "released" : "deferred";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Activate private-review author enforcement after every managed process runs compatible code. */
export async function activatePrivateReviewAuthorIdentity(
  pool: Pool,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [PRIVATE_REVIEW_AUTHOR_LOCK],
    );
    const anonymousActive = await client.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM reviews
         JOIN repositories ON repositories.id = reviews.repository_id
         WHERE repositories.private = true
           AND reviews.status IN ('queued', 'running')
           AND (
             reviews.author_github_id IS NULL
             OR reviews.author_github_id <= 0
             OR reviews.author_github_id > 9007199254740991
             OR reviews.author_login IS NULL
             OR length(btrim(reviews.author_login)) = 0
             OR length(reviews.author_login) > 100
           )
       ) AS blocked`,
    );
    if (anonymousActive.rows[0]?.blocked) {
      throw new Error(
        "private review author enforcement has anonymous active reviews",
      );
    }
    const activated = await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [PRIVATE_REVIEW_AUTHOR_CAPABILITY],
    );
    await client.query("COMMIT");
    return (activated.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Activate new job consumers after the deploy has replaced every old
 * process. The migration's trigger records each staged schedule while the
 * capability is absent. Activation restores those schedules in bounded,
 * resumable batches under the same transaction lock before enabling new jobs.
 */
export async function activateReleaseJobs(
  pool: Pool,
  options: Pick<QueueQuiesceOptions, "batchSize" | "timeoutMs"> = {},
): Promise<number> {
  await prepareLegacyReleaseV1Schedules(pool, options);

  const batchSize = queueRolloutBatchSize(options.batchSize);
  const deadline = Date.now() + Math.max(
    QUEUE_ROLLOUT_LOCK_TIMEOUT_MS,
    options.timeoutMs ?? QUEUE_ROLLOUT_TIMEOUT_MS,
  );
  const client = await pool.connect();
  let releasedTotal = 0;
  try {
    while (true) {
      await beginReleaseV1Transaction(client);
      await client.query(
        `INSERT INTO deployment_capabilities (name)
         VALUES ($1)
         ON CONFLICT (name) DO NOTHING`,
        [CAPABILITY],
      );
      const released = await releaseV1JobBatch(
        client,
        batchSize,
      );
      const remaining = await releaseV1JobsRemain(client);
      await client.query("COMMIT");
      releasedTotal += released;
      if (!remaining) return releasedTotal;
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out releasing release-v1 job batches; rerun activation to resume",
        );
      }
      if (released === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function prepareLegacyReleaseV1Schedules(
  pool: Pool,
  options: Pick<QueueQuiesceOptions, "batchSize" | "timeoutMs">,
): Promise<void> {
  const batchSize = queueRolloutBatchSize(options.batchSize);
  const deadline = Date.now() + Math.max(
    QUEUE_ROLLOUT_LOCK_TIMEOUT_MS,
    options.timeoutMs ?? QUEUE_ROLLOUT_TIMEOUT_MS,
  );
  const client = await pool.connect();
  try {
    while (true) {
      await beginReleaseV1Transaction(client);
      const active = await client.query<{ active: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM deployment_capabilities WHERE name = $1
         ) AS active`,
        [CAPABILITY],
      );
      if (active.rows[0]?.active) {
        await client.query("COMMIT");
        return;
      }
      const prepared = await prepareLegacyReleaseV1ScheduleBatch(
        client,
        batchSize,
      );
      const remaining = await legacyReleaseV1SchedulesRemain(client);
      await client.query("COMMIT");
      if (!remaining) return;
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out preparing release-v1 schedule batches; rerun activation to resume",
        );
      }
      if (prepared === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function beginReleaseV1Transaction(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('lock_timeout', $1, true)",
    [`${QUEUE_ROLLOUT_LOCK_TIMEOUT_MS}ms`],
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [ADVISORY_LOCK_NAME],
  );
}

async function prepareLegacyReleaseV1ScheduleBatch(
  client: PoolClient,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH batch AS MATERIALIZED (
       SELECT id
         FROM jobs
        WHERE kind = ANY($1::text[])
          AND status = 'queued'
          AND run_after = 'infinity'::timestamptz
          AND jsonb_typeof(payload->$2) IS DISTINCT FROM 'string'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     UPDATE jobs job
        SET payload = job.payload
       FROM batch
      WHERE job.id = batch.id`,
    [RELEASE_V1_JOB_KINDS, RELEASE_V1_RUN_AFTER, batchSize],
  );
  return result.rowCount ?? 0;
}

async function legacyReleaseV1SchedulesRemain(
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query<{ remaining: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM jobs
        WHERE kind = ANY($1::text[])
          AND status = 'queued'
          AND run_after = 'infinity'::timestamptz
          AND jsonb_typeof(payload->$2) IS DISTINCT FROM 'string'
     ) AS remaining`,
    [RELEASE_V1_JOB_KINDS, RELEASE_V1_RUN_AFTER],
  );
  return result.rows[0]?.remaining === true;
}

async function releaseV1JobBatch(
  client: PoolClient,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH batch AS MATERIALIZED (
       SELECT id
         FROM jobs
        WHERE kind = ANY($1::text[])
          AND status = 'queued'
          AND jsonb_typeof(payload->$2) = 'string'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     UPDATE jobs job
        SET payload = job.payload - $2,
            run_after = COALESCE(
              (job.payload->>$2)::timestamptz,
              clock_timestamp()
            )
       FROM batch
      WHERE job.id = batch.id`,
    [RELEASE_V1_JOB_KINDS, RELEASE_V1_RUN_AFTER, batchSize],
  );
  return result.rowCount ?? 0;
}

async function releaseV1JobsRemain(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ remaining: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM jobs
        WHERE kind = ANY($1::text[])
          AND status = 'queued'
          AND jsonb_typeof(payload->$2) = 'string'
     ) AS remaining`,
    [RELEASE_V1_JOB_KINDS, RELEASE_V1_RUN_AFTER],
  );
  return result.rows[0]?.remaining === true;
}
