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
const PUBLICATION_CONTROLLER_CONSUMER_READY_PREFIX =
  "publication-controller-consumer-ready:";
const PUBLICATION_CONTROLLER_RECOVERY_PREFIX =
  "publication-controller-recovery:";
const PUBLICATION_CONTROLLER_LEGACY_REVIEW_MARKER =
  "_postilPublicationControllerReleaseSha";
const PUBLICATION_CONTROLLER_QUEUE_FENCE_MARKER =
  "_postilPublicationControllerFence";
const PUBLICATION_CONTROLLER_QUEUE_FENCE_RUN_AFTER =
  "_postilPublicationControllerRunAfter";
export const PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS = [
  "review",
  "gate-state-sync",
  "check-run-cleanup",
] as const;
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

export interface PublicationControllerNoMutationProbeResult {
  releaseSha: string;
  mode: "no-mutation";
  observedMutationCount: 0;
  checkedJobKinds: readonly string[];
}

export type PublicationControllerNoMutationProbe = (input: {
  client: Pick<PoolClient, "query">;
  releaseSha: string;
  jobKinds: typeof PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS;
}) => Promise<PublicationControllerNoMutationProbeResult>;

export interface PublicationControllerRecoveryState {
  releaseSha: string;
  stagedGenerations: number;
  nonterminalGenerations: number;
  activeMutationLeases: number;
  /** Decimal queue IDs proven not to have a staged controller generation. */
  unplannedQueuedJobIds: readonly string[];
}

/**
 * Read one transactionally consistent executor snapshot through the supplied
 * client while the publication authority lock is held.
 */
export type PublicationControllerRecoveryStateReader = (input: {
  client: Pick<PoolClient, "query">;
  releaseSha: string;
}) => Promise<PublicationControllerRecoveryState>;

/**
 * Read durable executor recovery state without guessing which held jobs have a
 * controller generation. The foundation schema does not bind generations to
 * a controller release or source queue job, so any staged generation keeps
 * every held job fail-closed. A release with no generations can restore all of
 * its exact held jobs as unplanned legacy work.
 */
