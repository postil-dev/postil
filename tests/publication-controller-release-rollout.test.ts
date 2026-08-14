import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

import {
  activatePublicationControllerRelease,
  deactivatePublicationControllerRelease,
  deferLegacyReviewForPublicationController,
  activePublicationControllerRelease,
  publicationControllerLegacyReviewFenced,
  publicationControllerReleaseActivated,
  recordPublicationControllerCliPreflight,
} from "@/lib/release-job-rollout";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("publication-controller release rollout", () => {
  let database: EphemeralDatabase;
  let pool: Pool;
  const releaseA = "a".repeat(40);
  const releaseB = "b".repeat(40);

  beforeAll(async () => {
    database = await createUnmigratedEphemeralDatabase("publication_controller_rollout");
    const migration = new Client({ connectionString: database.url });
    await migration.connect();
    for (const file of (await readdir(join(import.meta.dir, "..", "drizzle")))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .sort()) {
      const source = await readFile(join(import.meta.dir, "..", "drizzle", file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migration.query(statement);
      }
    }
    await migration.end();
    pool = database.pool;
  }, 30_000);

  afterEach(async () => {
    await pool.query("TRUNCATE jobs, deployment_capabilities RESTART IDENTITY");
  });

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  test("deploy preparation makes the exact release dark without changing ordinary queue behavior", async () => {
    expect(await deactivatePublicationControllerRelease(pool, releaseA)).toBe(false);
    expect(await publicationControllerReleaseActivated(pool, releaseA)).toBe(false);
    expect(await publicationControllerLegacyReviewFenced(pool, releaseA)).toBe(true);
    expect(await deactivatePublicationControllerRelease(pool, releaseA)).toBe(false);
  });

  test("activation requires the exact CLI preflight and is idempotent", async () => {
    await deactivatePublicationControllerRelease(pool, releaseA);
    await expect(
      activatePublicationControllerRelease(pool, releaseA),
    ).rejects.toThrow("successful CLI-plan preflight");
    expect(await recordPublicationControllerCliPreflight(pool, releaseA)).toBe(true);
    expect(await recordPublicationControllerCliPreflight(pool, releaseA)).toBe(false);
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
  });

  test("rollback removes active authority and keeps the successor release dark", async () => {
    await activateRelease(pool, releaseA);
    expect(await publicationControllerReleaseActivated(pool, releaseA)).toBe(true);

    expect(await deactivatePublicationControllerRelease(pool, releaseB)).toBe(true);
    expect(await publicationControllerReleaseActivated(pool, releaseA)).toBe(false);
    expect(await publicationControllerReleaseActivated(pool, releaseB)).toBe(false);
    expect(await activePublicationControllerRelease(pool)).toBe(null);
    expect(await publicationControllerLegacyReviewFenced(pool, releaseB)).toBe(true);
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

async function activateRelease(pool: Pool, releaseSha: string) {
  await recordPublicationControllerCliPreflight(pool, releaseSha);
  return activatePublicationControllerRelease(pool, releaseSha);
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
