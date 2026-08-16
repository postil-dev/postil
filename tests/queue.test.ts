import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Pool, PoolClient } from "pg";

import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";
import {
  backoffMs,
  claimJob as claimJobWithCapabilities,
  COALESCED_REVIEW_PAYLOAD_KEY,
  completeJob,
  continueClaimedJob,
  enqueueGithubReactionJobOnce,
  enqueueJob,
  enqueueObservedReviewSnapshot,
  enqueueRespondJobWithinHourlyCap,
  enqueueReviewJobOnce,
  failJob,
  pendingReviewInputSupersedes,
  queueDepth,
  type ReviewJobPayload,
  reviewInputLeaseState,
  requeueClaimedJobs,
  retryJobIndefinitely,
  withReviewPublicationFence,
} from "@/lib/queue";
import {
  finalizeEscalationEmailRetirement,
  quiesceEscalationEmailJobs,
} from "@/lib/escalation-email-retirement";
import {
  activateQueueLockGeneration,
  activatePrivateReviewAuthorIdentity,
  activateReleaseJobs,
  PRIVATE_REVIEW_AUTHOR_CAPABILITY,
  QUEUE_LOCK_GENERATION_CAPABILITY,
  quiesceQueueForLockGeneration,
} from "@/lib/release-job-rollout";
import { ensureOperationalIndexes } from "../scripts/ensure-operational-indexes";

/**
 * Queue claim semantics against a real Postgres (FOR UPDATE SKIP LOCKED
 * cannot be meaningfully unit-tested without one). Set
 * POSTIL_TEST_DATABASE_URL to run; the suite is skipped otherwise.
 */

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;

const describeDb = TEST_URL ? describe : describe.skip;
const TEST_JOB_KINDS = ["review", "respond"] as const;
const REVIEW_UPDATED_AT = "2026-08-10T00:00:05.000Z";

function validReviewPayload(
  overrides: Record<string, unknown> = {},
): ReviewJobPayload {
  return {
    installationId: 1,
    sourceInstallationId: 1,
    sourceOrgId: 1,
    githubRepoId: 9_001,
    repoFullName: "octo/queue-test",
    prNumber: 1,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    expectedPullRequestUpdatedAt: REVIEW_UPDATED_AT,
    ...overrides,
  } as ReviewJobPayload;
}

function claimJob(pool: Pool, workerId: string) {
  return claimJobWithCapabilities(pool, workerId, TEST_JOB_KINDS);
}

