import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { Pool } from "pg";

import { closeDb, getDb, type Database } from "@/lib/db";
import type { Envelope } from "@/lib/envelope";
import { COALESCED_REVIEW_PAYLOAD_KEY } from "@/lib/queue";
import {
  finalizeStagedReviewCompletionWithGateMode,
  markReviewStaleWithDurableCleanup,
} from "@/lib/review-completion";
import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("stale review cleanup transaction", () => {
  let database: EphemeralDatabase;
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    database = await createEphemeralDatabase("review_stale_cleanup");
    pool = database.pool;
    await closeDb();
    process.env.DATABASE_URL = database.url;
    db = getDb();
  }, 30_000);

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE jobs, reviews, repositories, installations, organizations RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await closeDb();
    await database?.drop();
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  async function seedReview(): Promise<number> {
    const organization = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name, github_org_id) VALUES ('octo', 'Octo', 1) RETURNING id",
    );
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations (github_installation_id, org_id, account_login, account_type)
       VALUES (11, $1, 'octo', 'Organization') RETURNING id`,
      [organization.rows[0]!.id],
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name)
       VALUES ($1, 22, 'octo/repo') RETURNING id`,
      [installation.rows[0]!.id],
    );
    const review = await pool.query<{ id: string }>(
      `INSERT INTO reviews (repository_id, pr_number, head_sha, base_sha, status)
       VALUES ($1, 7, 'head', 'base', 'running') RETURNING id`,
      [repository.rows[0]!.id],
    );
    return Number(review.rows[0]!.id);
  }

  function cleanupInput(reviewId: number) {
    return {
      reviewId,
      installationId: 11,
      repoFullName: "octo/repo",
      headSha: "head",
      advisoryCheckRunId: 101,
      gateCheckRunId: 102,
      advisoryCheckExternalId: `postil:${reviewId}:review`,
      gateCheckExternalId: `postil:${reviewId}:gate`,
      advisoryCheckRunMayExist: false,
      gateCheckRunMayExist: false,
      message: "superseded by newer pull request input",
      intent: "neutralize" as const,
    };
  }

  test("concurrent stale transitions retain one exact retryable cleanup", async () => {
    const reviewId = await seedReview();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        markReviewStaleWithDurableCleanup(
          db,
          cleanupInput(reviewId),
        ),
      ),
    );

    const state = await pool.query<{ status: string; cleanup_count: number }>(
      `SELECT review.status,
              (SELECT count(*)::int FROM jobs
                WHERE kind = 'check-run-cleanup'
                  AND payload->>'reviewId' = $1::text) AS cleanup_count
         FROM reviews review
        WHERE review.id = $1::bigint`,
      [reviewId],
    );
    expect(state.rows[0]).toEqual({ status: "stale", cleanup_count: 1 });
  });

  test("cleanup insertion failure rolls back the stale transition", async () => {
    const reviewId = await seedReview();
    await pool.query(`
      CREATE FUNCTION reject_cleanup_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind = 'check-run-cleanup' THEN
          RAISE EXCEPTION 'fixture cleanup rejection';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_cleanup_fixture_trigger
        BEFORE INSERT ON jobs
        FOR EACH ROW EXECUTE FUNCTION reject_cleanup_fixture();
    `);
    await expect(
      markReviewStaleWithDurableCleanup(
        db,
        cleanupInput(reviewId),
      ),
    ).rejects.toThrow("Failed query");
    expect(
      (await pool.query<{ status: string }>("SELECT status FROM reviews WHERE id = $1", [reviewId]))
        .rows[0]?.status,
    ).toBe("running");
    await pool.query(`
      DROP TRIGGER reject_cleanup_fixture_trigger ON jobs;
      DROP FUNCTION reject_cleanup_fixture();
    `);
  });

  test("retarget committed during forge verification cancels completion and promotes input", async () => {
    const reviewId = await seedReview();
    const identity = (
      await pool.query<{
        org_id: string;
        repository_id: string;
        public_id: string;
      }>(
        `SELECT installation.org_id, review.repository_id,
                review.public_id::text
           FROM reviews review
           JOIN repositories repository ON repository.id = review.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
          WHERE review.id = $1`,
        [reviewId],
      )
    ).rows[0]!;
    const reviewEnvelope: Envelope = {
      version: 1,
      summary: "",
      silent: true,
      findings: [],
      resolved: [],
      suppressedFindings: [],
      counts: { info: 0, warn: 0, error: 0, suppressed: 0, ungrounded: 0 },
      confidenceBuckets: [0, 0, 0, 0, 0],
      gate: { failOn: "error", failing: false },
      modelUsed: "test/model",
      usage: { promptTokens: 1, completionTokens: 1 },
      durationMs: 1,
      baseSha: "base",
      headSha: "head",
      sinceSha: null,
    };
    await pool.query(
      `UPDATE reviews
          SET envelope = $2, advisory_check_run_id = 101,
              gate_check_run_id = 102
        WHERE id = $1`,
      [reviewId, JSON.stringify(reviewEnvelope)],
    );
    const expectedReviewInput = {
      installationId: 11,
      sourceInstallationId: 1,
      sourceOrgId: Number(identity.org_id),
      githubRepoId: 22,
      repoFullName: "octo/repo",
      prNumber: 7,
      headSha: "head",
      baseSha: "base",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:05.000Z",
      providerRetryLineage: "provider-lineage-one",
      recoveryReviewId: reviewId,
    };
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs
         (kind, payload, status, locked_at, locked_by, lock_generation)
       VALUES ('review', $1, 'running', now(), 'publication-worker', 1)
       RETURNING id`,
      [JSON.stringify(expectedReviewInput)],
    );
    const jobId = Number(job.rows[0]!.id);
    const newerInput = {
      ...expectedReviewInput,
      baseSha: "new-base",
      expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
      sourceDeliveryId: "retarget-delivery",
    };

    const retarget = await pool.connect();
    await retarget.query("BEGIN");
    await retarget.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`postil:review-pr:${["22", "7"].join("\u001f")}`],
    );
    await retarget.query(
      `UPDATE jobs
          SET payload = jsonb_set(payload, ARRAY[$2]::text[], $3::jsonb, true)
        WHERE id = $1`,
      [jobId, COALESCED_REVIEW_PAYLOAD_KEY, JSON.stringify(newerInput)],
    );
    const completionPromise = finalizeStagedReviewCompletionWithGateMode(
      db,
      {
        reviewId,
        usage: [],
        usageAccountingComplete: true,
        reviewJobLease: {
          id: jobId,
          lockedBy: "publication-worker",
          lockGeneration: 1n,
        },
        expectedReviewInput,
        staleCleanup: cleanupInput(reviewId),
      },
      Number(identity.org_id),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await retarget.query("COMMIT");
    retarget.release();

    await expect(completionPromise).resolves.toMatchObject({
      completed: false,
      superseded: true,
      promoted: true,
    });
    const state = await pool.query<{
      review_status: string;
      cleanup_count: number;
      gate_sync_count: number;
      old_job_status: string;
      promoted_payload: Record<string, unknown>;
    }>(
      `SELECT review.status AS review_status,
              (SELECT count(*)::int FROM jobs WHERE kind = 'check-run-cleanup') AS cleanup_count,
              (SELECT count(*)::int FROM jobs WHERE kind = 'gate-state-sync') AS gate_sync_count,
              (SELECT status FROM jobs WHERE id = $2) AS old_job_status,
              (SELECT payload FROM jobs
                WHERE kind = 'review' AND id <> $2 ORDER BY id DESC LIMIT 1) AS promoted_payload
         FROM reviews review
        WHERE review.id = $1`,
      [reviewId, jobId],
    );
    expect(state.rows[0]).toMatchObject({
      review_status: "stale",
      cleanup_count: 1,
      gate_sync_count: 0,
      old_job_status: "failed",
      promoted_payload: {
        baseSha: "new-base",
        expectedPullRequestUpdatedAt: "2026-08-10T00:00:10.000Z",
        sourceDeliveryId: "retarget-delivery",
        providerRetryLineage: "provider-lineage-one",
      },
    });
  });
});
