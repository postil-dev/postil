import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";
import {
  backoffMs,
  claimJob as claimJobWithCapabilities,
  completeJob,
  enqueueGithubReactionJobOnce,
  enqueueJob,
  enqueueRespondJobWithinHourlyCap,
  enqueueReviewJobOnce,
  failJob,
  queueDepth,
  requeueJobsOwnedBy,
  retryJobIndefinitely,
} from "@/lib/queue";
import {
  finalizeEscalationEmailRetirement,
  quiesceEscalationEmailJobs,
} from "@/lib/escalation-email-retirement";
import {
  activatePrivateReviewAuthorIdentity,
  activateReleaseJobs,
  PRIVATE_REVIEW_AUTHOR_CAPABILITY,
} from "@/lib/release-job-rollout";

/**
 * Queue claim semantics against a real Postgres (FOR UPDATE SKIP LOCKED
 * cannot be meaningfully unit-tested without one). Set
 * POSTIL_TEST_DATABASE_URL to run; the suite is skipped otherwise.
 */

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;

const describeDb = TEST_URL ? describe : describe.skip;
const TEST_JOB_KINDS = ["review", "respond"] as const;

function claimJob(pool: Pool, workerId: string) {
  return claimJobWithCapabilities(pool, workerId, TEST_JOB_KINDS);
}