export const readProductionPublicationControllerRecoveryState:
  PublicationControllerRecoveryStateReader = async ({ client, releaseSha }) => {
    const normalized = normalizedReleaseSha(releaseSha);
    const result = await client.query<{
      staged: string;
      nonterminal: string;
      leases: string;
      held_job_ids: string[];
    }>(
      `SELECT (
          SELECT count(*)::text
            FROM review_publication_generations
           WHERE sealed_at IS NOT NULL
        ) AS staged,
        (
          SELECT count(DISTINCT (repository_id, pr_number, publication_generation))::text
            FROM review_publication_operations
           WHERE state IN ('pending', 'applying', 'unknown')
        ) AS nonterminal,
        (
          SELECT count(*)::text
            FROM review_publication_operations
           WHERE state = 'applying'
        ) AS leases,
        ARRAY(
          SELECT id::text
            FROM jobs
           WHERE status = 'queued'
             AND kind = ANY($1::text[])
             AND payload->>$2 = $3
             AND payload->>$4 = 'true'
           ORDER BY id
        ) AS held_job_ids`,
      [
        PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
        PUBLICATION_CONTROLLER_LEGACY_REVIEW_MARKER,
        normalized,
        PUBLICATION_CONTROLLER_QUEUE_FENCE_MARKER,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("publication-controller recovery state query returned no row");
    }
    const stagedGenerations = Number(row.staged);
    const nonterminalGenerations = Number(row.nonterminal);
    const activeMutationLeases = Number(row.leases);
    return {
      releaseSha: normalized,
      stagedGenerations,
      nonterminalGenerations,
      activeMutationLeases,
      unplannedQueuedJobIds:
        stagedGenerations === 0 ? row.held_job_ids : [],
    };
  };

export interface PublicationControllerDeactivationResult {
  routingRemoved: boolean;
  state: "dark" | "recovery";
  releaseSha: string | null;
  restoredLegacyJobs: number;
  remainingNonterminalGenerations: number | null;
  activeMutationLeases: number | null;
}

export interface PublicationControllerActivationOptions {
  timeoutMs?: number;
  pollMs?: number;
  onWait?: (running: number) => void;
}

/** Hold queued work and wait for every pre-generation queue claim to drain. */
export async function quiesceQueueForLockGeneration(
  pool: Pool,
  options: QueueQuiesceOptions = {},
): Promise<number> {
  const client = await pool.connect();
  let sessionLocksHeld = false;
  try {
    await beginQueueQuiesceSession(client);
    sessionLocksHeld = true;
    await fenceQueuedJobsForLockGeneration(client, options);

    const timeoutMs = Math.max(0, options.timeoutMs ?? 15 * 60_000);
    const pollMs = Math.max(10, options.pollMs ?? 250);
    const deadline = Date.now() + timeoutMs;
    let running = await runningQueueJobCount(client);
    while (running > 0 && Date.now() < deadline) {
      options.onWait?.(running);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      running = await runningQueueJobCount(client);
    }
    if (running > 0) {
      throw new Error(
        `${running} pre-generation queue claim(s) are still running after drain`,
      );
    }
    return running;
  } finally {
    try {
      if (sessionLocksHeld) {
        await releaseQueueQuiesceSession(client);
      }
    } finally {
      client.release();
    }
  }
}

/** Release fenced jobs after the deployment verifier proves fleet homogeneity. */
export async function activateQueueLockGeneration(
  pool: Pool,
  options: Pick<QueueQuiesceOptions, "batchSize" | "timeoutMs"> = {},
): Promise<number> {
  const batchSize = queueRolloutBatchSize(options.batchSize);
  const deadline = Date.now() + Math.max(
    QUEUE_ROLLOUT_LOCK_TIMEOUT_MS,
    options.timeoutMs ?? QUEUE_ROLLOUT_TIMEOUT_MS,
  );
  const client = await pool.connect();
  let releasedTotal = 0;
  try {
    await fenceQueuedJobsForLockGeneration(client, options);
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
  client: PoolClient,
  options: Pick<QueueQuiesceOptions, "batchSize" | "timeoutMs">,
): Promise<void> {
  await backfillActiveReviewInputSequences(client, options);

  const batchSize = queueRolloutBatchSize(options.batchSize);
  const deadline = Date.now() + Math.max(
    QUEUE_ROLLOUT_LOCK_TIMEOUT_MS,
    options.timeoutMs ?? QUEUE_ROLLOUT_TIMEOUT_MS,
  );
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
  }
}

async function backfillActiveReviewInputSequences(
  client: PoolClient,
  options: Pick<QueueQuiesceOptions, "batchSize" | "timeoutMs">,
): Promise<void> {
  const batchSize = queueRolloutBatchSize(options.batchSize);
  const deadline = Date.now() + Math.max(
    QUEUE_ROLLOUT_LOCK_TIMEOUT_MS,
    options.timeoutMs ?? QUEUE_ROLLOUT_TIMEOUT_MS,
  );
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
  }
}

async function beginQueueQuiesceSession(client: PoolClient): Promise<void> {
  let sessionLocksHeld = false;
  try {
    await beginQueueRolloutTransaction(client);
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [ADVISORY_LOCK_NAME],
    );
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [QUEUE_LOCK_GENERATION_LOCK],
    );
    sessionLocksHeld = true;
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [QUEUE_LOCK_GENERATION_CAPABILITY],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (sessionLocksHeld) {
      await releaseQueueQuiesceSession(client).catch(() => undefined);
    }
    throw error;
  }
}

