import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import { enqueueReviewJobOnce } from "@/lib/queue";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("active review job dedupe migration", () => {
  const pool = new Pool({ connectionString: TEST_URL, max: 8 });
  const payload = {
    installationId: 1,
    githubRepoId: 99,
    repoFullName: "octo/repo",
    prNumber: 42,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
  };

  beforeAll(async () => {
    await pool.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
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
    await pool.end();
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
        file > "0023_atomic_review_job_dedupe.sql" &&
        file <= "0048_woozy_tigra.sql"
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