describeDb("postgres job queue", () => {
  let db: EphemeralDatabase;
  let pool: Pool;

  beforeAll(async () => {
    db = await createEphemeralDatabase("queue");
    pool = db.pool;
  }, 30_000);

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE private_worker_rehearsals, respond_deliveries, jobs, deployment_capabilities RESTART IDENTITY",
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  test("claim returns the oldest runnable job and marks it running", async () => {
    const id = await enqueueJob(pool, "review", { prNumber: 1 });
    const job = await claimJob(pool, "worker-a");
    expect(job).not.toBeNull();
    expect(job?.id).toBe(id);
    expect(job?.kind).toBe("review");
    expect(job?.payload).toEqual({ prNumber: 1 });
    expect(job?.attempts).toBe(1);
    expect(job?.createdAt).toBeInstanceOf(Date);
    expect(job?.lockedAt).toBeInstanceOf(Date);
    expect(job!.lockedAt.getTime()).toBeGreaterThanOrEqual(job!.createdAt.getTime());

    const row = await pool.query(
      "SELECT status, locked_by, created_at, locked_at FROM jobs WHERE id = $1",
      [id],
    );
    expect(row.rows[0].status).toBe("running");
    expect(row.rows[0].locked_by).toBe("worker-a");
    expect(job?.createdAt).toEqual(row.rows[0].created_at);
    expect(job?.lockedAt).toEqual(row.rows[0].locked_at);
  });

  test("leaves unsupported job kinds queued for a capable release", async () => {
    const unknownId = await enqueueJob(pool, "future-release-job", { version: 2 });
    const reviewId = await enqueueJob(pool, "review", { prNumber: 1 });

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
    const reviewId = await enqueueJob(pool, "review", { prNumber: 1 });
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
    const id = await enqueueJob(pool, "billing-contact-verification", { orgId: 1 });
    const deliveryId = await enqueueJob(pool, "respond-delivery", { jobId: 9 });
    const staged = await pool.query<{ run_after: Date | string }>(
      "SELECT run_after FROM jobs WHERE id = $1",
      [id],
    );
    expect(String(staged.rows[0]?.run_after).toLowerCase()).toContain("infinity");

    // Reproduce the pre-capability worker query, which has no kind filter.
    const oldClaim = await pool.query(
      `SELECT id FROM jobs
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY id LIMIT 1`,
    );
    expect(oldClaim.rows).toHaveLength(0);

    expect(await activateReleaseJobs(pool)).toBe(2);
    const nowRunnable = await pool.query<{ id: string }>(
      `SELECT id FROM jobs
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY id`,
    );
    expect(nowRunnable.rows.map((row) => Number(row.id))).toEqual([id, deliveryId]);

    // Activation is idempotent, and later inserts are immediately runnable.
    expect(await activateReleaseJobs(pool)).toBe(0);
    const laterId = await enqueueJob(pool, "billing-contact-verification", { orgId: 2 });
    const later = await pool.query<{ runnable: boolean }>(
      "SELECT run_after <= now() AS runnable FROM jobs WHERE id = $1",
      [laterId],
    );
    expect(later.rows[0]?.runnable).toBe(true);
  });

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
    await pool.query(
      `UPDATE jobs
       SET status = 'running', locked_at = now(), locked_by = 'old-worker'
       WHERE id = $1`,
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
        { id: runningId, attempts: 1, maxAttempts: 3, lockedBy: "old-worker" },
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
       SET status = 'running', locked_at = now(), locked_by = 'old-worker'
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
       SET status = 'running', locked_at = now(), locked_by = 'old-worker'
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
    const first = await enqueueJob(pool, "review", { n: 1 });
    const second = await enqueueJob(pool, "review", { n: 2 });

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
    await enqueueJob(pool, "review", { n: 1 });
    await enqueueJob(pool, "review", { n: 2 });
    const [a, b] = await Promise.all([claimJob(pool, "w1"), claimJob(pool, "w2")]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.id).not.toBe(b?.id);
  });

  test("worker shutdown requeues only its claims without consuming attempts", async () => {
    const first = await enqueueJob(pool, "review", { n: 1 });
    const second = await enqueueJob(pool, "review", { n: 2 });
    const sideEffect = await enqueueJob(pool, "respond", { n: 3 });
    const owned = await claimJob(pool, "worker-a#0");
    const foreign = await claimJob(pool, "worker-b#0");
    const ownedSideEffect = await claimJob(pool, "worker-a#1");
    expect(owned?.id).toBe(first);
    expect(foreign?.id).toBe(second);
    expect(ownedSideEffect?.id).toBe(sideEffect);

    expect(
      await requeueJobsOwnedBy(
        pool,
        "worker-a#",
        "worker shutdown interrupted the claim",
        ["review"],
        [first, sideEffect],
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

  test("concurrent review enqueue creates one active job per repository PR head", async () => {
    const payload = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/repo",
      prNumber: 42,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
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

  test("same-head queued reviews retain newest metadata and sticky full-review intent", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/queued-upgrade",
      prNumber: 42,
      headSha: "a".repeat(40),
      baseSha: "old-base",
      sourceDeliveryId: "initial",
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
    expect(
      await enqueueReviewJobOnce(pool, {
        ...initial,
        sourceDeliveryId: "newest",
        trigger: {
          source: "automatic_pull_request",
          webhookDeliveryId: "newest",
          webhookEvent: "pull_request",
          webhookAction: "edited",
        },
      }),
    ).toBe(id);

    const row = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM jobs WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.payload).toMatchObject({
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

  test("a terminal failure promotes its retained review", async () => {
    const initial = {
      installationId: 1,
      githubRepoId: 99,
      repoFullName: "octo/failed-upgrade",
      prNumber: 44,
      headSha: "d".repeat(40),
      baseSha: "base",
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
    await enqueueJob(pool, "review", { n: 1 }, { runAfter: new Date(Date.now() + 60_000) });
    expect(await claimJob(pool, "w")).toBeNull();
    expect(await queueDepth(pool)).toBe(1);
  });

  test("failJob requeues with backoff until attempts are exhausted", async () => {
    await enqueueJob(pool, "review", { n: 1 }, { maxAttempts: 2 });

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
    await enqueueJob(pool, "review", { n: 1 }, { maxAttempts: 3 });

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
    await enqueueJob(pool, "review", { reconcile: true }, { maxAttempts: 1 });
    const job = await claimJob(pool, "reconciler");
    expect(job?.attempts).toBe(1);

    expect(
      await retryJobIndefinitely(pool, job!, "GitHub unavailable"),
    ).toBe("retried");
    const row = await pool.query(
      "SELECT status, max_attempts, last_error FROM jobs WHERE id = $1",
      [job!.id],
    );
    expect(row.rows[0]).toMatchObject({
      status: "queued",
      max_attempts: 1,
      last_error: "GitHub unavailable",
    });
  });

  test("durable reconciliation keeps requeuing within its budget despite exhausted attempts", async () => {
    // Production showed attempts=10 and attempts=28 against max_attempts=3:
    // indefinite reconciliation must never consult attempts. Wall clock is
    // the only thing that can end it.
    const id = await enqueueJob(pool, "review", { reconcile: true }, { maxAttempts: 1 });
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

  test("durable reconciliation fails permanently once its wall-clock budget is exceeded", async () => {
    const id = await enqueueJob(pool, "review", { reconcile: true }, { maxAttempts: 1 });
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
    // `status='running' AND locked_by=$owner` guard, W would reset the running
    // row back to 'queued' and a third worker could run J concurrently with W2.
    // With the guard, W's retry matches 0 rows (W2 holds the lock under a new
    // attempt) and returns "lost", leaving W2's claim intact.
    await enqueueJob(pool, "review", { n: 1 }, { maxAttempts: 3 });

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
    await enqueueJob(pool, "review", { n: 1 }, { maxAttempts: 3 });
    const job = await claimJob(pool, "w");
    expect(job?.attempts).toBe(1);
    expect(await failJob(pool, job!, "transient boom")).toBe("retried");
    const row = await pool.query("SELECT status FROM jobs WHERE id = $1", [job!.id]);
    expect(row.rows[0].status).toBe("queued");
  });

  test("completeJob does not stamp 'done' over a re-claimed running job", async () => {
    // Symmetric defense-in-depth: a worker finishing late must not mark a job
    // 'done' after the watchdog requeued it and another worker re-claimed it.
    await enqueueJob(pool, "review", { n: 1 }, { maxAttempts: 3 });
    const w1 = await claimJob(pool, "w1");

    // Watchdog requeue + W2 re-claim.
    await pool.query(
      "UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, run_after = now() WHERE id = $1",
      [w1!.id],
    );
    const w2 = await claimJob(pool, "w2");
    expect(w2?.id).toBe(w1?.id);

    // W1 completes late; the guard means it does not clobber W2's running claim.
    await completeJob(pool, w1!);
    const row = await pool.query("SELECT status, locked_by FROM jobs WHERE id = $1", [w1!.id]);
    expect(row.rows[0].status).toBe("running");
    expect(row.rows[0].locked_by).toBe("w2");
  });

  test("completeJob marks the job done and releases the lock", async () => {
    await enqueueJob(pool, "review", { n: 1 });
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
