import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

import {
  activePublicationControllerRelease,
  activatePublicationControllerRelease,
  activateQueueLockGeneration,
  deactivatePublicationControllerRelease,
  deferLegacyReviewForPublicationController,
  publicationControllerConsumerReady,
  publicationControllerLegacyReviewFenced,
  publicationControllerReleaseActivated,
  recordPublicationControllerCliPreflight,
  recordPublicationControllerConsumerReady,
  quiesceQueueForLockGeneration,
} from "@/lib/release-job-rollout";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const DRIZZLE_DIRECTORY = join(import.meta.dir, "..", "drizzle");

test("migration replay follows the Drizzle journal order", async () => {
  const files = await migrationFilesInJournalOrder();
  const first0048 = files.indexOf("0048_woozy_tigra.sql");

  expect(first0048).toBeGreaterThanOrEqual(0);
  expect(files.slice(first0048, first0048 + 2)).toEqual([
    "0048_woozy_tigra.sql",
    "0048_new_jubilee.sql",
  ]);
  await expect(
    Promise.all(
      files.map((file) => readFile(join(DRIZZLE_DIRECTORY, file), "utf8")),
    ),
  ).resolves.toHaveLength(files.length);
});

describeDb("publication-controller release rollout", () => {
  let database: EphemeralDatabase;
  let pool: Pool;
  const releaseA = "a".repeat(40);
  const releaseB = "b".repeat(40);

  beforeEach(async () => {
    database = await createUnmigratedEphemeralDatabase("publication_controller_rollout");
    const migration = new Client({ connectionString: database.url });
    await migration.connect();
    for (const file of await migrationFilesInJournalOrder()) {
      const source = await readFile(join(DRIZZLE_DIRECTORY, file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migration.query(statement);
      }
    }
    await migration.end();
    pool = database.pool;
  }, 30_000);

  afterEach(async () => {
    await database?.drop();
  }, 30_000);

  test("deploy preparation makes the exact release dark without changing ordinary queue behavior", async () => {
    expect(await deactivatePublicationControllerRelease(pool, releaseA)).toBe(false);
    expect(await publicationControllerReleaseActivated(pool, releaseA)).toBe(false);
    expect(await publicationControllerLegacyReviewFenced(pool, releaseA)).toBe(true);
    expect(await deactivatePublicationControllerRelease(pool, releaseA)).toBe(false);
  });

  test("activation requires exact CLI and consumer readiness preflights", async () => {
    await deactivatePublicationControllerRelease(pool, releaseA);
    await expect(
      activatePublicationControllerRelease(pool, releaseA),
    ).rejects.toThrow("successful CLI-plan preflight");
    expect(await recordPublicationControllerCliPreflight(pool, releaseA)).toBe(true);
    expect(await recordPublicationControllerCliPreflight(pool, releaseA)).toBe(false);
    await expect(
      activatePublicationControllerRelease(pool, releaseA),
    ).rejects.toThrow("consumer readiness preflight");
    expect(await publicationControllerConsumerReady(pool, releaseA)).toBe(false);
    expect(await recordPublicationControllerConsumerReady(pool, releaseA)).toBe(true);
    expect(await recordPublicationControllerConsumerReady(pool, releaseA)).toBe(false);
    expect(await publicationControllerConsumerReady(pool, releaseA)).toBe(true);
    expect(await activatePublicationControllerRelease(pool, releaseA)).toEqual({
      activated: true,
      adopted: 0,
    });
    expect(await publicationControllerReleaseActivated(pool, releaseA)).toBe(true);
    expect(await activePublicationControllerRelease(pool)).toBe(releaseA);
    expect(await publicationControllerLegacyReviewFenced(pool, releaseA)).toBe(true);
    expect(await activatePublicationControllerRelease(pool, releaseA)).toEqual({
      activated: false,
      adopted: 0,
    });
    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = $1",
      [`publication-controller-consumer-ready:${releaseA}`],
    );
    expect(await publicationControllerReleaseActivated(pool, releaseA)).toBe(false);
    expect(await activePublicationControllerRelease(pool)).toBe(null);
    await expect(
      activatePublicationControllerRelease(pool, releaseA),
    ).rejects.toThrow("active publication-controller release lacks exact consumer readiness");
  });

  test("rollback removes active authority and keeps the successor release dark", async () => {
    await activateRelease(pool, releaseA);
    expect(await publicationControllerReleaseActivated(pool, releaseA)).toBe(true);

    expect(await deactivatePublicationControllerRelease(pool, releaseB)).toBe(true);
    expect(await publicationControllerReleaseActivated(pool, releaseA)).toBe(false);
    expect(await publicationControllerReleaseActivated(pool, releaseB)).toBe(false);
    expect(await activePublicationControllerRelease(pool)).toBe(null);
    expect(await publicationControllerConsumerReady(pool, releaseA)).toBe(false);
    expect(await publicationControllerConsumerReady(pool, releaseB)).toBe(false);
    expect(await publicationControllerLegacyReviewFenced(pool, releaseB)).toBe(true);
  });

  test("held intent drains only after a ready test consumer takes ownership", async () => {
    await deactivatePublicationControllerRelease(pool, releaseA);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, run_after)
       VALUES (
         'review',
         '{"githubRepoId":1,"prNumber":2,"headSha":"head"}'::jsonb,
         'queued',
         '2040-02-03T04:05:06Z'::timestamptz
       )
       RETURNING id`,
    );
    const id = Number(inserted.rows[0]!.id);
    await recordPublicationControllerCliPreflight(pool, releaseA);

    await expect(
      activatePublicationControllerRelease(pool, releaseA),
    ).rejects.toThrow("consumer readiness preflight");
    expect(await activePublicationControllerRelease(pool)).toBe(null);
    expect(await heldReviewState(pool, id)).toEqual({
      status: "queued",
      held: true,
      releaseSha: null,
    });

    await recordPublicationControllerConsumerReady(pool, releaseA);
    expect(await activatePublicationControllerRelease(pool, releaseA)).toEqual({
      activated: true,
      adopted: 1,
    });
    expect(await heldReviewState(pool, id)).toEqual({
      status: "queued",
      held: true,
      releaseSha: releaseA,
    });
    expect(await drainHeldReviewAsTestConsumer(pool, releaseA)).toBe(id);
    const drained = await pool.query<{ kind: string; status: string }>(
      "SELECT kind, status FROM jobs WHERE id = $1",
      [id],
    );
    expect(drained.rows[0]).toEqual({
      kind: "review",
      status: "done",
    });
  });

  test("a verified successor adopts held legacy review work without releasing it", async () => {
    await deactivatePublicationControllerRelease(pool, releaseA);
    const job = await insertRunningReview(pool, "release-a-worker");
    await deferLegacyReviewForPublicationController(pool, job, releaseA);

    await deactivatePublicationControllerRelease(pool, releaseB);
    await activateRelease(pool, releaseB);
    const adopted = await pool.query<{
      status: string;
      held: boolean;
      release_sha: string | null;
      attempts: number;
    }>(
      `SELECT status,
              run_after = 'infinity'::timestamptz AS held,
              payload->>'_postilPublicationControllerReleaseSha' AS release_sha,
              attempts
         FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(adopted.rows[0]).toEqual({
      status: "queued",
      held: true,
      release_sha: releaseB,
      attempts: 0,
    });
    expect(await activatePublicationControllerRelease(pool, releaseB)).toEqual({
      activated: false,
      adopted: 0,
    });
  });

  test("an active legacy review claim is fenced before it can publish", async () => {
    await deactivatePublicationControllerRelease(pool, releaseA);
    const job = await insertRunningReview(pool, "legacy-review-worker");
    await deferLegacyReviewForPublicationController(pool, job, releaseA);

    const fenced = await pool.query<{
      status: string;
      attempts: number;
      held: boolean;
      locked_by: string | null;
      marker: string | null;
    }>(
      `SELECT status, attempts,
              run_after = 'infinity'::timestamptz AS held,
              locked_by,
              payload->>'_postilPublicationControllerReleaseSha' AS marker
         FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(fenced.rows[0]).toEqual({
      status: "queued",
      attempts: 0,
      held: true,
      locked_by: null,
      marker: releaseA,
    });
  });

  test("authority transitions require queue quiescence and no legacy review claims", async () => {
    await pool.query(
      "INSERT INTO deployment_capabilities (name) VALUES ('queue-lock-generation-v1')",
    );
    await expect(
      deactivatePublicationControllerRelease(pool, releaseA),
    ).rejects.toThrow("queue-lock-generation quiescence");

    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = 'queue-lock-generation-v1'",
    );
    await deactivatePublicationControllerRelease(pool, releaseA);
    await pool.query(
      "INSERT INTO deployment_capabilities (name) VALUES ('queue-lock-generation-v1')",
    );
    await expect(
      recordPublicationControllerCliPreflight(pool, releaseA),
    ).rejects.toThrow("queue-lock-generation quiescence");
    await expect(
      activatePublicationControllerRelease(pool, releaseA),
    ).rejects.toThrow("queue-lock-generation quiescence");
    await expect(
      recordPublicationControllerConsumerReady(pool, releaseA),
    ).rejects.toThrow("queue-lock-generation quiescence");

    await pool.query(
      "DELETE FROM deployment_capabilities WHERE name = 'queue-lock-generation-v1'",
    );
    await insertRunningReview(pool, "legacy-review-worker");
    await expect(
      deactivatePublicationControllerRelease(pool, releaseA),
    ).rejects.toThrow("legacy review claim");
    await expect(
      recordPublicationControllerCliPreflight(pool, releaseA),
    ).rejects.toThrow("legacy review claim");
    await expect(
      activatePublicationControllerRelease(pool, releaseA),
    ).rejects.toThrow("legacy review claim");
    await expect(
      recordPublicationControllerConsumerReady(pool, releaseA),
    ).rejects.toThrow("legacy review claim");
  });

  test("a subsequent release freezes old claims through dark transition and reactivation", async () => {
    expect(await activateQueueLockGeneration(pool)).toBe(0);
    const running = await insertRunningReview(pool, "first-release-worker");
    const originalRunAfter = "2040-03-04T05:06:07.000Z";
    const queued = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, run_after)
       VALUES (
         'review',
         '{"githubRepoId":1,"prNumber":3,"headSha":"head"}'::jsonb,
         'queued',
         $1::timestamptz
       )
       RETURNING id`,
      [originalRunAfter],
    );
    const queuedId = Number(queued.rows[0]!.id);
    let signalFrozen!: () => void;
    const frozen = new Promise<void>((resolve) => {
      signalFrozen = resolve;
    });
    let signalled = false;
    const quiesce = quiesceQueueForLockGeneration(pool, {
      timeoutMs: 5_000,
      pollMs: 10,
      batchSize: 1,
      onWait: () => {
        if (!signalled) {
          signalled = true;
          signalFrozen();
        }
      },
    });

    await frozen;
    const inactive = await pool.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM deployment_capabilities
          WHERE name = 'queue-lock-generation-v1'
       ) AS active`,
    );
    expect(inactive.rows[0]?.active).toBe(false);
    const oldClaimDuringQuiesce = claimReviewAsOldWorker(
      pool,
      queuedId,
      "rollback-worker-during-quiesce",
    );
    await pool.query(
      `UPDATE jobs
          SET status = 'done', locked_at = NULL, locked_by = NULL
        WHERE id = $1`,
      [running.id],
    );
    await expect(quiesce).resolves.toBe(0);
    await expect(oldClaimDuringQuiesce).resolves.toEqual({
      status: "queued",
      attempts: 0,
      held: true,
    });

    await deactivatePublicationControllerRelease(pool, releaseB);
    await recordPublicationControllerCliPreflight(pool, releaseB);
    await recordPublicationControllerConsumerReady(pool, releaseB);
    expect(await activatePublicationControllerRelease(pool, releaseB)).toEqual({
      activated: true,
      adopted: 1,
    });
    expect(await activateQueueLockGeneration(pool)).toBe(1);
    await expect(
      claimReviewAsOldWorker(pool, queuedId, "rollback-worker-after-reactivation"),
    ).resolves.toEqual({
      status: "queued",
      attempts: 0,
      held: true,
    });
    const finalState = await pool.query<{
      queue_active: boolean;
      controller_active: boolean;
      original_schedule: boolean;
      queue_marker: string | null;
    }>(
      `SELECT EXISTS (
                SELECT 1 FROM deployment_capabilities
                 WHERE name = 'queue-lock-generation-v1'
              ) AS queue_active,
              EXISTS (
                SELECT 1 FROM deployment_capabilities
                 WHERE name = $2
              ) AS controller_active,
              (job.payload->>'_postilPublicationControllerRunAfter')::timestamptz
                = $3::timestamptz AS original_schedule,
              job.payload->>'_postilLockGenerationFence' AS queue_marker
         FROM jobs job
        WHERE job.id = $1`,
      [
        queuedId,
        `publication-controller-release:${releaseB}`,
        originalRunAfter,
      ],
    );
    expect(finalState.rows[0]).toEqual({
      queue_active: true,
      controller_active: true,
      original_schedule: true,
      queue_marker: null,
    });
  });

  test("a pre-controller consumer cannot claim or release a review while dark", async () => {
    const originalRunAfter = "2040-01-02T03:04:05.000Z";
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO jobs (kind, payload, status, run_after)
       VALUES (
         'review',
         '{"githubRepoId":1,"prNumber":1,"headSha":"head"}'::jsonb,
         'queued',
         $1::timestamptz
       )
       RETURNING id`,
      [originalRunAfter],
    );
    const id = Number(inserted.rows[0]!.id);

    await deactivatePublicationControllerRelease(pool, releaseA);

    const claimed = await pool.query<{
      status: string;
      attempts: number;
      held: boolean;
    }>(
      `UPDATE jobs
          SET status = 'running', attempts = attempts + 1,
              locked_at = clock_timestamp(), locked_by = 'pre-controller',
              lock_generation = lock_generation + 1
        WHERE id = $1
       RETURNING status, attempts,
                 run_after = 'infinity'::timestamptz AS held`,
      [id],
    );
    expect(claimed.rows[0]).toEqual({
      status: "queued",
      attempts: 0,
      held: true,
    });

    await pool.query(
      `UPDATE jobs
          SET run_after = clock_timestamp()
        WHERE id = $1`,
      [id],
    );
    const held = await pool.query<{
      status: string;
      held: boolean;
      preserved_original_run_after: boolean;
      future_controller_visible: boolean;
    }>(
      `SELECT status,
              run_after = 'infinity'::timestamptz AS held,
              (payload->>'_postilPublicationControllerRunAfter')::timestamptz
                = $2::timestamptz AS preserved_original_run_after,
              payload->>'_postilPublicationControllerFence' = 'true'
                AS future_controller_visible
         FROM jobs WHERE id = $1`,
      [id, originalRunAfter],
    );
    expect(held.rows[0]).toEqual({
      status: "queued",
      held: true,
      preserved_original_run_after: true,
      future_controller_visible: true,
    });
  });
});

