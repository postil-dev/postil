import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import { activatePrivateReviewAuthorIdentity } from "@/lib/release-job-rollout";
import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("private review author migration", () => {
  let database: EphemeralDatabase;
  let pool: Pool;
  let privateRepositoryId: number;
  let publicRepositoryId: number;

  beforeAll(async () => {
    database = await createUnmigratedEphemeralDatabase("private_review_author", {
      maxConnections: 4,
    });
    pool = database.pool;
    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql") && file < "0030_")
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(join(migrationDirectory, migration), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }

    const organization = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name) VALUES ('author-audit', 'Author audit') RETURNING id",
    );
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, org_id, account_login, account_type)
       VALUES (404, $1, 'author-audit', 'Organization') RETURNING id`,
      [organization.rows[0]!.id],
    );
    const repositories = await pool.query<{ id: string; private: boolean }>(
      `INSERT INTO repositories
         (installation_id, github_repo_id, full_name, private, enabled)
       VALUES
         ($1, 4001, 'author-audit/private', true, true),
         ($1, 4002, 'author-audit/public', false, true)
       RETURNING id, private`,
      [installation.rows[0]!.id],
    );
    privateRepositoryId = Number(
      repositories.rows.find((row) => row.private)!.id,
    );
    publicRepositoryId = Number(
      repositories.rows.find((row) => !row.private)!.id,
    );

    await pool.query(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status, finished_at)
       VALUES ($1, 1, 'historical-head', 'base', 'completed', now())`,
      [privateRepositoryId],
    );

    const migration = await readFile(
      join(migrationDirectory, "0030_private_review_author_invariant.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  });

  test("closes the activation race and enforces durable private author identity", async () => {
    const legacy = await pool.query<{
      author_github_id: string | null;
      author_login: string | null;
    }>(
      "SELECT author_github_id, author_login FROM reviews WHERE head_sha = 'historical-head'",
    );
    expect(legacy.rows).toEqual([
      { author_github_id: null, author_login: null },
    ]);

    const rollingClient = await pool.connect();
    try {
      await rollingClient.query("BEGIN");
      await rollingClient.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, status)
         VALUES ($1, 2, 'rolling-head', 'base', 'running')`,
        [privateRepositoryId],
      );

      const activation = activatePrivateReviewAuthorIdentity(pool);
      const earlyResult = await Promise.race([
        activation.then(
          () => "activated" as const,
          () => "rejected" as const,
        ),
        Bun.sleep(75).then(() => "blocked" as const),
      ]);
      expect(earlyResult).toBe("blocked");
      await rollingClient.query("COMMIT");
      await expect(activation).rejects.toThrow("anonymous active reviews");
    } finally {
      await rollingClient.query("ROLLBACK").catch(() => undefined);
      rollingClient.release();
    }
    await pool.query(
      "UPDATE reviews SET status = 'stale' WHERE head_sha = 'rolling-head'",
    );
    await pool.query(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status)
       VALUES ($1, 8, 'queued-before-activation', 'base', 'queued')`,
      [privateRepositoryId],
    );
    await expect(activatePrivateReviewAuthorIdentity(pool)).rejects.toThrow(
      "anonymous active reviews",
    );
    await pool.query(
      "UPDATE reviews SET status = 'stale' WHERE head_sha = 'queued-before-activation'",
    );
    expect(await activatePrivateReviewAuthorIdentity(pool)).toBe(true);
    expect(await activatePrivateReviewAuthorIdentity(pool)).toBe(false);

    const rolling = await pool.query<{
      status: string;
      author_github_id: string | null;
    }>(
      "SELECT status, author_github_id FROM reviews WHERE head_sha = 'rolling-head'",
    );
    expect(rolling.rows).toEqual([{ status: "stale", author_github_id: null }]);

    await expect(
      pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, status)
         VALUES ($1, 3, 'anonymous-head', 'base', 'running')`,
        [privateRepositoryId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, status, author_github_id, author_login)
         VALUES ($1, 4, 'invalid-head', 'base', 'running', 0, ' ')`,
        [privateRepositoryId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });

    await pool.query(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status)
       VALUES ($1, 5, 'public-head', 'base', 'running')`,
      [publicRepositoryId],
    );
    await expect(
      pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, status)
         VALUES ($1, 6, 'queued-head', 'base', 'queued')`,
        [privateRepositoryId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });

    const verified = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status, author_github_id, author_login)
       VALUES ($1, 7, 'verified-head', 'base', 'running', 42, 'octocat')
       RETURNING id`,
      [privateRepositoryId],
    );
    await pool.query("UPDATE reviews SET status = 'completed' WHERE id = $1", [
      verified.rows[0]!.id,
    ]);
    await expect(
      pool.query("UPDATE reviews SET author_login = 'another' WHERE id = $1", [
        verified.rows[0]!.id,
      ]),
    ).rejects.toMatchObject({ code: "P0001" });
  });
});