async function releaseQueueQuiesceSession(client: PoolClient): Promise<void> {
  const queue = await client.query<{ unlocked: boolean }>(
    "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
    [QUEUE_LOCK_GENERATION_LOCK],
  );
  const release = await client.query<{ unlocked: boolean }>(
    "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
    [ADVISORY_LOCK_NAME],
  );
  if (!queue.rows[0]?.unlocked || !release.rows[0]?.unlocked) {
    throw new Error("queue quiesce advisory lock ownership was lost");
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
    throw new Error("release operations require a hexadecimal release SHA");
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

function publicationControllerConsumerReadyCapability(releaseSha: string): string {
  return `${PUBLICATION_CONTROLLER_CONSUMER_READY_PREFIX}${normalizedReleaseSha(releaseSha)}`;
}

function publicationControllerRecoveryCapability(releaseSha: string): string {
  return `${PUBLICATION_CONTROLLER_RECOVERY_PREFIX}${normalizedReleaseSha(releaseSha)}`;
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
  const normalized = normalizedReleaseSha(releaseSha);
  const result = await pool.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $1
     ) AND EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $2
     ) AS active`,
    [
      publicationControllerCapability(normalized),
      publicationControllerConsumerReadyCapability(normalized),
    ],
  );
  return result.rows[0]?.active === true;
}

/** True when the exact release records a self-tested controller consumer. */
export async function publicationControllerConsumerReady(
  pool: Pick<Pool, "query">,
  releaseSha: string,
): Promise<boolean> {
  const result = await pool.query<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $1
     ) AS ready`,
    [publicationControllerConsumerReadyCapability(releaseSha)],
  );
  return result.rows[0]?.ready === true;
}

/** Return the exact active capability that a durable controller owns. */
export async function activePublicationControllerRelease(
  pool: Pick<Pool, "query">,
): Promise<string | null> {
  const result = await pool.query<{ name: string; consumerReady: boolean }>(
    `SELECT capability.name,
            EXISTS (
              SELECT 1
                FROM deployment_capabilities ready
               WHERE ready.name = $2 || substring(
                 capability.name FROM char_length($1) + 1
               )
            ) AS "consumerReady"
       FROM deployment_capabilities capability
      WHERE capability.name LIKE $1 || '%'
      ORDER BY capability.name
      LIMIT 2`,
    [
      PUBLICATION_CONTROLLER_CAPABILITY_PREFIX,
      PUBLICATION_CONTROLLER_CONSUMER_READY_PREFIX,
    ],
  );
  if (result.rows.length > 1) {
    throw new Error("multiple publication-controller releases are active");
  }
  const row = result.rows[0];
  if (!row?.consumerReady) return null;
  return normalizedReleaseSha(
    row.name.slice(PUBLICATION_CONTROLLER_CAPABILITY_PREFIX.length),
  );
}