async function waitForAdvisoryWaiter(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting
         FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted`,
    );
    if ((result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("queue mutation did not wait for the publication fence");
}

describe("queue transition structure", () => {
  test("uses the database clock for guarded reconciliation decisions", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "lib", "queue.ts"),
      "utf8",
    );
    const retrySource = source.slice(
      source.indexOf("export async function retryJobIndefinitely"),
      source.indexOf("export async function queueDepth"),
    );

    expect(retrySource).toContain("clock_timestamp()");
    expect(retrySource).toContain("reconciliation_deadline_at");
    expect(retrySource).toContain("retry_within_budget");
    expect(retrySource).toContain("lock_generation = $4");
    expect(retrySource).not.toContain("Date.now");
  });

  test("claims and deadline admission share one guarded database statement", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "lib", "queue.ts"),
      "utf8",
    );
    const claimSource = source.slice(
      source.indexOf("export async function claimJob"),
      source.indexOf("export async function completeJob"),
    );
    const controllerClaimSource = source.slice(
      source.indexOf(
        "export async function claimPublicationControllerReviewJob",
      ),
      source.indexOf("export async function completeJob"),
    );

    expect(claimSource).toContain("candidate AS MATERIALIZED");
    expect(claimSource).toContain("admission AS MATERIALIZED");
    expect(claimSource).toContain(
      "SELECT candidate.id, clock_timestamp() AS admitted_at",
    );
    expect(claimSource).toContain(
      "job.reconciliation_deadline_at > admission.admitted_at",
    );
    expect(claimSource).toContain(
      "job.reconciliation_deadline_at <= admission.admitted_at",
    );
    expect(claimSource).toContain(
      "lock_generation = job.lock_generation + 1",
    );
    expect(claimSource).toContain("'terminalized'::text AS outcome");
    expect(claimSource).toContain('if (row.outcome !== "claimed") continue');
    expect(claimSource).toContain(
      "active review claim was suppressed by queue identity enforcement",
    );
    expect(claimSource).toContain(
      "excludePublicationControllerFencedJobs",
    );
    expect(claimSource).toContain(
      "_postilPublicationControllerFence' IS DISTINCT FROM 'true'",
    );
    expect(controllerClaimSource).toContain("job.kind = 'review'");
    expect(controllerClaimSource).toContain(
      "PUBLICATION_CONTROLLER_CLAIM_LOCK_TIMEOUT_MS",
    );
    expect(controllerClaimSource).toContain(
      "FROM review_publication_generations generation",
    );
    expect(controllerClaimSource).toContain(
      "pg_input_is_valid(job.payload->>$10, 'timestamptz')",
    );
    expect(controllerClaimSource).toContain(
      "reconciliation budget exhausted before claim",
    );
    expect(controllerClaimSource).toContain(
      "WHEN job.payload->>'recoveryReviewId' ~ '^[1-9][0-9]*$'",
    );
    expect(controllerClaimSource.indexOf("set_config('lock_timeout'")).toBeLessThan(
      controllerClaimSource.indexOf("pg_advisory_xact_lock"),
    );
  });

  test("complete, continue, and failure transitions fence the exact lease", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "lib", "queue.ts"),
      "utf8",
    );
    const completeSource = source.slice(
      source.indexOf("export async function completeJob"),
      source.indexOf("export async function continueClaimedJob"),
    );
    const continueSource = source.slice(
      source.indexOf("export async function continueClaimedJob"),
      source.indexOf("export async function requeueClaimedJobs"),
    );
    const requeueSource = source.slice(
      source.indexOf("export async function requeueClaimedJobs"),
      source.indexOf("export function backoffMs"),
    );
    const failureSource = source.slice(
      source.indexOf("export async function failJob"),
      source.indexOf("export const PUBLICATION_RECONCILIATION_BUDGET_MS"),
    );

    expect(completeSource).toContain("lock_generation = $3");
    expect(continueSource).toContain("lock_generation = $5");
    expect(requeueSource).toContain("job.locked_by = requested.locked_by");
    expect(requeueSource).toContain(
      "job.lock_generation = requested.lock_generation",
    );
    expect(requeueSource).toContain(
      "`${lease.id}:${lease.lockGeneration}:${lease.lockedBy}`",
    );
    expect(requeueSource).not.toContain("left(locked_by");
    expect(failureSource.match(/lock_generation = \$[45]/gu)).toHaveLength(3);
    expect(completeSource).not.toContain("AND locked_at =");
    expect(continueSource).not.toContain("AND locked_at =");
    expect(failureSource).not.toContain("AND locked_at =");
  });
});

describe("review input rerun authority", () => {
  test("a parseable newer pending edit supersedes the claimed input", () => {
    expect(
      pendingReviewInputSupersedes(
        undefined,
        "2026-08-10T00:00:10.000Z",
      ),
    ).toBe(true);
    expect(
      pendingReviewInputSupersedes(
        "2026-08-10T00:00:05.000Z",
        "2026-08-10T00:00:10.000Z",
      ),
    ).toBe(true);
  });

  test("equal timestamps use durable arrival order", () => {
    const updatedAt = "2026-08-10T00:00:10.000Z";
    expect(
      pendingReviewInputSupersedes(updatedAt, updatedAt, "40", "41"),
    ).toBe(true);
    expect(
      pendingReviewInputSupersedes(updatedAt, updatedAt, "41", "40"),
    ).toBe(false);
  });

  test("equal unordered, older, missing, and invalid pending timestamps do not supersede", () => {
    const running = "2026-08-10T00:00:10.000Z";
    expect(pendingReviewInputSupersedes(running, running)).toBe(false);
    expect(
      pendingReviewInputSupersedes(
        running,
        "2026-08-10T00:00:05.000Z",
      ),
    ).toBe(false);
    expect(pendingReviewInputSupersedes(running, undefined)).toBe(false);
    expect(pendingReviewInputSupersedes(running, "invalid")).toBe(false);
  });

  test("stored arrival order supersedes an equal timestamp despite a legacy claim payload", async () => {
    const state = await reviewInputLeaseState(
      {
        query: async () => ({
          rows: [{
            running_sequence: "41",
            pending_updated_at: "2026-08-10T00:00:10.000Z",
            pending_sequence: "42",
          }],
        }),
      } as unknown as Pick<Pool, "query">,
      { id: 1, lockedBy: "mixed-version-worker", lockGeneration: 1n },
      "2026-08-10T00:00:10.000Z",
      undefined,
    );

    expect(state).toBe("newer-pending");
  });
});

describeDb("postgres job queue", () => {
  let db: EphemeralDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await createEphemeralDatabase("queue");
    pool = db.pool;
    await ensureOperationalIndexes(pool);
  }, 30_000);

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE private_worker_rehearsals, respond_deliveries, jobs, deployment_capabilities RESTART IDENTITY",
    );
    await pool.query(
      `INSERT INTO deployment_capabilities (name) VALUES ($1)`,
      [QUEUE_LOCK_GENERATION_CAPABILITY],
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  test("claim returns the oldest runnable job and marks it running", async () => {
    const payload = validReviewPayload();
    const id = await enqueueJob(pool, "review", payload);
    const job = await claimJob(pool, "worker-a");
    expect(job).not.toBeNull();
    expect(job?.id).toBe(id);
    expect(job?.kind).toBe("review");
    expect(job?.payload).toEqual({
      ...payload,
      reviewInputSequence: expect.any(String),
    });
    expect(job?.attempts).toBe(1);
    expect(job?.lockGeneration).toBe(1n);
    expect(job?.createdAt).toBeInstanceOf(Date);
    expect(job?.lockedAt).toBeInstanceOf(Date);
    expect(job!.lockedAt.getTime()).toBeGreaterThanOrEqual(job!.createdAt.getTime());

    const row = await pool.query(
      `SELECT status, locked_by, created_at, locked_at,
              lock_generation::text AS lock_generation
         FROM jobs WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("running");
    expect(row.rows[0].locked_by).toBe("worker-a");
    expect(job?.createdAt).toEqual(row.rows[0].created_at);
    expect(job?.lockedAt).toEqual(row.rows[0].locked_at);
    expect(BigInt(row.rows[0].lock_generation)).toBe(job!.lockGeneration);
  });

  test("activated databases assign a generation to rollback worker claims", async () => {
    const id = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ prNumber: 80, headSha: "7".repeat(40) }),
    );

    const claimed = await pool.query<{
      status: string;
      locked_by: string;
      lock_generation: string;
    }>(
      `UPDATE jobs
          SET status = 'running', attempts = attempts + 1,
              locked_at = clock_timestamp(), locked_by = 'rollback-worker'
        WHERE id = $1 AND status = 'queued'
      RETURNING status, locked_by,
                lock_generation::text AS lock_generation`,
      [id],
    );

    expect(claimed.rows[0]).toEqual({
      status: "running",
      locked_by: "rollback-worker",
      lock_generation: "1",
    });
  });

  test("inactive databases hold a pre-migration queued claim without terminalizing it", async () => {
    const id = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ prNumber: 79, headSha: "6".repeat(40) }),
    );
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [QUEUE_LOCK_GENERATION_CAPABILITY],
    );

    expect(await claimJob(pool, "inactive-worker")).toBeNull();
    const held = await pool.query<{
      status: string;
      attempts: number;
      held: boolean;
      marker: string | null;
      last_error: string | null;
    }>(
      `SELECT status, attempts,
              run_after = 'infinity'::timestamptz AS held,
              payload->>'_postilLockGenerationFence' AS marker,
              last_error
         FROM jobs WHERE id = $1`,
      [id],
    );
    expect(held.rows[0]).toEqual({
      status: "queued",
      attempts: 0,
      held: true,
      marker: "true",
      last_error: null,
    });
  });

  test("bounded rollout backfills legacy review order and preserves schedules", async () => {
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [QUEUE_LOCK_GENERATION_CAPABILITY],
    );
    const dueAt: [Date, Date] = [
      new Date("2026-08-14T10:00:00.000Z"),
      new Date("2026-08-15T11:30:00.000Z"),
    ];
    await pool.query(
      "ALTER TABLE jobs DISABLE TRIGGER jobs_stage_unactivated_release_trigger",
    );
    try {
      await pool.query(
        `INSERT INTO jobs (kind, payload, status, run_after)
         VALUES
           ('review', $1::jsonb, 'queued', $2),
           ('review', $3::jsonb, 'queued', $4)`,
        [
          JSON.stringify(validReviewPayload({
            prNumber: 77,
            headSha: "4".repeat(40),
            _postilCoalescedReviewPayload: validReviewPayload({
              prNumber: 77,
              headSha: "5".repeat(40),
            }),
          })),
          dueAt[0],
          JSON.stringify(validReviewPayload({
            prNumber: 78,
            headSha: "5".repeat(40),
          })),
          dueAt[1],
        ],
      );
    } finally {
      await pool.query(
        "ALTER TABLE jobs ENABLE TRIGGER jobs_stage_unactivated_release_trigger",
      );
    }

    await expect(
      quiesceQueueForLockGeneration(pool, { timeoutMs: 0, batchSize: 1 }),
    ).resolves.toBe(0);
    const held = await pool.query<{
      id: string;
      current_sequence: string;
      pending_sequence: string | null;
      scheduled_for: Date;
      held: boolean;
      marker: string | null;
    }>(
      `SELECT id,
              payload->>'reviewInputSequence' AS current_sequence,
              payload#>>'{_postilCoalescedReviewPayload,reviewInputSequence}'
                AS pending_sequence,
              (payload->>'_postilLockGenerationRunAfter')::timestamptz
                AS scheduled_for,
              run_after = 'infinity'::timestamptz AS held,
              payload->>'_postilLockGenerationFence' AS marker
         FROM jobs
        ORDER BY id`,
    );
    expect(held.rows).toHaveLength(2);
    for (const [index, row] of held.rows.entries()) {
      expect(BigInt(row.current_sequence)).toBeGreaterThan(0n);
      expect(row.scheduled_for).toEqual(dueAt[index]!);
      expect(row.held).toBe(true);
      expect(row.marker).toBe("true");
    }
    expect(BigInt(held.rows[0]!.pending_sequence!)).toBeGreaterThan(
      BigInt(held.rows[0]!.current_sequence),
    );

    expect(
      await activateQueueLockGeneration(pool, { batchSize: 1 }),
    ).toBe(2);
    const released = await pool.query<{
      run_after: Date;
      marker: string | null;
      scheduled_for: string | null;
    }>(
      `SELECT run_after,
              payload->>'_postilLockGenerationFence' AS marker,
              payload->>'_postilLockGenerationRunAfter' AS scheduled_for
         FROM jobs
        ORDER BY id`,
    );
    expect(released.rows).toEqual([
      { run_after: dueAt[0], marker: null, scheduled_for: null },
      { run_after: dueAt[1], marker: null, scheduled_for: null },
    ]);
  });

  test("lock-generation rollout fences mixed-binary work until quiesce and activation", async () => {
    const runningId = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ prNumber: 81, headSha: "8".repeat(40) }),
    );
    const queuedBeforeMigrationId = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ prNumber: 82, headSha: "9".repeat(40) }),
    );
    const running = await claimJob(pool, "pre-generation-worker");
    expect(running?.id).toBe(runningId);

    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [QUEUE_LOCK_GENERATION_CAPABILITY],
    );
    const fencedId = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ prNumber: 83, headSha: "a".repeat(40) }),
    );
    const fenced = await pool.query<{
      held: boolean;
      marker: string | null;
    }>(
      `SELECT run_after = 'infinity'::timestamptz AS held,
              payload->>'_postilLockGenerationFence' AS marker
         FROM jobs WHERE id = $1`,
      [fencedId],
    );
    expect(fenced.rows[0]).toEqual({ held: true, marker: "true" });

    await expect(
      quiesceQueueForLockGeneration(pool, { timeoutMs: 0, batchSize: 1 }),
    ).rejects.toThrow("queue claim(s) are still running after drain");
    const queuedBeforeMigration = await pool.query<{
      held: boolean;
      marker: string | null;
    }>(
      `SELECT run_after = 'infinity'::timestamptz AS held,
              payload->>'_postilLockGenerationFence' AS marker
         FROM jobs WHERE id = $1`,
      [queuedBeforeMigrationId],
    );
    expect(queuedBeforeMigration.rows[0]).toEqual({
      held: true,
      marker: "true",
    });
    expect(await completeJob(pool, running!)).toBe("done");
    await expect(
      quiesceQueueForLockGeneration(pool, { timeoutMs: 0, batchSize: 1 }),
    )
      .resolves.toBe(0);
    expect(
      await activateQueueLockGeneration(pool, { batchSize: 1 }),
    ).toBe(2);

    const released = await pool.query<{
      held: boolean;
      marker: string | null;
    }>(
      `SELECT run_after = 'infinity'::timestamptz AS held,
              payload->>'_postilLockGenerationFence' AS marker
         FROM jobs WHERE id = $1`,
      [fencedId],
    );
    expect(released.rows[0]).toEqual({ held: false, marker: null });
    const firstGenerationAware = await claimJob(pool, "generation-aware-worker-1");
    expect(firstGenerationAware?.id).toBe(queuedBeforeMigrationId);
    expect(await completeJob(pool, firstGenerationAware!)).toBe("done");
    const generationAware = await claimJob(pool, "generation-aware-worker-2");
    expect(generationAware?.id).toBe(fencedId);
    expect(await activateQueueLockGeneration(pool)).toBe(0);
    expect(await completeJob(pool, generationAware!)).toBe("done");
  });

  test("fresh self-hosted activation releases work before its first worker claim", async () => {
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [QUEUE_LOCK_GENERATION_CAPABILITY],
    );
    const id = await enqueueReviewJobOnce(
      pool,
      validReviewPayload({
        prNumber: 83,
        headSha: "f".repeat(40),
        sourceDeliveryId: "fresh-self-hosted",
      }),
    );
    expect(id).not.toBeNull();
    if (id === null) throw new Error("fresh self-hosted job was not retained");
    expect(await claimJob(pool, "pre-activation-worker")).toBeNull();

    expect(await activateQueueLockGeneration(pool)).toBe(1);
    const claimed = await claimJob(pool, "first-self-hosted-worker");
    expect(claimed?.id).toBe(id);
    expect(claimed?.lockGeneration).toBe(1n);
  });

  test("self-hosted upgrade activation releases migration-fenced existing work", async () => {
    const id = await enqueueReviewJobOnce(
      pool,
      validReviewPayload({
        prNumber: 84,
        headSha: "e".repeat(40),
        sourceDeliveryId: "upgrade-self-hosted",
      }),
    );
    if (id === null) throw new Error("upgrade self-hosted job was not retained");
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [QUEUE_LOCK_GENERATION_CAPABILITY],
    );
    await expect(
      quiesceQueueForLockGeneration(pool, { timeoutMs: 0, batchSize: 1 }),
    ).resolves.toBe(0);
    expect(await claimJob(pool, "upgrade-fenced-worker")).toBeNull();

    expect(await activateQueueLockGeneration(pool)).toBe(1);
    expect((await claimJob(pool, "upgraded-self-hosted-worker"))?.id).toBe(id);
  });

  test("terminalizes a malformed candidate and claims the next runnable job", async () => {
    let malformedId: number;
    await pool.query(
      "ALTER TABLE jobs DISABLE TRIGGER jobs_suppress_duplicate_active_review_trigger",
    );
    try {
      const malformed = await pool.query<{ id: string }>(
        `INSERT INTO jobs (kind, payload, status)
         VALUES ('review', '{"prNumber":1}'::jsonb, 'queued')
         RETURNING id`,
      );
      malformedId = Number(malformed.rows[0]!.id);
    } finally {
      await pool.query(
        "ALTER TABLE jobs ENABLE TRIGGER jobs_suppress_duplicate_active_review_trigger",
      );
    }
    const runnableId = await enqueueJob(pool, "respond", { number: 1 });

    const claimed = await claimJob(pool, "progress-worker");
    expect(claimed?.id).toBe(runnableId);
    const malformed = await pool.query<{
      status: string;
      last_error: string | null;
    }>("SELECT status, last_error FROM jobs WHERE id = $1", [malformedId!]);
    expect(malformed.rows[0]).toEqual({
      status: "failed",
      last_error: "active review identity is invalid",
    });
  });

  test("leaves unsupported job kinds queued for a capable release", async () => {
    const unknownId = await enqueueJob(pool, "future-release-job", { version: 2 });
    const reviewId = await enqueueJob(pool, "review", validReviewPayload());

    const claimed = await claimJobWithCapabilities(pool, "current-worker", ["review"]);
    expect(claimed?.id).toBe(reviewId);
    expect(claimed?.kind).toBe("review");

    const unknown = await pool.query(
      "SELECT status, attempts, locked_by FROM jobs WHERE id = $1",
      [unknownId],
    );
    expect(unknown.rows[0]).toMatchObject({
      status: "queued",
      attempts: 0,
      locked_by: null,
    });
  });

  test("claims admitted acknowledgement work ahead of long review work", async () => {
    const reviewId = await enqueueJob(pool, "review", validReviewPayload());
    const reactionId = await enqueueJob(pool, "github-reaction", {
      sourceDeliveryId: "priority-reaction",
    });

    const claimed = await claimJobWithCapabilities(pool, "reaction-worker", [
      "review",
      "github-reaction",
    ]);
    expect(claimed?.id).toBe(reactionId);
    expect(claimed?.kind).toBe("github-reaction");
    expect(claimed?.id).not.toBe(reviewId);
  });

  test("reaction enqueue is lifetime-idempotent under concurrent redelivery", async () => {
    const payload = {
      installationId: 1,
      sourceInstallationId: 2,
      sourceOrgId: 3,
      githubRepoId: 4,
      repoFullName: "octo/repo",
      commentId: 5,
      commentKind: "issue_comment" as const,
      content: "eyes" as const,
      sourceDeliveryId: "reaction-delivery",
    };
    const inserted = await Promise.all(
      Array.from({ length: 12 }, () => enqueueGithubReactionJobOnce(pool, payload)),
    );
    expect(inserted.filter((id) => id !== null)).toHaveLength(1);

    await pool.query("UPDATE jobs SET status = 'done' WHERE kind = 'github-reaction'");
    expect(await enqueueGithubReactionJobOnce(pool, payload)).toBeNull();
  });

  test("serializes concurrent respond admission at the hourly cap", async () => {
    const admitted = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        enqueueRespondJobWithinHourlyCap(
          pool,
          {
            installationId: 991,
            repoFullName: "octo/capped",
            number: 7,
            isPr: false,
            comment: `request ${index}`,
            sourceDeliveryId: `capped-${index}`,
          },
          2,
        ),
      ),
    );

    expect(admitted.filter(({ id }) => id !== null)).toHaveLength(2);
    expect(admitted.filter(({ rateLimited }) => rateLimited)).toHaveLength(10);
    const existingIndex = admitted.findIndex(({ id }) => id !== null);
    expect(existingIndex).toBeGreaterThanOrEqual(0);
    await expect(
      enqueueRespondJobWithinHourlyCap(
        pool,
        {
          installationId: 991,
          repoFullName: "octo/capped",
          number: 7,
          isPr: false,
          comment: "retry",
          sourceDeliveryId: `capped-${existingIndex}`,
        },
        2,
      ),
    ).resolves.toEqual({ id: null, rateLimited: false });
  });

  test("stages new job kinds until the post-deploy capability activation", async () => {
    const scheduledFor = new Date("2026-08-16T12:00:00.000Z");
    const id = await enqueueJob(pool, "billing-contact-verification", { orgId: 1 });
    const deliveryId = await enqueueJob(
      pool,
      "respond-delivery",
      { jobId: 9 },
      { runAfter: scheduledFor },
    );
    const staged = await pool.query<{
      id: string;
      run_after: Date | string;
      scheduled_for: Date;
    }>(
      `SELECT id, run_after,
              (payload->>'_postilReleaseV1RunAfter')::timestamptz
                AS scheduled_for
         FROM jobs
        WHERE id = ANY($1::bigint[])
        ORDER BY id`,
      [[id, deliveryId]],
    );
    expect(String(staged.rows[0]?.run_after).toLowerCase()).toContain("infinity");
    expect(staged.rows[1]?.scheduled_for).toEqual(scheduledFor);

    // Reproduce the pre-capability worker query, which has no kind filter.
    const oldClaim = await pool.query(
      `SELECT id FROM jobs
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY id LIMIT 1`,
    );
    expect(oldClaim.rows).toHaveLength(0);

    expect(await activateReleaseJobs(pool, { batchSize: 1 })).toBe(2);
    const nowRunnable = await pool.query<{ id: string }>(
      `SELECT id FROM jobs
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY id`,
    );
    expect(nowRunnable.rows.map((row) => Number(row.id))).toEqual([id]);
    const scheduled = await pool.query<{
      run_after: Date;
      schedule_receipt: string | null;
    }>(
      `SELECT run_after,
              payload->>'_postilReleaseV1RunAfter' AS schedule_receipt
         FROM jobs WHERE id = $1`,
      [deliveryId],
    );
    expect(scheduled.rows[0]).toEqual({
      run_after: scheduledFor,
      schedule_receipt: null,
    });

    // Activation is idempotent, and later inserts are immediately runnable.
    expect(await activateReleaseJobs(pool)).toBe(0);
    const laterId = await enqueueJob(pool, "billing-contact-verification", { orgId: 2 });
    const later = await pool.query<{ runnable: boolean }>(
      "SELECT run_after <= now() AS runnable FROM jobs WHERE id = $1",
      [laterId],
    );
    expect(later.rows[0]?.runnable).toBe(true);
  });

  test("preserves a scheduled release job when release activation runs first", async () => {
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [QUEUE_LOCK_GENERATION_CAPABILITY],
    );
    const scheduledFor = new Date("2026-08-16T13:00:00.000Z");
    const id = await enqueueJob(
      pool,
      "respond-delivery",
      { jobId: 10 },
      { runAfter: scheduledFor },
    );

    expect(await activateReleaseJobs(pool, { batchSize: 1 })).toBe(1);
    const releaseFirst = await pool.query<{
      held: boolean;
      queue_schedule: Date;
      release_schedule: string | null;
    }>(
      `SELECT run_after = 'infinity'::timestamptz AS held,
              (payload->>'_postilLockGenerationRunAfter')::timestamptz
                AS queue_schedule,
              payload->>'_postilReleaseV1RunAfter' AS release_schedule
         FROM jobs WHERE id = $1`,
      [id],
    );
    expect(releaseFirst.rows[0]).toEqual({
      held: true,
      queue_schedule: scheduledFor,
      release_schedule: null,
    });

    expect(await activateQueueLockGeneration(pool, { batchSize: 1 })).toBe(1);
    const released = await pool.query<{
      run_after: Date;
      queue_schedule: string | null;
      release_schedule: string | null;
    }>(
      `SELECT run_after,
              payload->>'_postilLockGenerationRunAfter' AS queue_schedule,
              payload->>'_postilReleaseV1RunAfter' AS release_schedule
         FROM jobs WHERE id = $1`,
      [id],
    );
    expect(released.rows[0]).toEqual({
      run_after: scheduledFor,
      queue_schedule: null,
      release_schedule: null,
    });
  });

  test("serializes concurrent queue and release activation", async () => {
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [QUEUE_LOCK_GENERATION_CAPABILITY],
    );
    const scheduledFor = new Date("2026-08-16T14:00:00.000Z");
    const id = await enqueueJob(
      pool,
      "respond-delivery",
      { jobId: 11 },
      { runAfter: scheduledFor },
    );

    await expect(Promise.all([
      activateQueueLockGeneration(pool, { batchSize: 1, timeoutMs: 10_000 }),
      activateReleaseJobs(pool, { batchSize: 1, timeoutMs: 10_000 }),
    ])).resolves.toEqual(expect.arrayContaining([1, 1]));
    const released = await pool.query<{
      run_after: Date;
      queue_schedule: string | null;
      release_schedule: string | null;
    }>(
      `SELECT run_after,
              payload->>'_postilLockGenerationRunAfter' AS queue_schedule,
              payload->>'_postilReleaseV1RunAfter' AS release_schedule
         FROM jobs WHERE id = $1`,
      [id],
    );
    expect(released.rows[0]).toEqual({
      run_after: scheduledFor,
      queue_schedule: null,
      release_schedule: null,
    });
  }, 30_000);

  test("activates private author enforcement idempotently", async () => {
    expect(await activatePrivateReviewAuthorIdentity(pool)).toBe(true);
    expect(await activatePrivateReviewAuthorIdentity(pool)).toBe(false);
    const capability = await pool.query<{ name: string }>(
      "SELECT name FROM deployment_capabilities WHERE name = $1",
      [PRIVATE_REVIEW_AUTHOR_CAPABILITY],
    );
    expect(capability.rows).toEqual([{ name: PRIVATE_REVIEW_AUTHOR_CAPABILITY }]);
  });

  test("retires staged escalation email work and clears recipient material", async () => {
    const slug = `retirement-${randomUUID()}`;
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ($1, 'Retirement test')
       RETURNING id`,
      [slug],
    );
    const organizationId = organization.rows[0]!.id;
    await pool.query(
      `INSERT INTO org_settings (
         org_id,
         escalation_email,
         escalation_email_pending,
         escalation_email_verified_at,
         escalation_email_verification_token_digest,
         escalation_email_verification_token_ciphertext,
         escalation_email_verification_expires_at
       ) VALUES ($1, 'verified@example.test', 'pending@example.test', now(), $2, $3, now())`,
      [organizationId, Buffer.from("digest"), Buffer.from("ciphertext")],
    );
    const jobId = await enqueueJob(pool, "escalation-notification", {
      repository: "private/repository",
      finding: "sensitive finding body",
    });

    const staged = await pool.query<{ run_after: Date | string }>(
      "SELECT run_after FROM jobs WHERE id = $1",
      [jobId],
    );
    expect(String(staged.rows[0]?.run_after).toLowerCase()).toContain("infinity");
    expect(await quiesceEscalationEmailJobs(pool)).toMatchObject({ running: 0 });

    const result = await finalizeEscalationEmailRetirement(pool);
    expect(result).toMatchObject({
      running: 0,
      terminalized: 1,
      redacted: 1,
      clearedOrganizations: 1,
    });
    const job = await pool.query(
      "SELECT status, payload, last_error FROM jobs WHERE id = $1",
      [jobId],
    );
    expect(job.rows[0]).toMatchObject({
      status: "done",
      payload: {
        retired: true,
        reason: "human escalation uses the pull request gate",
      },
    });
    expect(job.rows[0].last_error).toBeNull();
    const settings = await pool.query(
      `SELECT escalation_email, escalation_email_pending,
              escalation_email_verified_at,
              escalation_email_verification_token_digest,
              escalation_email_verification_token_ciphertext,
              escalation_email_verification_expires_at
       FROM org_settings WHERE org_id = $1`,
      [organizationId],
    );
    expect(Object.values(settings.rows[0] ?? {}).every((value) => value === null)).toBe(true);
    await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  });

  test("quiescence persists while an old escalation email delivery is running", async () => {
    const queuedId = await enqueueJob(pool, "escalation-notification", { queued: true });
    const runningId = await enqueueJob(pool, "escalation-email-verification", {
      running: true,
    });
    const locked = await pool.query<{ locked_at: Date; lock_generation: string }>(
      `UPDATE jobs
       SET status = 'running', locked_at = now(), locked_by = 'old-worker',
           lock_generation = lock_generation + 1
       WHERE id = $1
       RETURNING locked_at, lock_generation::text`,
      [runningId],
    );

    await expect(
      quiesceEscalationEmailJobs(pool, { timeoutMs: 0 }),
    ).rejects.toThrow(
      "1 retired escalation email job(s) are still running after drain",
    );
    const queued = await pool.query<{ run_after: Date | string }>(
      "SELECT run_after FROM jobs WHERE id = $1",
      [queuedId],
    );
    expect(String(queued.rows[0]?.run_after).toLowerCase()).toContain("infinity");

    expect(
      await failJob(
        pool,
        {
          id: runningId,
          attempts: 1,
          maxAttempts: 3,
          lockedBy: "old-worker",
          lockGeneration: BigInt(locked.rows[0]!.lock_generation),
        },
        "provider timeout",
      ),
    ).toBe("retried");
    let retried = await pool.query<{ run_after: Date | string }>(
      "SELECT run_after FROM jobs WHERE id = $1",
      [runningId],
    );
    expect(String(retried.rows[0]?.run_after).toLowerCase()).toContain("infinity");

    await pool.query(
      `UPDATE jobs
       SET status = 'running', locked_at = now(), locked_by = 'old-worker',
           lock_generation = lock_generation + 1
       WHERE id = $1`,
      [runningId],
    );
    await pool.query(
      `UPDATE jobs
       SET status = 'queued', locked_at = NULL, locked_by = NULL,
           last_error = 'watchdog retry', run_after = now()
       WHERE id = $1`,
      [runningId],
    );
    retried = await pool.query<{ run_after: Date | string }>(
      "SELECT run_after FROM jobs WHERE id = $1",
      [runningId],
    );
    expect(String(retried.rows[0]?.run_after).toLowerCase()).toContain("infinity");
  });

  test("quiescence drains a bounded in-flight escalation email delivery", async () => {
    const runningId = await enqueueJob(pool, "escalation-notification", {
      running: true,
    });
    await pool.query(
      `UPDATE jobs
       SET status = 'running', locked_at = now(), locked_by = 'old-worker',
           lock_generation = lock_generation + 1
       WHERE id = $1`,
      [runningId],
    );
    const finish = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        pool
          .query(
            `UPDATE jobs
             SET status = 'done', locked_at = NULL, locked_by = NULL
             WHERE id = $1`,
            [runningId],
          )
          .then(() => resolve(), reject);
      }, 25);
    });

    const result = await quiesceEscalationEmailJobs(pool, {
      timeoutMs: 1_000,
      pollMs: 10,
    });
    await finish;

    expect(result.running).toBe(0);
  });

  test("a locked row is skipped, not waited on (SKIP LOCKED)", async () => {
    const first = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ n: 1, prNumber: 1 }),
    );
    const second = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ n: 2, prNumber: 2 }),
    );

    // Hold a row lock on the first job in an open transaction.
    const holder: PoolClient = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [first]);

      // The claimer must skip the locked row and take the second job
      // immediately instead of blocking.
      const job = await claimJob(pool, "worker-b");
      expect(job?.id).toBe(second);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  test("two concurrent claims never take the same job", async () => {
    await enqueueJob(pool, "review", validReviewPayload({ n: 1, prNumber: 1 }));
    await enqueueJob(pool, "review", validReviewPayload({ n: 2, prNumber: 2 }));
    const [a, b] = await Promise.all([claimJob(pool, "w1"), claimJob(pool, "w2")]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.id).not.toBe(b?.id);
  });

  test("worker shutdown requeues only its claims without consuming attempts", async () => {
    const first = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ n: 1, prNumber: 1 }),
    );
    const second = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ n: 2, prNumber: 2 }),
    );
    const sideEffect = await enqueueJob(pool, "respond", { n: 3 });
    const owned = await claimJob(pool, "worker-a#0");
    const foreign = await claimJob(pool, "worker-b#0");
    const ownedSideEffect = await claimJob(pool, "worker-a#1");
    expect(owned?.id).toBe(first);
    expect(foreign?.id).toBe(second);
    expect(ownedSideEffect?.id).toBe(sideEffect);

    expect(
      await requeueClaimedJobs(
        pool,
        "worker shutdown interrupted the claim",
        ["review"],
        [owned!, ownedSideEffect!],
      ),
    ).toBe(1);

    const rows = await pool.query<{
      id: string;
      status: string;
      attempts: number;
      locked_by: string | null;
      last_error: string | null;
    }>("SELECT id, status, attempts, locked_by, last_error FROM jobs ORDER BY id");
    expect(rows.rows).toEqual([
      {
        id: String(first),
        status: "queued",
        attempts: 0,
        locked_by: null,
        last_error: "worker shutdown interrupted the claim",
      },
      {
        id: String(second),
        status: "running",
        attempts: 1,
        locked_by: "worker-b#0",
        last_error: null,
      },
      {
        id: String(sideEffect),
        status: "running",
        attempts: 1,
        locked_by: "worker-a#1",
        last_error: null,
      },
    ]);
  });

  test("shutdown requeue rejects an immediate same-owner stale generation", async () => {
    await enqueueJob(pool, "respond", { number: 1 });
    const stale = await claimJob(pool, "reused-shutdown-worker");
    await pool.query(
      `UPDATE jobs
          SET status = 'queued', locked_at = NULL, locked_by = NULL,
              run_after = clock_timestamp()
        WHERE id = $1`,
      [stale!.id],
    );
    const current = await claimJob(pool, "reused-shutdown-worker");
    expect(current?.lockGeneration).toBe(stale!.lockGeneration + 1n);
    await pool.query("UPDATE jobs SET locked_at = $2 WHERE id = $1", [
      current!.id,
      stale!.lockedAt,
    ]);

    expect(
      await requeueClaimedJobs(pool, "late shutdown", ["respond"], [stale!]),
    ).toBe(0);
    const stillRunning = await pool.query<{
      status: string;
      locked_by: string;
      lock_generation: string;
      locked_at: Date;
    }>(
      `SELECT status, locked_by, lock_generation::text AS lock_generation, locked_at
         FROM jobs WHERE id = $1`,
      [current!.id],
    );
    expect(stillRunning.rows[0]).toEqual({
      status: "running",
      locked_by: "reused-shutdown-worker",
      lock_generation: String(current!.lockGeneration),
      locked_at: stale!.lockedAt,
    });
    expect(
      await requeueClaimedJobs(pool, "current shutdown", ["respond"], [current!]),
    ).toBe(1);
  });

  test("concurrent review enqueue creates one active job per repository PR head", async () => {
    const payload = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/repo",
      prNumber: 42,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      expectedPullRequestUpdatedAt: REVIEW_UPDATED_AT,
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => enqueueReviewJobOnce(pool, payload)),
    );

    expect(results.filter((id) => id !== null)).toHaveLength(1);
    const active = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM jobs
        WHERE kind = 'review' AND status IN ('queued', 'running')
          AND payload->>'repoFullName' = $1
          AND payload->>'prNumber' = $2
          AND payload->>'headSha' = $3`,
      [payload.repoFullName, String(payload.prNumber), payload.headSha],
    );
    expect(Number(active.rows[0]?.count)).toBe(1);

    await pool.query("UPDATE jobs SET status = 'done' WHERE kind = 'review'");
    expect(await enqueueReviewJobOnce(pool, payload)).not.toBeNull();
  });

  test("replacement insertion cannot invert the enqueue lock order", async () => {
    const payload = {
      installationId: 1,
      githubRepoId: 991,
      repoFullName: "octo/no-lock-inversion",
      prNumber: 42,
      headSha: "9".repeat(40),
      baseSha: "8".repeat(40),
      expectedPullRequestUpdatedAt: REVIEW_UPDATED_AT,
    };
    const id = await enqueueReviewJobOnce(pool, payload);
    if (id === null) throw new Error("review job was not retained");
    await pool.query(
      `UPDATE jobs
          SET status = 'running', locked_by = 'promotion-worker',
              locked_at = clock_timestamp(),
              lock_generation = lock_generation + 1
        WHERE id = $1`,
      [id],
    );

    const promotion = await pool.connect();
    const enqueue = await pool.connect();
    try {
      await promotion.query("BEGIN");
      await enqueue.query("BEGIN");
      await promotion.query("SET LOCAL statement_timeout = '2s'");
      await enqueue.query("SET LOCAL statement_timeout = '2s'");
      await promotion.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [id]);
      const pullRequestIdentity = [String(payload.githubRepoId), String(payload.prNumber)].join(
        "\u001f",
      );
      const legacyIdentity = [
        payload.repoFullName,
        String(payload.prNumber),
        payload.headSha,
      ].join("\u001f");
      const stableIdentity = [
        String(payload.githubRepoId),
        String(payload.prNumber),
        payload.headSha,
      ].join("\u001f");
      for (const lock of [
        `postil:review-pr:${pullRequestIdentity}`,
        `postil:active-review:${legacyIdentity}`,
        `postil:active-review:${stableIdentity}`,
      ]) {
        await enqueue.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [lock],
        );
      }
      const waitingEnqueue = enqueue.query(
        `SELECT id
           FROM jobs
          WHERE id = $1 AND status IN ('queued', 'running')
          FOR UPDATE`,
        [id],
      );
      await Bun.sleep(20);

      await promotion.query(
        "UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL WHERE id = $1",
        [id],
      );
      const inserted = await promotion.query<{ id: string }>(
        `INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
         VALUES ('review', $1, 'queued', clock_timestamp(), 3)
         RETURNING id`,
        [JSON.stringify({ ...payload, sourceDeliveryId: "replacement" })],
      );
      await promotion.query("COMMIT");
      await waitingEnqueue;
      await enqueue.query("COMMIT");

      expect(inserted.rows).toHaveLength(1);
      const trigger = await pool.query<{ definition: string }>(
        `SELECT pg_get_functiondef(
           'suppress_duplicate_active_review_job()'::regprocedure
         ) AS definition`,
      );
      expect(trigger.rows[0]?.definition).not.toContain(
        "pg_advisory_xact_lock",
      );
    } finally {
      await promotion.query("ROLLBACK").catch(() => undefined);
      await enqueue.query("ROLLBACK").catch(() => undefined);
      promotion.release();
      enqueue.release();
    }
  });

  test("rejects an invalid review repository identity before enqueue", async () => {
    await expect(
      enqueueReviewJobOnce(pool, {
        installationId: 1,
        githubRepoId: undefined as unknown as number,
        repoFullName: "octo/repo",
        prNumber: 42,
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        expectedPullRequestUpdatedAt: REVIEW_UPDATED_AT,
      }),
    ).rejects.toThrow("review job requires a positive GitHub repository ID");
  });

  test("a newer queued edit starts a fresh budget and retains sticky intent", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/queued-upgrade",
      prNumber: 42,
      headSha: "a".repeat(40),
      baseSha: "old-base",
      sourceDeliveryId: "initial",
      expectedPullRequestUpdatedAt: REVIEW_UPDATED_AT,
      trigger: {
        source: "automatic_pull_request" as const,
        webhookDeliveryId: "initial",
        webhookEvent: "pull_request" as const,
      },
    };
    const id = await enqueueReviewJobOnce(pool, initial);
    expect(id).not.toBeNull();
    if (id === null) throw new Error("initial review job was not retained");

    expect(
      await enqueueReviewJobOnce(pool, {
        ...initial,
        sourceDeliveryId: "requested",
        forceFullReview: true,
        trigger: {
          source: "requested_review",
          webhookDeliveryId: "requested",
          webhookEvent: "issue_comment",
          sourceCommentId: 987,
        },
      }),
    ).toBe(id);
    await pool.query(
      `UPDATE jobs
          SET attempts = 19,
              created_at = clock_timestamp() - interval '2 hours',
              run_after = clock_timestamp() + interval '30 minutes',
              reconciliation_deadline_at = clock_timestamp() + interval '1 minute'
        WHERE id = $1`,
      [id],
    );
    const replacementId = await enqueueReviewJobOnce(pool, {
      ...initial,
      sourceDeliveryId: "newest",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
      trigger: {
        source: "automatic_pull_request",
        webhookDeliveryId: "newest",
        webhookEvent: "pull_request",
        webhookAction: "edited",
      },
    });
    expect(replacementId).not.toBeNull();
    expect(replacementId).not.toBe(id);
    expect(
      await enqueueReviewJobOnce(pool, {
        ...initial,
        sourceDeliveryId: "last-arrival",
        expectedPullRequestUpdatedAt: "2026-08-10T00:00:05.000Z",
        trigger: {
          source: "automatic_pull_request",
          webhookDeliveryId: "last-arrival",
          webhookEvent: "pull_request",
          webhookAction: "edited",
        },
      }),
    ).toBeNull();

    const rows = await pool.query<{
      id: string;
      status: string;
      attempts: number;
      run_after: Date;
      created_at: Date;
      reconciliation_deadline_at: Date | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, status, attempts, run_after, created_at,
              reconciliation_deadline_at, payload
         FROM jobs
        WHERE id IN ($1, $2)
        ORDER BY id`,
      [id, replacementId],
    );
    expect(rows.rows[0]).toMatchObject({
      id: String(id),
      status: "done",
      attempts: 19,
    });
    expect(rows.rows[1]).toMatchObject({
      id: String(replacementId),
      status: "queued",
      attempts: 0,
      reconciliation_deadline_at: null,
    });
    expect(rows.rows[1]!.created_at.getTime()).toBeGreaterThan(
      rows.rows[0]!.created_at.getTime(),
    );
    expect(rows.rows[1]!.run_after.getTime()).toBeLessThanOrEqual(Date.now());
    expect(rows.rows[1]?.payload).toMatchObject({
      baseSha: "old-base",
      sourceDeliveryId: "newest",
      forceFullReview: true,
      trigger: {
        source: "requested_review",
        webhookDeliveryId: "requested",
        sourceCommentId: 987,
      },
    });
  });

  test("same-head requests during a running review produce one retained rerun", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/running-upgrade",
      prNumber: 43,
      headSha: "c".repeat(40),
      baseSha: "base",
      sourceDeliveryId: "initial",
      expectedPullRequestUpdatedAt: REVIEW_UPDATED_AT,
    };
    const id = await enqueueReviewJobOnce(pool, initial);
    if (id === null) throw new Error("initial review job was not retained");
    const running = await claimJob(pool, "running-worker");
    expect(running?.id).toBe(id);

    const requested = {
      ...initial,
      baseSha: "new-base",
      sourceDeliveryId: "requested",
      forceFullReview: true,
      trigger: {
        source: "requested_review" as const,
        webhookDeliveryId: "requested",
        webhookEvent: "issue_comment" as const,
        sourceCommentId: 988,
      },
    };
    const retained = await Promise.all(
      Array.from({ length: 12 }, () => enqueueReviewJobOnce(pool, requested)),
    );
    expect(retained.filter((result) => result !== null)).toEqual([id]);

    expect(await completeJob(pool, running!)).toBe("coalesced");
    const rerun = await claimJob(pool, "rerun-worker");
    expect(rerun).toMatchObject({
      attempts: 1,
      payload: {
        baseSha: "new-base",
        sourceDeliveryId: "requested",
        forceFullReview: true,
      },
    });
    expect(rerun?.id).not.toBe(id);
    expect(await completeJob(pool, rerun!)).toBe("done");
    expect(await claimJob(pool, "extra-worker")).toBeNull();
  });

  test("a newer same-head edit blocks the claimed input and survives as its rerun", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/running-edit",
      prNumber: 44,
      headSha: "e".repeat(40),
      baseSha: "base",
      sourceDeliveryId: "initial-edit",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:05.000Z",
    };
    const id = await enqueueReviewJobOnce(pool, initial);
    if (id === null) throw new Error("initial edit review was not retained");
    const running = await claimJob(pool, "running-edit-worker");
    expect(running?.id).toBe(id);

    const newerEdit = {
      ...initial,
      sourceDeliveryId: "newer-edit",
      forceFullReview: true,
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
    };
    expect(await enqueueReviewJobOnce(pool, newerEdit)).toBe(id);
    expect(
      await reviewInputLeaseState(
        pool,
        running!,
        initial.expectedPullRequestUpdatedAt,
      ),
    ).toBe("newer-pending");

    expect(await completeJob(pool, running!)).toBe("coalesced");
    const rerun = await claimJob(pool, "newer-edit-worker");
    expect(rerun).toMatchObject({
      attempts: 1,
      payload: {
        sourceDeliveryId: "newer-edit",
        forceFullReview: true,
        expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
      },
    });
    expect(
      await reviewInputLeaseState(
        pool,
        rerun!,
        newerEdit.expectedPullRequestUpdatedAt,
      ),
    ).toBe("current");
  });

  test("equal-timestamp same-head edits retain arrival order and supersede the claim", async () => {
    const initial = validReviewPayload({
      prNumber: 45,
      headSha: "4".repeat(40),
      sourceDeliveryId: "equal-edit-a",
      forceFullReview: true,
      trigger: {
        source: "automatic_pull_request",
        webhookDeliveryId: "equal-edit-a",
        webhookEvent: "pull_request",
        webhookAction: "edited",
      },
    });
    const id = await enqueueReviewJobOnce(pool, initial);
    if (id === null) throw new Error("equal-timestamp edit was not retained");
    const running = await claimJob(pool, "equal-edit-worker");
    expect(running?.id).toBe(id);

    expect(
      await enqueueReviewJobOnce(pool, {
        ...initial,
        sourceDeliveryId: "equal-edit-b",
        trigger: {
          ...initial.trigger!,
          webhookDeliveryId: "equal-edit-b",
        },
      }),
    ).toBe(id);
    expect(
      await reviewInputLeaseState(
        pool,
        running!,
        initial.expectedPullRequestUpdatedAt,
        running!.payload.reviewInputSequence as string,
      ),
    ).toBe("newer-pending");
    expect(await completeJob(pool, running!)).toBe("coalesced");
    const rerun = await claimJob(pool, "equal-edit-rerun-worker");
    expect(rerun?.payload).toMatchObject({
      sourceDeliveryId: "equal-edit-b",
      expectedPullRequestUpdatedAt: initial.expectedPullRequestUpdatedAt,
      forceFullReview: true,
    });
    expect(
      BigInt(rerun!.payload.reviewInputSequence as string),
    ).toBeGreaterThan(BigInt(running!.payload.reviewInputSequence as string));
  });

  test("equal-timestamp base changes retain exact successor provenance", async () => {
    const initial = validReviewPayload({
      prNumber: 46,
      headSha: "5".repeat(40),
      baseSha: "old-base",
      sourceDeliveryId: "equal-base-a",
      forceFullReview: true,
    });
    const id = await enqueueReviewJobOnce(pool, initial);
    if (id === null) throw new Error("equal-timestamp base change was not retained");
    const running = await claimJob(pool, "equal-base-worker");

    expect(
      await enqueueReviewJobOnce(pool, {
        ...initial,
        baseSha: "new-base",
        sourceDeliveryId: "equal-base-b",
      }),
    ).toBe(id);
    expect(
      await reviewInputLeaseState(
        pool,
        running!,
        initial.expectedPullRequestUpdatedAt,
        running!.payload.reviewInputSequence as string,
      ),
    ).toBe("newer-pending");
    expect(await completeJob(pool, running!)).toBe("coalesced");
    expect((await claimJob(pool, "equal-base-rerun"))?.payload).toMatchObject({
      baseSha: "new-base",
      sourceDeliveryId: "equal-base-b",
    });
  });

  test("reversed equal-timestamp base arrival converges to the worker-observed snapshot", async () => {
    const current = validReviewPayload({
      prNumber: 58,
      headSha: "8".repeat(40),
      baseSha: "new-merge-base",
      sourceDeliveryId: "equal-base-current",
      forceFullReview: true,
    });
    const currentId = await enqueueReviewJobOnce(pool, current);
    if (currentId === null) throw new Error("current base snapshot was not retained");

    const stale = {
      ...current,
      baseSha: "old-merge-base",
      sourceDeliveryId: "equal-base-stale",
    };
    const staleId = await enqueueReviewJobOnce(pool, stale);
    if (staleId === null) throw new Error("reversed stale snapshot was not retained");
    expect(staleId).not.toBe(currentId);

    const running = await claimJob(pool, "equal-base-reversed-worker");
    expect(running?.payload).toMatchObject({
      baseSha: "old-merge-base",
      sourceDeliveryId: "equal-base-stale",
    });
    expect(
      await enqueueObservedReviewSnapshot(
        pool,
        running!.payload as ReviewJobPayload,
        {
          headSha: current.headSha,
          baseSha: current.baseSha,
          updatedAt: current.expectedPullRequestUpdatedAt,
        },
      ),
    ).toBe(staleId);
    expect(
      await reviewInputLeaseState(
        pool,
        running!,
        stale.expectedPullRequestUpdatedAt,
        running!.payload.reviewInputSequence as string,
      ),
    ).toBe("newer-pending");
    expect(await completeJob(pool, running!)).toBe("coalesced");

    const converged = await claimJob(pool, "equal-base-converged-worker");
    expect(converged?.payload).toMatchObject({
      headSha: current.headSha,
      baseSha: "new-merge-base",
      expectedPullRequestUpdatedAt: current.expectedPullRequestUpdatedAt,
    });
    expect(converged?.payload).not.toHaveProperty("sourceDeliveryId");
    expect(await completeJob(pool, converged!)).toBe("done");
  });

  test("publication fence closes the former authorization-to-publication window", async () => {
    const initial = validReviewPayload({
      prNumber: 47,
      headSha: "6".repeat(40),
      sourceDeliveryId: "fence-a",
      forceFullReview: true,
    });
    const id = await enqueueReviewJobOnce(pool, initial);
    if (id === null) throw new Error("publication-fence input was not retained");
    const running = await claimJob(pool, "publication-fence-worker");
    expect(running?.id).toBe(id);

    let releasePublication!: () => void;
    const holdPublication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let fenceEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      fenceEntered = resolve;
    });
    const order: string[] = [];
    const publication = withReviewPublicationFence(pool, initial, async () => {
      expect(
        await reviewInputLeaseState(
          pool,
          running!,
          initial.expectedPullRequestUpdatedAt,
          running!.payload.reviewInputSequence as string,
        ),
      ).toBe("current");
      fenceEntered();
      await holdPublication;
      order.push("published");
    });
    await entered;

    const mutation = enqueueReviewJobOnce(pool, {
      ...initial,
      sourceDeliveryId: "fence-b",
    }).then((result) => {
      order.push("mutation-committed");
      return result;
    });
    await waitForAdvisoryWaiter(pool);
    expect(order).toEqual([]);
    releasePublication();

    await expect(publication).resolves.toBeUndefined();
    await expect(mutation).resolves.toBe(id);
    expect(order).toEqual(["published", "mutation-committed"]);
    expect(
      await reviewInputLeaseState(
        pool,
        running!,
        initial.expectedPullRequestUpdatedAt,
        running!.payload.reviewInputSequence as string,
      ),
    ).toBe("newer-pending");
  });

  test("a delayed running event cannot replace newer retained metadata", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/running-delayed-edit",
      prNumber: 144,
      headSha: "1".repeat(40),
      baseSha: "base",
      sourceDeliveryId: "initial",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
    };
    const id = await enqueueReviewJobOnce(pool, initial);
    if (id === null) throw new Error("initial review job was not retained");
    const running = await claimJob(pool, "running-delayed-worker");
    await enqueueReviewJobOnce(pool, {
      ...initial,
      sourceDeliveryId: "newest",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:20.000Z",
    });

    expect(
      await enqueueReviewJobOnce(pool, {
        ...initial,
        sourceDeliveryId: "delayed",
        expectedPullRequestUpdatedAt: "2026-08-10T00:00:15.000Z",
      }),
    ).toBeNull();
    expect(await completeJob(pool, running!)).toBe("coalesced");
    const rerun = await claimJob(pool, "running-delayed-rerun");
    expect(rerun?.payload).toMatchObject({
      sourceDeliveryId: "newest",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:20.000Z",
    });
  });

  test("publication recovery remains immutable while incoming work coalesces", async () => {
    const recovery = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/publication-recovery",
      prNumber: 145,
      headSha: "2".repeat(40),
      baseSha: "base",
      recoveryReviewId: 77,
      sourceDeliveryId: "recovery",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
    };
    const id = await enqueueReviewJobOnce(pool, recovery);
    if (id === null) throw new Error("recovery review job was not retained");
    expect(
      await enqueueReviewJobOnce(pool, {
        ...recovery,
        recoveryReviewId: undefined,
        sourceDeliveryId: "newer-edit",
        expectedPullRequestUpdatedAt: "2026-08-10T00:00:20.000Z",
      }),
    ).toBe(id);
    const stored = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM jobs WHERE id = $1",
      [id],
    );
    expect(stored.rows[0]?.payload).toMatchObject({
      recoveryReviewId: 77,
      sourceDeliveryId: "recovery",
      providerRetryLineage: `review-job:${id}`,
      [COALESCED_REVIEW_PAYLOAD_KEY]: {
        sourceDeliveryId: "newer-edit",
        providerRetryLineage: `review-job:${id}`,
        expectedPullRequestUpdatedAt: "2026-08-10T00:00:20.000Z",
      },
    });
    expect(
      stored.rows[0]?.payload[COALESCED_REVIEW_PAYLOAD_KEY],
    ).not.toHaveProperty("recoveryReviewId");

    const running = await claimJob(pool, "publication-recovery-worker");
    expect(
      await retryJobIndefinitely(
        pool,
        running!,
        "publication verification deferred",
      ),
    ).toBe("retried");
    const retry = await pool.query<{
      id: string;
      status: string;
      payload: Record<string, unknown>;
    }>("SELECT id, status, payload FROM jobs WHERE id = $1", [id]);
    expect(retry.rows[0]).toMatchObject({
      id: String(id),
      status: "queued",
      payload: {
        recoveryReviewId: 77,
        [COALESCED_REVIEW_PAYLOAD_KEY]: {
          sourceDeliveryId: "newer-edit",
        },
      },
    });
    await pool.query("UPDATE jobs SET run_after = clock_timestamp() WHERE id = $1", [id]);
    const recoveryRetry = await claimJob(pool, "publication-recovery-retry");
    expect(await completeJob(pool, recoveryRetry!)).toBe("coalesced");
    const incoming = await claimJob(pool, "publication-recovery-incoming");
    expect(incoming?.payload).toMatchObject({ sourceDeliveryId: "newer-edit" });
    expect(incoming?.payload.providerRetryLineage).toBe(`review-job:${id}`);
    expect(incoming?.payload).not.toHaveProperty("recoveryReviewId");
  });

  test("mixed legacy promotion reconstructs the provider lineage from the retiring job", async () => {
    const payload = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/legacy-lineage",
      prNumber: 146,
      headSha: "3".repeat(40),
      baseSha: "base",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
    };
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, max_attempts)
       VALUES ('review', $1::jsonb, 'running', 3)
       RETURNING id`,
      [
        JSON.stringify({
          ...payload,
          [COALESCED_REVIEW_PAYLOAD_KEY]: {
            ...payload,
            expectedPullRequestUpdatedAt: "2026-08-10T00:00:20.000Z",
          },
        }),
      ],
    );
    const id = Number(inserted.rows[0]!.id);
    await pool.query(
      `UPDATE jobs
          SET locked_by = 'legacy-worker', locked_at = now(), lock_generation = 1
        WHERE id = $1`,
      [id],
    );

    expect(
      await completeJob(pool, {
        id,
        lockedBy: "legacy-worker",
        lockGeneration: 1n,
      }),
    ).toBe("coalesced");
    const promoted = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM jobs WHERE kind = 'review' AND status = 'queued'",
    );
    expect(promoted.rows[0]?.payload.providerRetryLineage).toBe(
      `review-job:${id}`,
    );
  });

  test("a terminal failure promotes its retained review", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/failed-upgrade",
      prNumber: 44,
      headSha: "d".repeat(40),
      baseSha: "base",
      expectedPullRequestUpdatedAt: REVIEW_UPDATED_AT,
    };
    const id = await enqueueReviewJobOnce(pool, initial);
    if (id === null) throw new Error("initial review job was not retained");
    await pool.query("UPDATE jobs SET max_attempts = 7 WHERE id = $1", [id]);
    const running = await claimJob(pool, "failing-worker");
    await enqueueReviewJobOnce(pool, {
      ...initial,
      forceFullReview: true,
      sourceDeliveryId: "edited",
    });

    expect(
      await failJob(pool, running!, "permanent failure", {
        permanent: true,
        failureFollowup: {
          kind: "respond-failure-comment",
          payload: { respondJobId: running!.id },
          maxAttempts: 5,
        },
      }),
    ).toBe("coalesced");
    const row = await pool.query<{
      status: string;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT status, attempts, max_attempts, last_error, payload
         FROM jobs
        WHERE kind = 'review' AND status = 'queued'`,
    );
    expect(row.rows[0]).toMatchObject({
      status: "queued",
      attempts: 0,
      max_attempts: 7,
      last_error: null,
      payload: { forceFullReview: true, sourceDeliveryId: "edited" },
    });
    const failed = await pool.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM jobs WHERE id = $1",
      [id],
    );
    expect(failed.rows[0]).toEqual({
      status: "failed",
      last_error: "permanent failure",
    });
    expect(
      await pool.query("SELECT 1 FROM jobs WHERE kind = 'respond-failure-comment'"),
    ).toHaveProperty("rowCount", 0);
  });

  test("a transient failure records the old attempt before promoting retained intent", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/transient-upgrade",
      prNumber: 45,
      headSha: "e".repeat(40),
      baseSha: "base",
      expectedPullRequestUpdatedAt: REVIEW_UPDATED_AT,
    };
    const id = await enqueueReviewJobOnce(pool, initial);
    if (id === null) throw new Error("initial review job was not retained");
    const running = await claimJob(pool, "transient-worker");
    await enqueueReviewJobOnce(pool, {
      ...initial,
      forceFullReview: true,
      sourceDeliveryId: "requested",
    });

    expect(await failJob(pool, running!, "provider unavailable")).toBe("coalesced");
    const rows = await pool.query<{
      id: string;
      status: string;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
    }>(
      `SELECT id, status, attempts, max_attempts, last_error
         FROM jobs
        WHERE kind = 'review'
        ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      {
        id: String(id),
        status: "failed",
        attempts: 1,
        max_attempts: 3,
        last_error: "provider unavailable",
      },
      {
        id: expect.any(String),
        status: "queued",
        attempts: 0,
        max_attempts: 3,
        last_error: null,
      },
    ]);
    expect(rows.rows[1]?.id).not.toBe(String(id));
  });

  test("a queued base retarget creates a fresh immutable publication identity", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/base-retarget",
      prNumber: 46,
      headSha: "f".repeat(40),
      baseSha: "old-base",
      expectedPullRequestUpdatedAt: REVIEW_UPDATED_AT,
    };
    const initialId = await enqueueReviewJobOnce(pool, initial);
    if (initialId === null) throw new Error("initial review job was not retained");

    const replacementId = await enqueueReviewJobOnce(pool, {
      ...initial,
      baseSha: "new-base",
      forceFullReview: true,
      sourceDeliveryId: "base-retarget",
    });
    expect(replacementId).not.toBeNull();
    expect(replacementId).not.toBe(initialId);
    const rows = await pool.query<{
      id: string;
      status: string;
      base_sha: string;
    }>(
      `SELECT id, status, payload->>'baseSha' AS base_sha
         FROM jobs
        WHERE kind = 'review'
        ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { id: String(initialId), status: "done", base_sha: "old-base" },
      { id: String(replacementId), status: "queued", base_sha: "new-base" },
    ]);
  });

  test("jobs scheduled in the future are not claimed", async () => {
    await enqueueJob(pool, "review", validReviewPayload({ n: 1 }), {
      runAfter: new Date(Date.now() + 60_000),
    });
    expect(await claimJob(pool, "w")).toBeNull();
    expect(await queueDepth(pool)).toBe(1);
  });

  test("failJob requeues with backoff until attempts are exhausted", async () => {
    await enqueueJob(pool, "review", validReviewPayload({ n: 1 }), {
      maxAttempts: 2,
    });

    const firstTry = await claimJob(pool, "w");
    expect(firstTry?.attempts).toBe(1);
    expect(await failJob(pool, firstTry!, "boom 1")).toBe("retried");

    let row = await pool.query("SELECT status, run_after > now() AS deferred, last_error FROM jobs");
    expect(row.rows[0].status).toBe("queued");
    expect(row.rows[0].deferred).toBe(true);
    expect(row.rows[0].last_error).toBe("boom 1");

    // Not claimable until the backoff elapses; pull it forward manually.
    expect(await claimJob(pool, "w")).toBeNull();
    await pool.query("UPDATE jobs SET run_after = now()");

    const secondTry = await claimJob(pool, "w");
    expect(secondTry?.attempts).toBe(2);
    const failedAfter = new Date();
    expect(await failJob(pool, secondTry!, "boom 2")).toBe("failed");

    row = await pool.query("SELECT status, run_after FROM jobs");
    expect(row.rows[0].status).toBe("failed");
    expect(new Date(row.rows[0].run_after).getTime()).toBeGreaterThanOrEqual(
      failedAfter.getTime(),
    );
    expect(await claimJob(pool, "w")).toBeNull();
  });

  test("failJob atomically enqueues its terminal follow-up", async () => {
    const payload = {
      installationId: 42,
      repoFullName: "octo/repo",
      number: 7,
      isPr: true,
      comment: "@postil explain",
    };
    await enqueueJob(pool, "respond", payload, { maxAttempts: 1 });
    const job = await claimJob(pool, "w");

    expect(
      await failJob(pool, job!, "provider request failed", {
        failureFollowup: {
          kind: "respond-failure-comment",
          payload: { ...payload, respondJobId: job!.id },
          maxAttempts: 5,
        },
      }),
    ).toBe("failed");

    const rows = await pool.query<{
      kind: string;
      status: string;
      payload: Record<string, unknown>;
    }>("SELECT kind, status, payload FROM jobs ORDER BY id");
    expect(rows.rows).toEqual([
      { kind: "respond", status: "failed", payload },
      {
        kind: "respond-failure-comment",
        status: "queued",
        payload: { ...payload, respondJobId: job!.id },
      },
    ]);
  });

  test("failJob {permanent} fails immediately without consuming remaining attempts", async () => {
    // A deterministic error (broken CA store, missing binary) must not burn the
    // retry budget: the very first attempt goes straight to `failed`.
    await enqueueJob(pool, "review", validReviewPayload({ n: 1 }), {
      maxAttempts: 3,
    });

    const job = await claimJob(pool, "w");
    expect(job?.attempts).toBe(1);
    expect(job?.maxAttempts).toBe(3);

    // attempts (1) < maxAttempts (3): the default path would requeue. The
    // permanent flag overrides that and performs the running -> failed flip.
    const outcome = await failJob(
      pool,
      job!,
      "No CA certificates were loaded from the system",
      { permanent: true },
    );
    expect(outcome).toBe("failed");

    const row = await pool.query("SELECT status, attempts, last_error FROM jobs WHERE id = $1", [
      job!.id,
    ]);
    expect(row.rows[0].status).toBe("failed");
    // Only the one attempt was consumed; the other two were skipped.
    expect(row.rows[0].attempts).toBe(1);
    expect(row.rows[0].last_error).toContain("No CA certificates");
    expect(await claimJob(pool, "w")).toBeNull();
  });

  test("durable reconciliation requeues after its ordinary retry budget", async () => {
    await enqueueJob(pool, "review", validReviewPayload({ reconcile: true }), {
      maxAttempts: 1,
    });
    const job = await claimJob(pool, "reconciler");
    expect(job?.attempts).toBe(1);

    expect(
      await retryJobIndefinitely(pool, job!, "GitHub unavailable"),
    ).toBe("retried");
    const row = await pool.query(
      `SELECT status, max_attempts, last_error,
              run_after < reconciliation_deadline_at AS scheduled_within_budget
         FROM jobs WHERE id = $1`,
      [job!.id],
    );
    expect(row.rows[0]).toMatchObject({
      status: "queued",
      max_attempts: 1,
      last_error: "GitHub unavailable",
      scheduled_within_budget: true,
    });
  });

  test("an expired reconciliation retry is terminalized before claim", async () => {
    const id = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ reconcile: true }),
    );
    const first = await claimJob(pool, "reconciler");
    expect(await retryJobIndefinitely(pool, first!, "GitHub unavailable")).toBe(
      "retried",
    );
    await pool.query(
      `UPDATE jobs
          SET run_after = clock_timestamp(),
              reconciliation_deadline_at = clock_timestamp()
        WHERE id = $1`,
      [id],
    );

    expect(await claimJob(pool, "late-reconciler")).toBeNull();
    const row = await pool.query<{ status: string; last_error: string }>(
      "SELECT status, last_error FROM jobs WHERE id = $1",
      [id],
    );
    expect(row.rows[0]).toMatchObject({ status: "failed" });
    expect(row.rows[0]?.last_error).toContain(
      "reconciliation budget exhausted before claim",
    );
  });

  test("claim-time expiration promotes retained review provenance and provider lineage", async () => {
    const initial = validReviewPayload({
      repoFullName: "octo/claim-expiration-promotion",
      prNumber: 81,
    });
    const id = await enqueueReviewJobOnce(pool, initial);
    if (id === null) throw new Error("initial review job was not retained");
    const parent = (
      await pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM jobs WHERE id = $1",
        [id],
      )
    ).rows[0]!.payload;
    const pending = {
      ...initial,
      baseSha: "c".repeat(40),
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
      sourceDeliveryId: "claim-expiration-delivery",
      trigger: {
        source: "automatic_pull_request",
        webhookDeliveryId: "claim-expiration-delivery",
        webhookEvent: "pull_request",
        webhookAction: "edited",
      },
    };
    await pool.query(
      `UPDATE jobs
          SET payload = jsonb_set(payload, ARRAY[$2]::text[], $3::jsonb, true),
              run_after = clock_timestamp(),
              reconciliation_deadline_at = clock_timestamp()
        WHERE id = $1`,
      [id, COALESCED_REVIEW_PAYLOAD_KEY, JSON.stringify(pending)],
    );

    const promotedClaim = await claimJob(pool, "expiration-worker");
    expect(promotedClaim).not.toBeNull();
    const rows = await pool.query<{
      id: string;
      status: string;
      payload: Record<string, unknown>;
    }>("SELECT id, status, payload FROM jobs WHERE kind = 'review' ORDER BY id");
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ id: String(id), status: "failed" });
    expect(rows.rows[1]).toMatchObject({
      status: "running",
      payload: {
        baseSha: "c".repeat(40),
        sourceDeliveryId: "claim-expiration-delivery",
        expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
        providerRetryLineage: parent.providerRetryLineage,
        trigger: { webhookDeliveryId: "claim-expiration-delivery" },
      },
    });
    expect(rows.rows[1]!.payload).not.toHaveProperty(COALESCED_REVIEW_PAYLOAD_KEY);
  });

  test("candidate expiration race promotes retained input after the sweep limit", async () => {
    await pool.query(
      `INSERT INTO jobs
         (kind, payload, status, run_after, reconciliation_deadline_at)
       SELECT 'respond', '{}'::jsonb, 'queued', clock_timestamp(), clock_timestamp()
         FROM generate_series(1, 100)`,
    );
    const initial = validReviewPayload({
      repoFullName: "octo/candidate-expiration-promotion",
      prNumber: 82,
    });
    const id = await enqueueReviewJobOnce(pool, initial);
    if (id === null) throw new Error("initial review job was not retained");
    const parent = (
      await pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM jobs WHERE id = $1",
        [id],
      )
    ).rows[0]!.payload;
    const pending = {
      ...initial,
      forceFullReview: true,
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:11.000Z",
      sourceDeliveryId: "candidate-expiration-delivery",
    };
    await pool.query(
      `UPDATE jobs
          SET payload = jsonb_set(payload, ARRAY[$2]::text[], $3::jsonb, true),
              reconciliation_deadline_at = clock_timestamp()
        WHERE id = $1`,
      [id, COALESCED_REVIEW_PAYLOAD_KEY, JSON.stringify(pending)],
    );

    const promotedClaim = await claimJob(pool, "candidate-expiration-worker");
    expect(promotedClaim).not.toBeNull();
    const rows = await pool.query<{
      id: string;
      status: string;
      payload: Record<string, unknown>;
    }>("SELECT id, status, payload FROM jobs WHERE kind = 'review' ORDER BY id");
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ id: String(id), status: "failed" });
    expect(rows.rows[1]).toMatchObject({
      status: "running",
      payload: {
        sourceDeliveryId: "candidate-expiration-delivery",
        forceFullReview: true,
        providerRetryLineage: parent.providerRetryLineage,
      },
    });
  });

  test("durable reconciliation keeps requeuing within its budget despite exhausted attempts", async () => {
    // Production showed attempts=10 and attempts=28 against max_attempts=3:
    // indefinite reconciliation must never consult attempts. Wall clock is
    // the only thing that can end it.
    const id = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ reconcile: true }),
      { maxAttempts: 1 },
    );
    const job = await claimJob(pool, "reconciler");
    expect(job?.attempts).toBe(1);

    expect(
      await retryJobIndefinitely(
        pool,
        { ...job!, attempts: 10 },
        "GitHub unavailable",
        60 * 60 * 1000,
      ),
    ).toBe("retried");
    const row = await pool.query(
      "SELECT status, max_attempts FROM jobs WHERE id = $1",
      [id],
    );
    expect(row.rows[0]).toMatchObject({ status: "queued", max_attempts: 1 });
  });

  test("durable reconciliation immediately promotes retained input within its budget", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/reconciliation-retry-upgrade",
      prNumber: 47,
      headSha: "a".repeat(40),
      baseSha: "base",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:05.000Z",
    };
    const initialId = await enqueueReviewJobOnce(pool, initial);
    if (initialId === null) throw new Error("initial review job was not retained");
    const running = await claimJob(pool, "reconciler");
    await enqueueReviewJobOnce(pool, {
      ...initial,
      sourceDeliveryId: "newer-edit-before-budget",
      forceFullReview: true,
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
    });

    expect(
      await retryJobIndefinitely(
        pool,
        running!,
        "GitHub unavailable",
        60 * 60 * 1000,
      ),
    ).toBe("coalesced");

    const rows = await pool.query<{
      id: string;
      status: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, status, payload
         FROM jobs
        WHERE kind = 'review'
        ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      id: String(initialId),
      status: "failed",
    });
    expect(rows.rows[1]).toMatchObject({
      status: "queued",
      payload: {
        sourceDeliveryId: "newer-edit-before-budget",
        forceFullReview: true,
        expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
      },
    });
    expect(rows.rows[1]?.payload).not.toHaveProperty(
      COALESCED_REVIEW_PAYLOAD_KEY,
    );
  });

  test("durable reconciliation exhausts before a retry could reach its deadline", async () => {
    const id = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ reconcile: true }),
      { maxAttempts: 1 },
    );
    await pool.query(
      "UPDATE jobs SET created_at = now() - interval '59 minutes' WHERE id = $1",
      [id],
    );
    const job = await claimJob(pool, "reconciler");
    expect(job).not.toBeNull();

    expect(
      await retryJobIndefinitely(
        pool,
        { ...job!, attempts: 20 },
        "GitHub unavailable",
        60 * 60 * 1000,
      ),
    ).toBe("exhausted");
    const row = await pool.query<{
      status: string;
      last_error: string;
    }>(
      `SELECT status, last_error
         FROM jobs WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toMatchObject({ status: "failed" });
    expect(row.rows[0]?.last_error).toContain("reconciliation budget");
  });

  test("reconciliation exhaustion atomically promotes one retained review input", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/reconciliation-upgrade",
      prNumber: 46,
      headSha: "f".repeat(40),
      baseSha: "base",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:05.000Z",
    };
    const initialId = await enqueueReviewJobOnce(pool, initial);
    if (initialId === null) throw new Error("initial review job was not retained");
    await pool.query(
      "UPDATE jobs SET created_at = clock_timestamp() - interval '2 seconds' WHERE id = $1",
      [initialId],
    );
    const running = await claimJob(pool, "reconciler");
    await enqueueReviewJobOnce(pool, {
      ...initial,
      sourceDeliveryId: "newer-edit",
      forceFullReview: true,
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
    });

    expect(
      await retryJobIndefinitely(
        pool,
        running!,
        "GitHub unavailable",
        1_000,
      ),
    ).toBe("coalesced");

    const rows = await pool.query<{
      id: string;
      status: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, status, payload
         FROM jobs
        WHERE kind = 'review'
        ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      id: String(initialId),
      status: "failed",
    });
    expect(rows.rows[1]).toMatchObject({
      status: "queued",
      payload: {
        sourceDeliveryId: "newer-edit",
        forceFullReview: true,
        expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
      },
    });
    expect(rows.rows[1]?.payload).not.toHaveProperty(
      COALESCED_REVIEW_PAYLOAD_KEY,
    );
  });

  test("durable reconciliation retry cannot mutate a newer exact claim", async () => {
    await enqueueJob(pool, "review", validReviewPayload({ reconcile: true }));
    const first = await claimJob(pool, "reused-worker");
    await pool.query(
      `UPDATE jobs
          SET status = 'queued', locked_at = NULL, locked_by = NULL,
              run_after = now()
        WHERE id = $1`,
      [first!.id],
    );
    const second = await claimJob(pool, "reused-worker");
    expect(second?.lockGeneration).toBe(first!.lockGeneration + 1n);

    expect(
      await retryJobIndefinitely(pool, first!, "late retry"),
    ).toBe("lost");
    const row = await pool.query<{
      status: string;
      locked_by: string;
      locked_at: Date;
      lock_generation: string;
    }>(
      `SELECT status, locked_by, locked_at,
              lock_generation::text AS lock_generation
         FROM jobs WHERE id = $1`,
      [first!.id],
    );
    expect(row.rows[0]).toEqual({
      status: "running",
      locked_by: "reused-worker",
      locked_at: second!.lockedAt,
      lock_generation: String(second!.lockGeneration),
    });
  });

  test("durable reconciliation exhaustion cannot terminalize a newer exact claim", async () => {
    const id = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ reconcile: true }),
    );
    await pool.query(
      "UPDATE jobs SET created_at = clock_timestamp() - interval '2 seconds' WHERE id = $1",
      [id],
    );
    const first = await claimJob(pool, "reused-worker");
    await pool.query(
      `UPDATE jobs
          SET status = 'queued', locked_at = NULL, locked_by = NULL,
              run_after = now()
        WHERE id = $1`,
      [first!.id],
    );
    const second = await claimJob(pool, "reused-worker");
    expect(second?.lockGeneration).toBe(first!.lockGeneration + 1n);

    expect(
      await retryJobIndefinitely(
        pool,
        first!,
        "late exhaustion",
        1_000,
      ),
    ).toBe("lost");
    const row = await pool.query<{
      status: string;
      locked_by: string;
      locked_at: Date;
      lock_generation: string;
    }>(
      `SELECT status, locked_by, locked_at,
              lock_generation::text AS lock_generation
         FROM jobs WHERE id = $1`,
      [first!.id],
    );
    expect(row.rows[0]).toEqual({
      status: "running",
      locked_by: "reused-worker",
      locked_at: second!.lockedAt,
      lock_generation: String(second!.lockGeneration),
    });
  });

  test("durable reconciliation fails permanently once its wall-clock budget is exceeded", async () => {
    const id = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ reconcile: true }),
      { maxAttempts: 1 },
    );
    await pool.query(
      "UPDATE jobs SET created_at = now() - interval '2 hours' WHERE id = $1",
      [id],
    );
    const job = await claimJob(pool, "reconciler");

    expect(
      await retryJobIndefinitely(pool, job!, "GitHub unavailable", 60 * 60 * 1000),
    ).toBe("exhausted");
    const row = await pool.query(
      "SELECT status, last_error FROM jobs WHERE id = $1",
      [id],
    );
    expect(row.rows[0].status).toBe("failed");
    expect(row.rows[0].last_error).toContain("reconciliation budget");
    // A permanently exhausted job never comes back for another attempt.
    expect(await claimJob(pool, "reconciler")).toBeNull();
  });

  test("failJob {permanent} on an already-failed job returns 'lost' (single-post guard holds)", async () => {
    // The conditional running -> failed UPDATE is shared with the exhausted
    // path, so the permanent path also yields exactly one "failed" winner.
    await enqueueJob(pool, "respond", { n: 1 }, { maxAttempts: 3 });
    const job = await claimJob(pool, "w");

    expect(await failJob(pool, job!, "builder error", { permanent: true })).toBe("failed");
    expect(await failJob(pool, job!, "builder error", { permanent: true })).toBe("lost");

    const row = await pool.query("SELECT status FROM jobs WHERE id = $1", [job!.id]);
    expect(row.rows[0].status).toBe("failed");
  });

  test("a second failJob on an already-failed job returns 'lost' (single-post guard)", async () => {
    // The runner and the watchdog can both reach the final-fail path for the
    // same job. Only the call that performs the `running` -> `failed`
    // transition returns "failed" and owns the user-facing reply; a later
    // call sees the row already failed and returns "lost", so the reply is
    // posted at most once.
    await enqueueJob(pool, "respond", { n: 1 }, { maxAttempts: 1 });
    const job = await claimJob(pool, "w");
    expect(job?.attempts).toBe(1);

    expect(await failJob(pool, job!, "boom")).toBe("failed");
    let row = await pool.query("SELECT status FROM jobs WHERE id = $1", [job!.id]);
    expect(row.rows[0].status).toBe("failed");

    // Replaying the same final-fail (e.g. the other path) does not re-transition.
    expect(await failJob(pool, job!, "boom again")).toBe("lost");
    row = await pool.query("SELECT status FROM jobs WHERE id = $1", [job!.id]);
    expect(row.rows[0].status).toBe("failed");
  });

  test("failJob retry does not resurrect a job another worker re-claimed (returns 'lost')", async () => {
    // H1 race: worker W claims J; the job stalls past the watchdog deadline;
    // the watchdog requeues J; worker W2 re-claims and is now running J; then
    // W's late transient error reaches failJob's retry branch. Without the
    // exact running-lease guard, W would reset the running row back to 'queued'
    // and a third worker could run J concurrently with W2. With the generation
    // guard, W's retry matches 0 rows and returns "lost", leaving W2's claim
    // intact.
    await enqueueJob(pool, "review", validReviewPayload({ n: 1 }), {
      maxAttempts: 3,
    });

    const w1 = await claimJob(pool, "w1");
    expect(w1?.attempts).toBe(1);

    // Simulate the watchdog requeue: status back to 'queued', lock cleared.
    await pool.query(
      "UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, run_after = now() WHERE id = $1",
      [w1!.id],
    );

    // Worker W2 re-claims the same row; it is now 'running' under W2 (attempt 2).
    const w2 = await claimJob(pool, "w2");
    expect(w2?.id).toBe(w1?.id);
    expect(w2?.attempts).toBe(2);

    // W's late transient retry must NOT resurrect the row W2 now owns.
    expect(await failJob(pool, w1!, "late transient from w1")).toBe("lost");

    const row = await pool.query(
      "SELECT status, locked_by, attempts FROM jobs WHERE id = $1",
      [w1!.id],
    );
    // Still claimed-and-running under W2; not reset to 'queued'.
    expect(row.rows[0].status).toBe("running");
    expect(row.rows[0].locked_by).toBe("w2");
    expect(row.rows[0].attempts).toBe(2);
    // The row is not re-claimable while W2 holds it (no second concurrent run).
    expect(await claimJob(pool, "w3")).toBeNull();
  });

  test("failJob retry still requeues when the caller still owns the running row", async () => {
    // Control for the guard above: the normal retry path (no intervening
    // re-claim) must keep working and return "retried".
    await enqueueJob(pool, "review", validReviewPayload({ n: 1 }), {
      maxAttempts: 3,
    });
    const job = await claimJob(pool, "w");
    expect(job?.attempts).toBe(1);
    expect(await failJob(pool, job!, "transient boom")).toBe("retried");
    const row = await pool.query("SELECT status FROM jobs WHERE id = $1", [job!.id]);
    expect(row.rows[0].status).toBe("queued");
  });

  test("failJob rejects stale same-owner retry and follow-up claims", async () => {
    const retryId = await enqueueJob(
      pool,
      "review",
      validReviewPayload({ n: 1 }),
      { maxAttempts: 3 },
    );
    const staleRetry = await claimJob(pool, "reused-failure-worker");
    await pool.query(
      `UPDATE jobs
          SET status = 'queued', locked_at = NULL, locked_by = NULL,
              run_after = clock_timestamp()
        WHERE id = $1`,
      [retryId],
    );
    const currentRetry = await claimJob(pool, "reused-failure-worker");
    expect(currentRetry?.lockGeneration).toBe(staleRetry!.lockGeneration + 1n);
    expect(await failJob(pool, staleRetry!, "late transient failure")).toBe(
      "lost",
    );

    await pool.query(
      "UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL WHERE id = $1",
      [retryId],
    );
    const finalId = await enqueueJob(pool, "respond", { n: 2 });
    const staleFinal = await claimJob(pool, "reused-failure-worker");
    await pool.query(
      `UPDATE jobs
          SET status = 'queued', locked_at = NULL, locked_by = NULL,
              run_after = clock_timestamp()
        WHERE id = $1`,
      [finalId],
    );
    const currentFinal = await claimJob(pool, "reused-failure-worker");
    expect(currentFinal?.lockGeneration).toBe(staleFinal!.lockGeneration + 1n);
    expect(
      await failJob(pool, staleFinal!, "late permanent failure", {
        permanent: true,
        failureFollowup: {
          kind: "respond-failure-comment",
          payload: { respondJobId: finalId },
          maxAttempts: 3,
        },
      }),
    ).toBe("lost");
    expect(
      await pool.query(
        "SELECT 1 FROM jobs WHERE kind = 'respond-failure-comment'",
      ),
    ).toHaveProperty("rowCount", 0);
  });

  test("completeJob rejects an immediate stale same-owner claim with identical lockedAt", async () => {
    await enqueueJob(pool, "review", validReviewPayload({ n: 1 }), {
      maxAttempts: 3,
    });
    const stale = await claimJob(pool, "reused-completion-worker");

    await pool.query(
      "UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, run_after = now() WHERE id = $1",
      [stale!.id],
    );
    const current = await claimJob(pool, "reused-completion-worker");
    expect(current?.id).toBe(stale?.id);
    expect(current?.lockGeneration).toBe(stale!.lockGeneration + 1n);
    await pool.query(
      "UPDATE jobs SET locked_at = $2 WHERE id = $1",
      [stale!.id, stale!.lockedAt],
    );
    const currentWithCollidingTimestamp = {
      ...current!,
      lockedAt: stale!.lockedAt,
    };

    expect(await completeJob(pool, stale!)).toBe("lost");
    const row = await pool.query(
      `SELECT status, locked_by, locked_at,
              lock_generation::text AS lock_generation
         FROM jobs WHERE id = $1`,
      [stale!.id],
    );
    expect(row.rows[0].status).toBe("running");
    expect(row.rows[0].locked_by).toBe("reused-completion-worker");
    expect(row.rows[0].locked_at).toEqual(stale!.lockedAt);
    expect(BigInt(row.rows[0].lock_generation)).toBe(current!.lockGeneration);
    expect(await completeJob(pool, currentWithCollidingTimestamp)).toBe("done");
  });

  test("continueClaimedJob rejects a stale same-owner claim", async () => {
    await enqueueJob(pool, "review", validReviewPayload({ stage: "old" }));
    const stale = await claimJob(pool, "reused-continuation-worker");
    await pool.query(
      "UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, run_after = now() WHERE id = $1",
      [stale!.id],
    );
    const current = await claimJob(pool, "reused-continuation-worker");
    expect(current?.lockGeneration).toBe(stale!.lockGeneration + 1n);

    await expect(
      continueClaimedJob(pool, stale!, { stage: "new" }),
    ).rejects.toThrow("job continuation lost its lease");
    const row = await pool.query(
      "SELECT status, locked_by, locked_at, payload FROM jobs WHERE id = $1",
      [stale!.id],
    );
    expect(row.rows[0]).toMatchObject({
      status: "running",
      locked_by: "reused-continuation-worker",
      locked_at: current!.lockedAt,
      payload: { stage: "old" },
    });
  });

  test("completeJob marks the job done and releases the lock", async () => {
    await enqueueJob(pool, "review", validReviewPayload({ n: 1 }));
    const job = await claimJob(pool, "w");
    await completeJob(pool, job!);
    const row = await pool.query("SELECT status, locked_by FROM jobs");
    expect(row.rows[0].status).toBe("done");
    expect(row.rows[0].locked_by).toBeNull();
  });
});

describe("backoff schedule", () => {
  test("doubles per attempt and caps at 15 minutes", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(10)).toBe(15 * 60_000);
  });
});
