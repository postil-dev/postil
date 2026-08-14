import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import {
  claimJob,
  enqueueReviewJobOnce,
  reviewInputLeaseState,
  withReviewPublicationFence,
} from "@/lib/queue";
import {
  activateQueueLockGeneration,
  quiesceQueueForLockGeneration,
} from "@/lib/release-job-rollout";
import { ensureOperationalIndexes } from "../scripts/ensure-operational-indexes";
import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("active review job dedupe migration", () => {
  let database: EphemeralDatabase;
  let pool: Pool;
  const payload = {
    installationId: 1,
    githubRepoId: 99,
    repoFullName: "octo/repo",
    prNumber: 42,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    expectedPullRequestUpdatedAt: "2026-08-12T03:04:05.123Z",
  };

  beforeAll(async () => {
    database = await createUnmigratedEphemeralDatabase("review_job_dedupe", {
      maxConnections: 8,
    });
    pool = database.pool;
    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql") && file < "0023_")
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(join(migrationDirectory, migration), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }
  });

  afterAll(async () => {
    await database?.drop();
  });

  test("applies over existing duplicates and suppresses every new active duplicate", async () => {
    await pool.query(
      `INSERT INTO jobs (kind, payload, status)
       VALUES ('review', $1, 'queued'), ('review', $1, 'queued')`,
      [JSON.stringify(payload)],
    );

    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0023_atomic_review_job_dedupe.sql"),
      "utf8",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const results = await Promise.all(
      Array.from({ length: 12 }, () => enqueueReviewJobOnce(pool, payload)),
    );
    expect(results.every((id) => id === null)).toBe(true);
    expect(await activeReviewCount(pool)).toBe(1);
    const retired = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM jobs
        WHERE kind = 'review'
          AND status = 'failed'
          AND last_error = 'duplicate active review suppressed by repository, pull request, and head identity'`,
    );
    expect(Number(retired.rows[0]?.count)).toBe(1);
    const revived = await pool.query(
      `UPDATE jobs
          SET status = 'queued'
        WHERE kind = 'review' AND status = 'failed'
        RETURNING id`,
    );
    expect(revived.rows).toHaveLength(0);

    await pool.query("UPDATE jobs SET status = 'done' WHERE kind = 'review'");
    const fresh = await Promise.all(
      Array.from({ length: 12 }, () => enqueueReviewJobOnce(pool, payload)),
    );
    expect(fresh.filter((id) => id !== null)).toHaveLength(1);
    expect(await activeReviewCount(pool)).toBe(1);

    await pool.query("UPDATE jobs SET status = 'done' WHERE kind = 'review'");
    const legacyWrites = await Promise.all(
      Array.from({ length: 12 }, () =>
        pool.query<{ id: string }>(
          `INSERT INTO jobs (kind, payload, status)
           VALUES ('review', $1, 'queued')
           RETURNING id`,
          [JSON.stringify(payload)],
        ),
      ),
    );
    expect(legacyWrites.flatMap((result) => result.rows)).toHaveLength(1);
    expect(await activeReviewCount(pool)).toBe(1);

  });

  test("serializes mixed legacy and stable repository identities", async () => {
    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationDirectory))
      .filter((file) =>
        file.endsWith(".sql") &&
        (
          (
            file > "0023_atomic_review_job_dedupe.sql" &&
            file <= "0049_workable_madame_web.sql"
          ) ||
          file === "0052_finding_lifecycle_observations.sql"
        )
      )
      .sort();
    for (const migrationFile of migrations) {
      const sql = await readFile(join(migrationDirectory, migrationFile), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }

    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, github_org_id)
       VALUES ('octo', 'Octo', 7)
       RETURNING id`,
    );
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations (github_installation_id, org_id, account_login, account_type)
       VALUES (1, $1, 'octo', 'Organization')
       RETURNING id`,
      [organization.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name)
       VALUES ($1, 99, 'octo/repo')`,
      [installation.rows[0]!.id],
    );
    await pool.query("UPDATE jobs SET status = 'done' WHERE kind = 'review'");

    const legacyPayload = { ...payload } as Record<string, unknown>;
    delete legacyPayload.githubRepoId;
    const writes = await Promise.all([
      ...Array.from({ length: 6 }, () =>
        pool.query(
          `INSERT INTO jobs (kind, payload, status)
           VALUES ('review', $1, 'queued')
           RETURNING id`,
          [JSON.stringify(legacyPayload)],
        ),
      ),
      ...Array.from({ length: 6 }, () =>
        pool.query(
          `INSERT INTO jobs (kind, payload, status)
           VALUES ('review', $1, 'queued')
           RETURNING id`,
          [JSON.stringify(payload)],
        ),
      ),
    ]);

    expect(writes.flatMap((result) => result.rows)).toHaveLength(1);
    expect(await activeReviewCount(pool)).toBe(1);

    const triggerBeforeFailedRollout = await pool.query<{
      function_definition: string;
      trigger_definition: string;
    }>(
      `SELECT pg_get_functiondef(
                'suppress_duplicate_active_review_job()'::regprocedure
              ) AS function_definition,
              pg_get_triggerdef(trigger.oid) AS trigger_definition
         FROM pg_trigger trigger
        WHERE trigger.tgname = 'jobs_suppress_duplicate_active_review_trigger'`,
    );
    expect(triggerBeforeFailedRollout.rows[0]?.function_definition).toContain(
      "pg_advisory_xact_lock",
    );

    const overflow = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status)
       VALUES ('review', $1, 'queued')
       RETURNING id`,
      [
        JSON.stringify({
          ...payload,
          prNumber: Number.MAX_SAFE_INTEGER,
          headSha: "overflow-cast-domain",
        }),
      ],
    );
    const missingHead = { ...payload, prNumber: 43 } as Record<string, unknown>;
    delete missingHead.headSha;
    const missing = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status)
       VALUES ('review', $1, 'queued')
       RETURNING id`,
      [JSON.stringify(missingHead)],
    );
    await expect(ensureOperationalIndexes(pool)).rejects.toThrow(
      "active review jobs contain an invalid typed identity",
    );
    const triggerAfterFailedRollout = await pool.query<{
      function_definition: string;
      trigger_definition: string;
    }>(
      `SELECT pg_get_functiondef(
                'suppress_duplicate_active_review_job()'::regprocedure
              ) AS function_definition,
              pg_get_triggerdef(trigger.oid) AS trigger_definition
         FROM pg_trigger trigger
        WHERE trigger.tgname = 'jobs_suppress_duplicate_active_review_trigger'`,
    );
    expect(triggerAfterFailedRollout.rows[0]).toEqual(
      triggerBeforeFailedRollout.rows[0],
    );
    await pool.query(
      "UPDATE jobs SET status = 'failed' WHERE id = ANY($1::bigint[])",
      [[overflow.rows[0]!.id, missing.rows[0]!.id]],
    );
    await expect(ensureOperationalIndexes(pool)).resolves.toContain(
      "jobs_active_review_identity_idx",
    );
    const state = await pool.query<{
      indisvalid: boolean;
      definition: string;
      trigger_definition: string;
    }>(
      `SELECT pg_index.indisvalid,
              pg_get_indexdef(pg_index.indexrelid) AS definition,
              pg_get_functiondef(
                'suppress_duplicate_active_review_job()'::regprocedure
              ) AS trigger_definition
         FROM pg_index
        WHERE pg_index.indexrelid =
          'jobs_active_review_identity_idx'::regclass`,
    );
    expect(state.rows[0]).toMatchObject({ indisvalid: true });
    expect(state.rows[0]?.definition).toMatch(/CASE\s+WHEN/u);
    expect(state.rows[0]?.definition).toContain("9223372036854775807");
    expect(state.rows[0]?.definition).toContain("2147483647");
    expect(state.rows[0]?.trigger_definition).not.toContain(
      "pg_advisory_xact_lock",
    );

    const newlyMalformed = await pool.query<{
      status: string;
      last_error: string | null;
    }>(
      `INSERT INTO jobs (kind, payload, status)
       VALUES
         ('review', $1, 'queued'),
         ('review', $2, 'running'),
         ('review', $3, 'queued')
       RETURNING status::text, last_error`,
      [
        JSON.stringify({ ...payload, prNumber: 44, headSha: undefined }),
        JSON.stringify({ ...payload, prNumber: undefined, headSha: "missing-pr" }),
        JSON.stringify({
          ...payload,
          prNumber: Number.MAX_SAFE_INTEGER,
          headSha: "overflow-after-rollout",
        }),
      ],
    );
    expect(newlyMalformed.rows).toHaveLength(3);
    expect(
      newlyMalformed.rows.every(
        (row) =>
          row.status === "failed" &&
          row.last_error === "active review identity is invalid",
      ),
    ).toBe(true);
    expect(await activeReviewCount(pool)).toBe(1);

    const assertSerializedTrigger = async () => {
      const trigger = await pool.query<{ definition: string }>(
        `SELECT pg_get_functiondef(
           'suppress_duplicate_active_review_job()'::regprocedure
         ) AS definition`,
      );
      expect(trigger.rows[0]?.definition).toContain("pg_advisory_xact_lock");
    };

    await pool.query('DROP INDEX "finding_approvals_github_delivery_idx"');
    await pool.query(
      `CREATE INDEX "finding_approvals_github_delivery_idx"
         ON finding_approvals (source_webhook_delivery_id)
       WHERE source = 'github'`,
    );
    await expect(ensureOperationalIndexes(pool)).rejects.toThrow(
      "finding_approvals_github_delivery_idx has an unexpected definition",
    );
    await assertSerializedTrigger();
    await pool.query('DROP INDEX "finding_approvals_github_delivery_idx"');
    await pool.query(
      `CREATE UNIQUE INDEX "finding_approvals_github_delivery_idx"
         ON finding_approvals (source_webhook_delivery_id)
       WHERE source = 'github'`,
    );

    await pool.query('DROP INDEX "reviews_running_started_at_idx"');
    await pool.query(
      `CREATE INDEX "reviews_running_started_at_idx"
         ON reviews (started_at, id)
       WHERE status = 'running'`,
    );
    await expect(ensureOperationalIndexes(pool)).rejects.toThrow(
      "reviews_running_started_at_idx has an unexpected definition",
    );
    await assertSerializedTrigger();
    await pool.query('DROP INDEX "reviews_running_started_at_idx"');
    await pool.query(
      `CREATE INDEX "reviews_running_started_at_idx"
         ON reviews (started_at)
       WHERE status = 'running'`,
    );

    await pool.query('DROP INDEX "jobs_running_locked_at_idx"');
    await pool.query(
      `CREATE INDEX "jobs_running_locked_at_idx"
         ON jobs (locked_at)
       WHERE status IN ('running', 'queued')`,
    );
    await expect(ensureOperationalIndexes(pool)).rejects.toThrow(
      "jobs_running_locked_at_idx has an unexpected definition",
    );
    await assertSerializedTrigger();
    await pool.query('DROP INDEX "jobs_running_locked_at_idx"');
    await pool.query(
      `CREATE INDEX "jobs_running_locked_at_idx"
         ON jobs (locked_at)
       WHERE status = 'running'`,
    );
    await expect(ensureOperationalIndexes(pool)).resolves.toContain(
      "jobs_active_review_identity_idx",
    );
  }, 30_000);

  test("assigns arrival order to a mixed-version insert and blocks its stale publication", async () => {
    const active = await pool.query<{ id: string }>(
      `UPDATE jobs
          SET payload = jsonb_set(
            payload,
            '{_postilCoalescedReviewPayload}',
            payload || jsonb_build_object('sourceDeliveryId', 'upgrade-pending'),
            true
          )
        WHERE kind = 'review' AND status = 'queued'
        RETURNING id`,
    );
    expect(active.rows).toHaveLength(1);

    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0050_queue_lock_generation.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
    await expect(
      quiesceQueueForLockGeneration(pool, { timeoutMs: 0, batchSize: 1 }),
    ).resolves.toBe(0);

    const upgraded = await pool.query<{
      current_sequence: string;
      pending_sequence: string;
      held: boolean;
    }>(
      `SELECT payload->>'reviewInputSequence' AS current_sequence,
              payload#>>'{_postilCoalescedReviewPayload,reviewInputSequence}'
                AS pending_sequence,
              run_after = 'infinity'::timestamptz AS held
         FROM jobs WHERE id = $1`,
      [active.rows[0]!.id],
    );
    expect(upgraded.rows[0]?.held).toBe(true);
    expect(BigInt(upgraded.rows[0]!.current_sequence)).toBeGreaterThan(0n);
    expect(BigInt(upgraded.rows[0]!.pending_sequence)).toBeGreaterThan(
      BigInt(upgraded.rows[0]!.current_sequence),
    );
    expect(await claimJob(pool, "pre-activation-upgrade", ["review"])).toBeNull();

    await pool.query("UPDATE jobs SET status = 'done' WHERE id = $1", [
      active.rows[0]!.id,
    ]);
    const oldBinaryPayload = {
      ...payload,
      prNumber: 84,
      headSha: "mixed-version-rollout",
      sourceDeliveryId: "mixed-version-a",
    };
    const inserted = await pool.query<{ id: string; sequence: string; held: boolean }>(
      `INSERT INTO jobs (kind, payload, status)
       VALUES ('review', $1, 'queued')
       RETURNING id, payload->>'reviewInputSequence' AS sequence,
                 run_after = 'infinity'::timestamptz AS held`,
      [JSON.stringify(oldBinaryPayload)],
    );
    expect(inserted.rows[0]?.held).toBe(true);
    expect(BigInt(inserted.rows[0]!.sequence)).toBeGreaterThan(
      BigInt(upgraded.rows[0]!.pending_sequence),
    );

    expect(await activateQueueLockGeneration(pool)).toBeGreaterThan(0);
    const running = await claimJob(pool, "post-activation-worker", ["review"]);
    if (!running) throw new Error("activated mixed-version review was not claimed");
    expect(running.id).toBe(Number(inserted.rows[0]!.id));
    expect(running.payload.reviewInputSequence).toBe(inserted.rows[0]!.sequence);

    expect(
      await enqueueReviewJobOnce(pool, {
        ...oldBinaryPayload,
        sourceDeliveryId: "mixed-version-b",
      }),
    ).toBe(running.id);

    let published = false;
    await withReviewPublicationFence(pool, oldBinaryPayload, async () => {
      const leaseState = await reviewInputLeaseState(
        pool,
        running,
        oldBinaryPayload.expectedPullRequestUpdatedAt,
        undefined,
      );
      if (leaseState === "current") published = true;
    });
    expect(published).toBe(false);
  });
});

async function activeReviewCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM jobs
      WHERE kind = 'review' AND status IN ('queued', 'running')`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