/** True only while one exact, self-tested controller release owns routing. */
export async function publicationControllerLegacyReviewFenced(
  pool: Pool,
  releaseSha: string,
): Promise<boolean> {
  normalizedReleaseSha(releaseSha);
  const result = await pool.query<{ fenced: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM deployment_capabilities active
        WHERE active.name LIKE $1
          AND EXISTS (
            SELECT 1
              FROM deployment_capabilities ready
             WHERE ready.name = $2 || substring(
               active.name FROM char_length($3) + 1
             )
          )
     ) AS fenced`,
    [
      `${PUBLICATION_CONTROLLER_CAPABILITY_PREFIX}%`,
      PUBLICATION_CONTROLLER_CONSUMER_READY_PREFIX,
      PUBLICATION_CONTROLLER_CAPABILITY_PREFIX,
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
    await beginPublicationControllerAuthorityTransition(client);
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

/** Exercise and record the exact release's real no-mutation consumer probe. */
export async function recordPublicationControllerConsumerReady(
  pool: Pool,
  releaseSha: string,
  probe: PublicationControllerNoMutationProbe,
): Promise<boolean> {
  const normalized = normalizedReleaseSha(releaseSha);
  const darkCapability = publicationControllerDarkCapability(normalized);
  const readyCapability = publicationControllerConsumerReadyCapability(normalized);
  const client = await pool.connect();
  try {
    await beginPublicationControllerReadOnlyProbe(client);
    const dark = await client.query<{ dark: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AS dark`,
      [darkCapability],
    );
    if (!dark.rows[0]?.dark) {
      throw new Error(
        "publication-controller consumer readiness requires a dark exact release",
      );
    }
    const result = await probe({
      client,
      releaseSha: normalized,
      jobKinds: PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
    });
    validatePublicationControllerNoMutationProbe(result, normalized);
    await client.query("COMMIT");

    await beginPublicationControllerAuthorityTransition(client);
    const stillDark = await client.query<{ dark: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AS dark`,
      [darkCapability],
    );
    if (!stillDark.rows[0]?.dark) {
      throw new Error(
        "publication-controller consumer readiness lost its dark exact release",
      );
    }
    const recorded = await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [readyCapability],
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
 * Activate one exact controller release after the managed-fleet, CLI, and
 * no-mutation consumer preflights. Queued direct mutation work becomes owned
 * by that release in the same transaction as the authority switch.
 */
export async function activatePublicationControllerRelease(
  pool: Pool,
  releaseSha: string,
  options: PublicationControllerActivationOptions = {},
): Promise<{ activated: boolean; adopted: number }> {
  const normalized = normalizedReleaseSha(releaseSha);
  const capability = publicationControllerCapability(normalized);
  const darkCapability = publicationControllerDarkCapability(normalized);
  const verifiedCapability = publicationControllerCliVerifiedCapability(normalized);
  const consumerReadyCapability =
    publicationControllerConsumerReadyCapability(normalized);
  const existing = await pool.query<{
    active: boolean;
    consumerReady: boolean;
  }>(
    `SELECT EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $1
     ) AS active,
     EXISTS (
       SELECT 1 FROM deployment_capabilities WHERE name = $2
     ) AS "consumerReady"`,
    [capability, consumerReadyCapability],
  );
  if (existing.rows[0]?.active) {
    if (!existing.rows[0].consumerReady) {
      throw new Error(
        "active publication-controller release lacks exact consumer readiness",
      );
    }
    return { activated: false, adopted: 0 };
  }
  await waitForPublicationControllerMutatorsToDrain(pool, options);
  const client = await pool.connect();
  try {
    await beginPublicationControllerAuthorityTransition(client);
    const alreadyActive = await client.query<{
      active: boolean;
      consumerReady: boolean;
    }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AS active,
       EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $2
       ) AS "consumerReady"`,
      [capability, consumerReadyCapability],
    );
    if (alreadyActive.rows[0]?.active) {
      if (!alreadyActive.rows[0].consumerReady) {
        throw new Error(
          "active publication-controller release lacks exact consumer readiness",
        );
      }
      await client.query("COMMIT");
      return { activated: false, adopted: 0 };
    }
    const prerequisites = await client.query<{
      dark: boolean;
      verified: boolean;
      consumerReady: boolean;
      otherActive: boolean;
    }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $1
       ) AS dark,
       EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $2
       ) AS verified,
       EXISTS (
         SELECT 1 FROM deployment_capabilities WHERE name = $3
       ) AS "consumerReady",
       EXISTS (
         SELECT 1
           FROM deployment_capabilities
          WHERE name LIKE $4 AND name <> $5
       ) AS "otherActive"`,
      [
        darkCapability,
        verifiedCapability,
        consumerReadyCapability,
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
    if (!prerequisites.rows[0]?.consumerReady) {
      throw new Error(
        "publication-controller activation requires an exact consumer readiness preflight",
      );
    }
    if (prerequisites.rows[0]?.otherActive) {
      throw new Error(
        "publication-controller activation requires prior release deactivation",
      );
    }
    await assertNoRunningPublicationControllerMutators(client);
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [capability],
    );
    const adopted = await client.query(
      `UPDATE jobs
          SET payload = payload - $1 - $2 - $3 || jsonb_build_object(
                $1::text, $5::text,
                $2::text, true,
                $3::text, CASE
                  WHEN jsonb_typeof(payload->$3) = 'string' THEN payload->$3
                  WHEN jsonb_typeof(payload->$6) = 'string' THEN payload->$6
                  ELSE to_jsonb(run_after)
                END
              ),
              run_after = 'infinity'::timestamptz
        WHERE kind = ANY($4::text[])
          AND status = 'queued'
          AND (
            payload->>$1 IS DISTINCT FROM $5
            OR payload->>$2 IS DISTINCT FROM 'true'
            OR jsonb_typeof(payload->$3) IS DISTINCT FROM 'string'
            OR run_after IS DISTINCT FROM 'infinity'::timestamptz
          )`,
      [
        PUBLICATION_CONTROLLER_LEGACY_REVIEW_MARKER,
        PUBLICATION_CONTROLLER_QUEUE_FENCE_MARKER,
        PUBLICATION_CONTROLLER_QUEUE_FENCE_RUN_AFTER,
        PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
        normalized,
        QUEUE_LOCK_GENERATION_RUN_AFTER,
      ],
    );
    await client.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [darkCapability],
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

/**
 * Remove new controller routing before recovering staged work. Recovery state
 * is retained until the executor proves every mutation lease and generation
 * terminal. Missing executor state access leaves the release fail-closed.
 */
export async function deactivatePublicationControllerRelease(
  pool: Pool,
  releaseSha: string,
  recoveryStateReader?: PublicationControllerRecoveryStateReader,
): Promise<PublicationControllerDeactivationResult> {
  const normalized = normalizedReleaseSha(releaseSha);
  const darkCapability = publicationControllerDarkCapability(normalized);
  const client = await pool.connect();
  let routingRemoved = false;
  let recoveryReleaseSha: string | null = null;
  let restoredLegacyJobs = 0;
  try {
    await beginPublicationControllerAuthorityTransition(client, {
      requireQueueQuiescence: false,
    });
    const ownership = await publicationControllerOwnershipState(client);
    recoveryReleaseSha = ownership.active ?? ownership.recovery ?? ownership.held;
    const removed = await client.query(
      "DELETE FROM deployment_capabilities WHERE name LIKE $1",
      [`${PUBLICATION_CONTROLLER_CAPABILITY_PREFIX}%`],
    );
    routingRemoved = (removed.rowCount ?? 0) > 0;
    await client.query(
      `INSERT INTO deployment_capabilities (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [darkCapability],
    );
    if (recoveryReleaseSha) {
      await client.query(
        `INSERT INTO deployment_capabilities (name)
         VALUES ($1)
         ON CONFLICT (name) DO NOTHING`,
        [publicationControllerRecoveryCapability(recoveryReleaseSha)],
      );
    } else {
      await removePublicationControllerReadiness(client, normalized);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw error;
  }

  if (!recoveryReleaseSha) {
    client.release();
    return {
      routingRemoved,
      state: "dark",
      releaseSha: null,
      restoredLegacyJobs,
      remainingNonterminalGenerations: 0,
      activeMutationLeases: 0,
    };
  }

  if (!recoveryStateReader) {
    client.release();
    return {
      routingRemoved,
      state: "recovery",
      releaseSha: recoveryReleaseSha,
      restoredLegacyJobs,
      remainingNonterminalGenerations: null,
      activeMutationLeases: null,
    };
  }

  try {
    await beginPublicationControllerAuthorityTransition(client, {
      requireQueueQuiescence: false,
    });
    const recoveryState = await recoveryStateReader({
      client,
      releaseSha: recoveryReleaseSha,
    });
    validatePublicationControllerRecoveryState(
      recoveryState,
      recoveryReleaseSha,
    );
    const heldJobIds = await publicationControllerHeldJobIds(
      client,
      recoveryReleaseSha,
    );
    validatePublicationControllerRecoveryClassification(
      recoveryState,
      heldJobIds,
    );
    if (recoveryState.activeMutationLeases > 0) {
      await client.query("COMMIT");
      return {
        routingRemoved,
        state: "recovery",
        releaseSha: recoveryReleaseSha,
        restoredLegacyJobs,
        remainingNonterminalGenerations:
          recoveryState.nonterminalGenerations,
        activeMutationLeases: recoveryState.activeMutationLeases,
      };
    }

    restoredLegacyJobs += await restoreUnplannedPublicationControllerJobs(
      client,
      recoveryReleaseSha,
      PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
      recoveryState.unplannedQueuedJobIds,
    );
    if (recoveryState.nonterminalGenerations > 0) {
      await client.query("COMMIT");
      return {
        routingRemoved,
        state: "recovery",
        releaseSha: recoveryReleaseSha,
        restoredLegacyJobs,
        remainingNonterminalGenerations:
          recoveryState.nonterminalGenerations,
        activeMutationLeases: 0,
      };
    }

    await client.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [publicationControllerRecoveryCapability(recoveryReleaseSha)],
    );
    await removePublicationControllerReadiness(client, recoveryReleaseSha);
    await client.query("COMMIT");
    return {
      routingRemoved,
      state: "dark",
      releaseSha: recoveryReleaseSha,
      restoredLegacyJobs,
      remainingNonterminalGenerations: 0,
      activeMutationLeases: 0,
    };
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
  normalizedReleaseSha(releaseSha);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [QUEUE_LOCK_GENERATION_LOCK],
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [PUBLICATION_CONTROLLER_LOCK],
    );
    const active = await activePublicationControllerReleaseForUpdate(client);
    if (!active) {
      throw new Error(
        "publication-controller legacy review fence is no longer active",
      );
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
        active,
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

async function beginPublicationControllerAuthorityTransition(
  client: PoolClient,
  options: { requireQueueQuiescence?: boolean } = {},
): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('lock_timeout', $1, true)",
    [`${QUEUE_ROLLOUT_LOCK_TIMEOUT_MS}ms`],
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [QUEUE_LOCK_GENERATION_LOCK],
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [PUBLICATION_CONTROLLER_LOCK],
  );
  const quiesce = await client.query<{ queue_locked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM deployment_capabilities
        WHERE name = $1
     ) AS queue_locked`,
    [QUEUE_LOCK_GENERATION_CAPABILITY],
  );
  if (
    options.requireQueueQuiescence !== false &&
    quiesce.rows[0]?.queue_locked
  ) {
    throw new Error(
      "publication-controller authority transition requires queue-lock-generation quiescence",
    );
  }
}

async function beginPublicationControllerReadOnlyProbe(
  client: PoolClient,
): Promise<void> {
  await client.query("BEGIN TRANSACTION READ ONLY");
  await client.query(
    "SELECT set_config('lock_timeout', $1, true)",
    [`${QUEUE_ROLLOUT_LOCK_TIMEOUT_MS}ms`],
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [QUEUE_LOCK_GENERATION_LOCK],
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [PUBLICATION_CONTROLLER_LOCK],
  );
  const quiesce = await client.query<{ queue_locked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM deployment_capabilities
        WHERE name = $1
     ) AS queue_locked`,
    [QUEUE_LOCK_GENERATION_CAPABILITY],
  );
  if (quiesce.rows[0]?.queue_locked) {
    throw new Error(
      "publication-controller consumer probe requires queue-lock-generation quiescence",
    );
  }
}

