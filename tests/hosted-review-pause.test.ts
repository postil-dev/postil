import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

import * as schema from "@/lib/db/schema";
import { claimPausedHostedReview } from "@/lib/hosted-review-pause";
import { getOperatorReviewRows } from "@/lib/operator-reviews";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("paused hosted review claims", () => {
  const databaseName = `postil_hosted_pause_${process.pid}_${Date.now()}`;
  let adminClient: Client | undefined;
  let pool: Pool | undefined;
  let repositoryId = 0;

  beforeAll(async () => {
    adminClient = new Client({ connectionString: TEST_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(TEST_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    const migrationClient = new Client({ connectionString: databaseUrl.toString() });
    await migrationClient.connect();
    const migrationsDir = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .sort();
    for (const file of migrations) {
      const source = await readFile(join(migrationsDir, file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await migrationClient.query(statement);
      }
    }
    const organization = await migrationClient.query<{ id: string }>(
      "INSERT INTO organizations (slug, name) VALUES ('pause-test', 'Pause test') RETURNING id",
    );
    const installation = await migrationClient.query<{ id: string }>(
      `INSERT INTO installations (github_installation_id, account_login, account_type, org_id)
       VALUES (81001, 'pause-test', 'Organization', $1) RETURNING id`,
      [organization.rows[0]!.id],
    );
    const repository = await migrationClient.query<{ id: string }>(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
       VALUES ($1, 81002, 'pause-test/repo', false, true) RETURNING id`,
      [installation.rows[0]!.id],
    );
    repositoryId = Number(repository.rows[0]!.id);
    await migrationClient.end();
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    if (adminClient) {
      await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminClient.end();
    }
  });

  test("admits one concurrent claim for the same head and separate claims for new heads", async () => {
    const db = drizzle(pool!, { schema });
    const baseClaim = {
      repositoryId,
      prNumber: 42,
      authorGithubId: null,
      authorLogin: null,
      headSha: "head-one",
      baseSha: "base",
      sinceSha: null,
      queuedAt: new Date("2026-07-17T14:00:00Z"),
      startedAt: new Date("2026-07-17T14:00:01Z"),
    };
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimPausedHostedReview(db, baseClaim, {
          installationId: 81001,
          repoFullName: "pause-test/repo",
        }),
      ),
    );
    expect(concurrent.filter((claim) => claim !== null)).toHaveLength(1);

    const secondHead = await claimPausedHostedReview(
      db,
      {
        ...baseClaim,
        headSha: "head-two",
      },
      {
        installationId: 81001,
        repoFullName: "pause-test/repo",
      },
    );
    expect(secondHead).not.toBeNull();

    const rows = await pool!.query<{ head_sha: string; status: string }>(
      `SELECT head_sha, status
         FROM reviews
        WHERE repository_id = $1 AND pr_number = $2
        ORDER BY head_sha`,
      [repositoryId, baseClaim.prNumber],
    );
    expect(rows.rows).toEqual([
      { head_sha: "head-one", status: "failed" },
      { head_sha: "head-two", status: "failed" },
    ]);
    const cleanupJobs = await pool!.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM jobs WHERE kind = 'check-run-cleanup' ORDER BY id",
    );
    expect(cleanupJobs.rows).toHaveLength(2);
    expect(cleanupJobs.rows.every(({ payload }) => payload.intent === "neutralize")).toBe(true);
    expect(
      cleanupJobs.rows.every(
        ({ payload }) =>
          payload.advisoryCheckRunMayExist === true && payload.gateCheckRunMayExist === true,
      ),
    ).toBe(true);

    await pool!.query(
      `INSERT INTO reviews (
         repository_id, pr_number, head_sha, base_sha, status, error_message
       ) VALUES ($1, 43, 'ordinary-failure', 'base', 'failed', 'provider request timed out')`,
      [repositoryId],
    );
    const filters = { org: "", repo: "", from: "", to: "" };
    const failedRows = await getOperatorReviewRows(db, { ...filters, status: "failed" });
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]?.status).toBe("failed");
    const unavailableRows = await getOperatorReviewRows(db, {
      ...filters,
      status: "unavailable",
    });
    expect(unavailableRows).toHaveLength(2);
    expect(unavailableRows.every(({ status }) => status === "unavailable")).toBe(true);
  });
});
