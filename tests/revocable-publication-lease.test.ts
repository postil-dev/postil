import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

import { schema } from "@/lib/db";
import {
  cancelPullRequestPublication,
  externalSideEffectLeaseActive,
} from "@/lib/queue";
import {
  markRespondCancelled,
  respondPublicationLeaseActive,
} from "@/lib/respond-delivery";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("revocable pull-request publication lease", () => {
  let database: EphemeralDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createUnmigratedEphemeralDatabase("publication", {
      forceDrop: true,
      maxConnections: 2,
    });
    pool = database.pool;
    const migrationDir = join(import.meta.dir, "..", "drizzle");
    const files = (await readdir(migrationDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const contents = await readFile(join(migrationDir, file), "utf8");
      for (const statement of contents.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }
  });

  afterAll(async () => {
    await database?.drop();
  });

  test("close wins during POST without starving the pool or cancelling another PR", async () => {
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ($1, 'Publication test') RETURNING id`,
      [`publication-${randomUUID()}`],
    );
    const orgId = Number(org.rows[0]!.id);
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, org_id, account_login, account_type)
       VALUES (42001, $1, 'acme', 'Organization') RETURNING id`,
      [orgId],
    );
    const installationId = Number(installation.rows[0]!.id);
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories
         (installation_id, github_repo_id, full_name, private, enabled)
       VALUES ($1, 44001, 'acme/widgets', false, true) RETURNING id`,
      [installationId],
    );
    const repositoryId = Number(repository.rows[0]!.id);
    const lockedAt = new Date();

    const insertPublication = async (prNumber: number) => {
      const job = await pool.query<{ id: string }>(
        `INSERT INTO jobs
           (kind, payload, status, attempts, locked_at, locked_by, lock_generation)
         VALUES ('respond', $1::jsonb, 'running', 1, $2, 'lease-test', 1)
         RETURNING id`,
        [
          JSON.stringify({
            installationId: 42001,
            sourceInstallationId: installationId,
            sourceOrgId: orgId,
            githubRepoId: 44001,
            repoFullName: "acme/widgets",
            number: prNumber,
            isPr: true,
            sourceHeadSha: "same-head",
          }),
          lockedAt,
        ],
      );
      const jobId = Number(job.rows[0]!.id);
      const publicationLeaseId = randomUUID();
      await pool.query(
        `INSERT INTO respond_deliveries
           (job_id, repository_id, source_org_id, source_installation_id,
            source_github_installation_id, source_github_repo_id, repo_full_name,
            issue_number, is_pr, source_head_sha, body, state,
            publication_lease_id, publication_lease_expires_at, delivery_lease_expires_at)
         VALUES ($1, $2, $3, $4, 42001, 44001, 'acme/widgets', $5, true,
                 'same-head', 'reply', 'delivering', $6, now() + interval '5 minutes',
                 now() + interval '5 minutes')`,
        [jobId, repositoryId, orgId, installationId, prNumber, publicationLeaseId],
      );
      return {
        jobId,
        publicationLeaseId,
        lease: { id: jobId, lockedBy: "lease-test", lockGeneration: 1n },
      };
    };

    const closing = await insertPublication(7);
    const unrelated = await insertPublication(8);
    const db = drizzle(pool, { schema });
    const remoteComments = new Set<number>();
    let releasePost!: () => void;
    let postStarted!: () => void;
    const postBarrier = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const started = new Promise<void>((resolve) => {
      postStarted = resolve;
    });

    const publication = (async () => {
      expect(await externalSideEffectLeaseActive(pool, closing.lease)).toBe(true);
      expect(
        await respondPublicationLeaseActive(
          db,
          closing.jobId,
          closing.publicationLeaseId,
        ),
      ).toBe(true);
      remoteComments.add(7001);
      postStarted();
      await postBarrier;
      const authorized =
        (await externalSideEffectLeaseActive(pool, closing.lease)) &&
        (await respondPublicationLeaseActive(
          db,
          closing.jobId,
          closing.publicationLeaseId,
        ));
      if (!authorized) {
        remoteComments.delete(7001);
        await markRespondCancelled(db, closing.jobId, closing.publicationLeaseId);
      }
    })();

    await started;
    const cancellation = cancelPullRequestPublication(pool, {
      installationId: 42001,
      sourceInstallationId: installationId,
      sourceOrgId: orgId,
      githubRepoId: 44001,
      repoFullName: "acme/widgets",
      prNumber: 7,
    });
    const independentQuery = pool.query("SELECT 1 AS available");
    await Promise.race([
      Promise.all([cancellation, independentQuery]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("database pool starved during POST")), 750),
      ),
    ]);
    releasePost();
    await publication;

    expect(remoteComments.size).toBe(0);
    const closedState = await pool.query(
      `SELECT job.status AS job_status, delivery.state AS delivery_state
       FROM jobs job JOIN respond_deliveries delivery ON delivery.job_id = job.id
       WHERE job.id = $1`,
      [closing.jobId],
    );
    expect(closedState.rows[0]).toEqual({
      job_status: "done",
      delivery_state: "cancelled",
    });
    expect(await externalSideEffectLeaseActive(pool, unrelated.lease)).toBe(true);
    expect(
      await respondPublicationLeaseActive(
        db,
        unrelated.jobId,
        unrelated.publicationLeaseId,
      ),
    ).toBe(true);
  });

  test("migration binds eligible legacy work and retires ambiguous PR delivery", async () => {
    const legacyDatabase = await createUnmigratedEphemeralDatabase("legacy", {
      forceDrop: true,
      maxConnections: 2,
    });
    const legacyPool = legacyDatabase.pool;
    try {
      const migrationDir = join(import.meta.dir, "..", "drizzle");
      const files = (await readdir(migrationDir))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      for (const file of files.filter((name) => name < "0034_")) {
        const contents = await readFile(join(migrationDir, file), "utf8");
        for (const statement of contents.split("--> statement-breakpoint")) {
          if (statement.trim()) await legacyPool.query(statement);
        }
      }
      const org = await legacyPool.query<{ id: string }>(
        `INSERT INTO organizations (slug, name) VALUES ('legacy', 'Legacy') RETURNING id`,
      );
      const installation = await legacyPool.query<{ id: string }>(
        `INSERT INTO installations
           (github_installation_id, org_id, account_login, account_type)
         VALUES (62001, $1, 'legacy', 'Organization') RETURNING id`,
        [org.rows[0]!.id],
      );
      const repository = await legacyPool.query<{ id: string }>(
        `INSERT INTO repositories
           (installation_id, github_repo_id, full_name, private, enabled)
         VALUES ($1, 63001, 'legacy/widgets', false, true) RETURNING id`,
        [installation.rows[0]!.id],
      );
      const repositoryId = Number(repository.rows[0]!.id);
      const review = await legacyPool.query<{ id: string }>(
        `INSERT INTO jobs (kind, payload)
         VALUES ('review', $1::jsonb) RETURNING id`,
        [JSON.stringify({
          installationId: 62001,
          repoFullName: "legacy/widgets",
          prNumber: 7,
          headSha: "legacy-head",
          baseSha: "legacy-base",
        })],
      );
      await legacyPool.query(
        `ALTER TABLE respond_deliveries
           DROP CONSTRAINT respond_deliveries_state_check,
           ADD CONSTRAINT respond_deliveries_state_check
             CHECK (state IN ('prepared', 'delivering', 'delivered', 'cancelled'))`,
      );
      const insertLegacyDelivery = async (input: {
        issueNumber: number;
        isPr: boolean | string;
        sourceHeadSha?: string;
        state: "prepared" | "delivered" | "cancelled";
      }) => {
        const jobStatus = input.state === "prepared"
          ? "queued"
          : input.state === "delivered"
            ? "done"
            : "failed";
        const job = await legacyPool.query<{ id: string }>(
          `INSERT INTO jobs (kind, payload, status)
           VALUES ('respond', $1::jsonb, $2) RETURNING id`,
          [
            JSON.stringify({
              installationId: 62001,
              repoFullName: "legacy/widgets",
              number: input.issueNumber,
              isPr: input.isPr,
              ...(input.sourceHeadSha
                ? { sourceHeadSha: input.sourceHeadSha }
                : {}),
            }),
            jobStatus,
          ],
        );
        await legacyPool.query(
          `INSERT INTO respond_deliveries
             (job_id, repository_id, repo_full_name, issue_number, body, state,
              github_comment_id, delivered_at)
           VALUES ($1, $2, 'legacy/widgets', $3, 'legacy reply', $4,
                   CASE WHEN $4 = 'delivered' THEN $3 + 1000 ELSE NULL END,
                   CASE WHEN $4 = 'delivered' THEN now() ELSE NULL END)`,
          [job.rows[0]!.id, repositoryId, input.issueNumber, input.state],
        );
        return Number(job.rows[0]!.id);
      };

      // The legacy fixture has seven terminal deliveries: five PR replies
      // without a recoverable head and two issue replies.
      for (let index = 0; index < 7; index += 1) {
        await insertLegacyDelivery({
          issueNumber: 100 + index,
          isPr: index < 5,
          state: "delivered",
        });
      }
      const deliveredRecoverable = await insertLegacyDelivery({
        issueNumber: 200,
        isPr: true,
        sourceHeadSha: "delivered-head",
        state: "delivered",
      });
      const activeRecoverable = await insertLegacyDelivery({
        issueNumber: 201,
        isPr: true,
        sourceHeadSha: "active-head",
        state: "prepared",
      });
      const activeAmbiguous = await insertLegacyDelivery({
        issueNumber: 202,
        isPr: true,
        state: "prepared",
      });
      const activeMalformed = await insertLegacyDelivery({
        issueNumber: 203,
        isPr: "yes",
        state: "prepared",
      });
      const cancelledAmbiguous = await insertLegacyDelivery({
        issueNumber: 204,
        isPr: true,
        state: "cancelled",
      });

      const migration = await readFile(
        join(migrationDir, "0034_revocable_publication_leases.sql"),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await legacyPool.query(statement);
      }
      const reviewRow = await legacyPool.query<{
        id: string;
        status: string;
        payload: Record<string, unknown>;
      }>("SELECT id, status, payload FROM jobs WHERE id = $1", [review.rows[0]!.id]);
      expect(reviewRow.rows[0]).toMatchObject({
        id: review.rows[0]!.id,
        status: "queued",
        payload: {
          sourceOrgId: Number(org.rows[0]!.id),
          sourceInstallationId: Number(installation.rows[0]!.id),
          githubRepoId: 63001,
        },
      });
      const productionShape = await legacyPool.query<{
        delivered_count: string;
        pr_count: string;
        legacy_count: string;
        complete_count: string;
      }>(
        `SELECT count(*) AS delivered_count,
                count(*) FILTER (WHERE is_pr) AS pr_count,
                count(*) FILTER (
                  WHERE publication_identity_state = 'legacy_delivered'
                ) AS legacy_count,
                count(*) FILTER (
                  WHERE publication_identity_state = 'complete'
                ) AS complete_count
         FROM respond_deliveries
         WHERE issue_number BETWEEN 100 AND 106
           AND state = 'delivered'`,
      );
      expect(productionShape.rows[0]).toEqual({
        delivered_count: "7",
        pr_count: "5",
        legacy_count: "5",
        complete_count: "2",
      });
      const repaired = await legacyPool.query<{
        job_id: string;
        job_status: string;
        state: string;
        is_pr: boolean;
        source_head_sha: string | null;
        publication_identity_state: string;
        cancelled_at_set: boolean;
      }>(
        `SELECT delivery.job_id, job.status AS job_status, delivery.state,
                delivery.is_pr, delivery.source_head_sha,
                delivery.publication_identity_state,
                delivery.cancelled_at IS NOT NULL AS cancelled_at_set
         FROM respond_deliveries delivery
         JOIN jobs job ON job.id = delivery.job_id
         WHERE delivery.job_id = ANY($1::bigint[])
         ORDER BY delivery.job_id`,
        [[
          deliveredRecoverable,
          activeRecoverable,
          activeAmbiguous,
          activeMalformed,
          cancelledAmbiguous,
        ]],
      );
      expect(repaired.rows).toEqual([
        {
          job_id: String(deliveredRecoverable),
          job_status: "done",
          state: "delivered",
          is_pr: true,
          source_head_sha: "delivered-head",
          publication_identity_state: "complete",
          cancelled_at_set: false,
        },
        {
          job_id: String(activeRecoverable),
          job_status: "queued",
          state: "prepared",
          is_pr: true,
          source_head_sha: "active-head",
          publication_identity_state: "complete",
          cancelled_at_set: false,
        },
        {
          job_id: String(activeAmbiguous),
          job_status: "failed",
          state: "cancelled",
          is_pr: true,
          source_head_sha: null,
          publication_identity_state: "cancelled_incomplete",
          cancelled_at_set: true,
        },
        {
          job_id: String(activeMalformed),
          job_status: "failed",
          state: "cancelled",
          is_pr: false,
          source_head_sha: null,
          publication_identity_state: "cancelled_incomplete",
          cancelled_at_set: true,
        },
        {
          job_id: String(cancelledAmbiguous),
          job_status: "failed",
          state: "cancelled",
          is_pr: true,
          source_head_sha: null,
          publication_identity_state: "cancelled_incomplete",
          cancelled_at_set: true,
        },
      ]);
      const identityConstraint = await legacyPool.query<{ convalidated: boolean }>(
        `SELECT convalidated
         FROM pg_constraint
         WHERE conname = 'respond_deliveries_publication_identity_check'`,
      );
      expect(identityConstraint.rows[0]).toEqual({ convalidated: false });
      const invalidNewJob = await legacyPool.query<{ id: string }>(
        `INSERT INTO jobs (kind, payload, status)
         VALUES ('respond', $1::jsonb, 'done') RETURNING id`,
        [JSON.stringify({
          installationId: 62001,
          sourceInstallationId: Number(installation.rows[0]!.id),
          sourceOrgId: Number(org.rows[0]!.id),
          githubRepoId: 63001,
          repoFullName: "legacy/widgets",
          number: 205,
          isPr: true,
          sourceHeadSha: "new-head",
        })],
      );
      await expect(
        legacyPool.query(
          `INSERT INTO respond_deliveries
             (job_id, repository_id, source_org_id, source_installation_id,
              source_github_installation_id, source_github_repo_id,
              repo_full_name, issue_number, is_pr, body, state)
           VALUES ($1, $2, $3, $4, 62001, 63001,
                   'legacy/widgets', 205, true, 'invalid new reply', 'delivered')`,
          [
            invalidNewJob.rows[0]!.id,
            repositoryId,
            org.rows[0]!.id,
            installation.rows[0]!.id,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        legacyPool.query(
          `UPDATE jobs
           SET payload = jsonb_set(payload, '{repoFullName}', '"other/widgets"')
           WHERE id = $1`,
          [review.rows[0]!.id],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
    } finally {
      await legacyDatabase.drop();
    }
  }, 20_000);
});