async function assertNoRunningPublicationControllerMutators(
  client: Pick<PoolClient, "query">,
): Promise<void> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM jobs
      WHERE kind = ANY($1::text[])
        AND status = 'running'`,
    [PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS],
  );
  const running = Number(result.rows[0]?.count ?? 0);
  if (running > 0) {
    throw new Error(
      `${running} direct GitHub mutator job claim(s) are running before ` +
        "publication-controller activation",
    );
  }
}

async function waitForPublicationControllerMutatorsToDrain(
  pool: Pick<Pool, "query">,
  options: PublicationControllerActivationOptions,
): Promise<void> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? QUEUE_ROLLOUT_TIMEOUT_MS);
  const pollMs = Math.max(10, options.pollMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const state = await pool.query<{
      queueLocked: boolean;
      running: string;
    }>(
      `SELECT EXISTS (
         SELECT 1
           FROM deployment_capabilities
          WHERE name = $1
       ) AS "queueLocked",
       (
         SELECT count(*)::text
           FROM jobs
          WHERE kind = ANY($2::text[])
            AND status = 'running'
       ) AS running`,
      [
        QUEUE_LOCK_GENERATION_CAPABILITY,
        PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
      ],
    );
    if (state.rows[0]?.queueLocked) {
      throw new Error(
        "publication-controller activation requires queue-lock-generation quiescence",
      );
    }
    const running = Number(state.rows[0]?.running ?? 0);
    if (running === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${running} direct GitHub mutator job claim(s) are still running ` +
          "before publication-controller activation",
      );
    }
    options.onWait?.(running);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function validatePublicationControllerNoMutationProbe(
  result: PublicationControllerNoMutationProbeResult,
  releaseSha: string,
): void {
  if (
    result.releaseSha !== releaseSha ||
    result.mode !== "no-mutation" ||
    result.observedMutationCount !== 0 ||
    result.checkedJobKinds.length !==
      PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS.length ||
    !PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS.every(
      (kind, index) => result.checkedJobKinds[index] === kind,
    )
  ) {
    throw new Error(
      "publication-controller consumer readiness probe returned an invalid " +
        "exact no-mutation result",
    );
  }
}

