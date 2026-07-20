import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

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
  let admin: Client;
  let pool: Pool;
  let databaseName: string;

  beforeAll(async () => {
    const source = new URL(TEST_URL!);
    databaseName = `postil_publication_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source);
    adminUrl.pathname = "/postgres";
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);

    const testUrl = new URL(source);
    testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 2 });
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
    await pool?.end();
    if (admin && databaseName) {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
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
        `INSERT INTO jobs (kind, payload, status, attempts, locked_at, locked_by)
         VALUES ('respond', $1::jsonb, 'running', 1, $2, 'lease-test') RETURNING id`,
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
        lease: { id: jobId, lockedBy: "lease-test", lockedAt },
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
});