async function migrationFilesInJournalOrder(): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(join(DRIZZLE_DIRECTORY, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };

  return journal.entries.map((entry) => `${entry.tag}.sql`);
}

async function activateRelease(pool: Pool, releaseSha: string) {
  await deactivatePublicationControllerRelease(pool, releaseSha);
  await recordPublicationControllerCliPreflight(pool, releaseSha);
  await recordPublicationControllerConsumerReady(pool, releaseSha);
  return activatePublicationControllerRelease(pool, releaseSha);
}

async function heldReviewState(pool: Pool, id: number) {
  const state = await pool.query<{
    status: string;
    held: boolean;
    release_sha: string | null;
  }>(
    `SELECT status,
            run_after = 'infinity'::timestamptz AS held,
            payload->>'_postilPublicationControllerReleaseSha' AS release_sha
       FROM jobs WHERE id = $1`,
    [id],
  );
  return {
    status: state.rows[0]!.status,
    held: state.rows[0]!.held,
    releaseSha: state.rows[0]!.release_sha,
  };
}

async function claimReviewAsOldWorker(
  pool: Pool,
  id: number,
  worker: string,
) {
  const claimed = await pool.query<{
    status: string;
    attempts: number;
    held: boolean;
  }>(
    `UPDATE jobs
        SET status = 'running', attempts = attempts + 1,
            locked_at = clock_timestamp(), locked_by = $2
      WHERE id = $1 AND status = 'queued'
     RETURNING status, attempts,
               run_after = 'infinity'::timestamptz AS held`,
    [id, worker],
  );
  return claimed.rows[0];
}