function validatePublicationControllerRecoveryState(
  state: PublicationControllerRecoveryState,
  releaseSha: string,
): void {
  if (
    state.releaseSha !== releaseSha ||
    !isNonnegativeInteger(state.stagedGenerations) ||
    !isNonnegativeInteger(state.nonterminalGenerations) ||
    !isNonnegativeInteger(state.activeMutationLeases) ||
    state.nonterminalGenerations > state.stagedGenerations ||
    !Array.isArray(state.unplannedQueuedJobIds) ||
    state.unplannedQueuedJobIds.some((id) => !/^[1-9][0-9]*$/.test(id)) ||
    new Set(state.unplannedQueuedJobIds).size !==
      state.unplannedQueuedJobIds.length
  ) {
    throw new Error(
      "publication-controller recovery reader returned invalid exact release state",
    );
  }
}

function validatePublicationControllerRecoveryClassification(
  state: PublicationControllerRecoveryState,
  heldJobIds: readonly string[],
): void {
  const held = new Set(heldJobIds);
  if (state.unplannedQueuedJobIds.some((id) => !held.has(id))) {
    throw new Error(
      "publication-controller recovery reader classified a job outside the " +
        "exact held release",
    );
  }
  if (
    state.nonterminalGenerations === 0 &&
    (state.unplannedQueuedJobIds.length !== heldJobIds.length ||
      heldJobIds.some((id) => !state.unplannedQueuedJobIds.includes(id)))
  ) {
    throw new Error(
      "publication-controller terminal recovery does not classify every " +
        "held controller job as unplanned",
    );
  }
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

async function publicationControllerOwnershipState(
  client: Pick<PoolClient, "query">,
): Promise<{
  active: string | null;
  recovery: string | null;
  held: string | null;
}> {
  const result = await client.query<{
    active: string[];
    recovery: string[];
    held: string[];
  }>(
    `SELECT ARRAY(
              SELECT substring(name FROM char_length($1) + 1)
                FROM deployment_capabilities
               WHERE name LIKE $1 || '%'
               ORDER BY name
               LIMIT 2
            ) AS active,
            ARRAY(
              SELECT substring(name FROM char_length($2) + 1)
                FROM deployment_capabilities
               WHERE name LIKE $2 || '%'
               ORDER BY name
               LIMIT 2
            ) AS recovery,
            ARRAY(
              SELECT DISTINCT payload->>$3
                FROM jobs
               WHERE status = 'queued'
                 AND kind = ANY($4::text[])
                 AND payload->>$5 = 'true'
                 AND jsonb_typeof(payload->$3) = 'string'
               ORDER BY payload->>$3
               LIMIT 2
            ) AS held`,
    [
      PUBLICATION_CONTROLLER_CAPABILITY_PREFIX,
      PUBLICATION_CONTROLLER_RECOVERY_PREFIX,
      PUBLICATION_CONTROLLER_LEGACY_REVIEW_MARKER,
      PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
      PUBLICATION_CONTROLLER_QUEUE_FENCE_MARKER,
    ],
  );
  const row = result.rows[0] ?? { active: [], recovery: [], held: [] };
  for (const values of [row.active, row.recovery, row.held]) {
    if (values.length > 1) {
      throw new Error("multiple publication-controller releases own durable work");
    }
  }
  const releases = [row.active[0], row.recovery[0], row.held[0]].filter(
    (value): value is string => Boolean(value),
  );
  if (new Set(releases).size > 1) {
    throw new Error("publication-controller routing and recovery releases disagree");
  }
  return {
    active: row.active[0] ?? null,
    recovery: row.recovery[0] ?? null,
    held: row.held[0] ?? null,
  };
}

async function activePublicationControllerReleaseForUpdate(
  client: Pick<PoolClient, "query">,
): Promise<string | null> {
  const result = await client.query<{ name: string }>(
    `SELECT active.name
       FROM deployment_capabilities active
      WHERE active.name LIKE $1 || '%'
        AND EXISTS (
          SELECT 1
            FROM deployment_capabilities ready
           WHERE ready.name = $2 || substring(
             active.name FROM char_length($1) + 1
           )
        )
      ORDER BY active.name
      LIMIT 2`,
    [
      PUBLICATION_CONTROLLER_CAPABILITY_PREFIX,
      PUBLICATION_CONTROLLER_CONSUMER_READY_PREFIX,
    ],
  );
  if (result.rows.length > 1) {
    throw new Error("multiple publication-controller releases are active");
  }
  const name = result.rows[0]?.name;
  return name
    ? normalizedReleaseSha(
        name.slice(PUBLICATION_CONTROLLER_CAPABILITY_PREFIX.length),
      )
    : null;
}

async function restoreUnplannedPublicationControllerJobs(
  client: Pick<PoolClient, "query">,
  releaseSha: string,
  jobKinds: readonly string[],
  unplannedQueuedJobIds: readonly string[],
): Promise<number> {
  const restored = await client.query(
    `UPDATE jobs
        SET run_after = COALESCE(
              (payload->>$1)::timestamptz,
              clock_timestamp()
            ),
            payload = payload - $1 - $2 - $3
      WHERE status = 'queued'
        AND kind = ANY($4::text[])
        AND payload->>$3 = $5
        AND payload->>$2 = 'true'
        AND id::text = ANY($6::text[])`,
    [
      PUBLICATION_CONTROLLER_QUEUE_FENCE_RUN_AFTER,
      PUBLICATION_CONTROLLER_QUEUE_FENCE_MARKER,
      PUBLICATION_CONTROLLER_LEGACY_REVIEW_MARKER,
      jobKinds,
      releaseSha,
      unplannedQueuedJobIds,
    ],
  );
  return restored.rowCount ?? 0;
}

async function publicationControllerHeldJobIds(
  client: Pick<PoolClient, "query">,
  releaseSha: string,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id
       FROM jobs
      WHERE status = 'queued'
        AND kind = ANY($1::text[])
        AND payload->>$2 = $3
        AND payload->>$4 = 'true'
      ORDER BY id`,
    [
      PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
      PUBLICATION_CONTROLLER_LEGACY_REVIEW_MARKER,
      releaseSha,
      PUBLICATION_CONTROLLER_QUEUE_FENCE_MARKER,
    ],
  );
  return result.rows.map((row) => row.id);
}

async function removePublicationControllerReadiness(
  client: Pick<PoolClient, "query">,
  releaseSha: string,
): Promise<void> {
  await client.query(
    `DELETE FROM deployment_capabilities
      WHERE name = ANY($1::text[])`,
    [[
      publicationControllerCliVerifiedCapability(releaseSha),
      publicationControllerConsumerReadyCapability(releaseSha),
    ]],
  );
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