async function drainHeldReviewAsTestConsumer(
  pool: Pool,
  releaseSha: string,
): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["postil:queue-lock-generation-v1"],
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["postil:publication-controller-release"],
    );
    const drained = await client.query<{ id: string }>(
      `WITH authority AS MATERIALIZED (
         SELECT EXISTS (
                  SELECT 1 FROM deployment_capabilities WHERE name = $1
                )
                AND EXISTS (
                  SELECT 1 FROM deployment_capabilities WHERE name = $2
                ) AS ready
       ), candidate AS MATERIALIZED (
         SELECT job.id
           FROM jobs job, authority
          WHERE authority.ready
            AND job.kind = 'review'
            AND job.status = 'queued'
            AND job.payload->>'_postilPublicationControllerFence' = 'true'
          ORDER BY job.id
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
       )
       UPDATE jobs job
          SET status = 'done',
              run_after = clock_timestamp(),
              payload = job.payload
                - '_postilPublicationControllerFence'
                - '_postilPublicationControllerRunAfter'
                - '_postilPublicationControllerReleaseSha'
         FROM candidate
        WHERE job.id = candidate.id
       RETURNING job.id`,
      [
        `publication-controller-release:${releaseSha}`,
        `publication-controller-consumer-ready:${releaseSha}`,
      ],
    );
    await client.query("COMMIT");
    return drained.rows[0] ? Number(drained.rows[0].id) : null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertRunningReview(pool: Pool, worker: string) {
  const inserted = await pool.query<{ id: string; lock_generation: string }>(
    `INSERT INTO jobs (
       kind, payload, status, attempts, locked_at, locked_by, lock_generation
     ) VALUES (
       'review',
       '{"githubRepoId":1,"prNumber":1,"headSha":"head"}'::jsonb,
       'running', 1, now(), $1, 1
     )
     RETURNING id, lock_generation::text`,
    [worker],
  );
  return {
    id: Number(inserted.rows[0]!.id),
    lockedBy: worker,
    lockGeneration: BigInt(inserted.rows[0]!.lock_generation),
  };
}
