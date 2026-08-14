import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("review trigger provenance migration", () => {
  let database: EphemeralDatabase;
  let pool: Pool;
  let repositoryId: number;

  beforeAll(async () => {
    database = await createUnmigratedEphemeralDatabase("review_trigger_provenance", {
      maxConnections: 1,
    });
    pool = database.pool;
    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql") && file < "0029_")
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(join(migrationDirectory, migration), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }
    const organization = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name) VALUES ('octo', 'Octo') RETURNING id",
    );
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, org_id, account_login, account_type)
       VALUES (42, $1, 'octo', 'Organization') RETURNING id`,
      [organization.rows[0]!.id],
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories
         (installation_id, github_repo_id, full_name, private, enabled)
       VALUES ($1, 99, 'octo/repo', false, true) RETURNING id`,
      [installation.rows[0]!.id],
    );
    repositoryId = Number(repository.rows[0]!.id);
    const legacyReview = await pool.query<{ id: string }>(
      `INSERT INTO reviews (repository_id, pr_number, head_sha, base_sha)
       VALUES ($1, 1, 'legacy-head', 'base') RETURNING id`,
      [repositoryId],
    );
    await pool.query(
      `INSERT INTO usage_events
         (org_id, repository_id, review_id, model_used, billing_scope)
       VALUES ($1, $2, $3, 'legacy-model', 'analytics')`,
      [organization.rows[0]!.id, repositoryId, legacyReview.rows[0]!.id],
    );
    const migration = await readFile(
      join(migrationDirectory, "0029_review_trigger_provenance.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
  });

  afterAll(async () => {
    await database?.drop();
  });

  test("marks historical reviews unknown without inventing context", async () => {
    const legacy = await pool.query<{
      trigger_source: string;
      trigger_context: Record<string, unknown> | null;
    }>("SELECT trigger_source, trigger_context FROM reviews WHERE head_sha = 'legacy-head'");
    expect(legacy.rows).toEqual([{ trigger_source: "unknown", trigger_context: null }]);
    const legacyUsage = await pool.query<{ trigger_source: string }>(
      "SELECT trigger_source FROM usage_events WHERE model_used = 'legacy-model'",
    );
    expect(legacyUsage.rows).toEqual([{ trigger_source: "unknown" }]);
  });

  test("stores valid provenance and rejects later mutation", async () => {
    const context = {
      source: "requested_review",
      webhookDeliveryId: "delivery-1",
      webhookEvent: "issue_comment",
      sourceCommentId: 123,
    };
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, trigger_source, trigger_context)
       VALUES ($1, 2, 'requested-head', 'base', 'requested_review', $2)
       RETURNING id`,
      [repositoryId, JSON.stringify(context)],
    );
    await pool.query("UPDATE reviews SET status = 'running' WHERE id = $1", [
      inserted.rows[0]!.id,
    ]);
    await expect(
      pool.query("UPDATE reviews SET trigger_source = 'unknown' WHERE id = $1", [
        inserted.rows[0]!.id,
      ]),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      pool.query("UPDATE reviews SET trigger_context = '{}'::jsonb WHERE id = $1", [
        inserted.rows[0]!.id,
      ]),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  test("rejects provenance values outside the closed vocabulary", async () => {
    await expect(
      pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, trigger_source)
         VALUES ($1, 3, 'invalid-head', 'base', 'guessed')`,
        [repositoryId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, trigger_source, trigger_context)
         VALUES ($1, 4, 'mismatched-head', 'base', 'requested_review', $2)`,
        [
          repositoryId,
          JSON.stringify({
            source: "automatic_pull_request",
            webhookDeliveryId: "delivery-2",
          }),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, trigger_source, trigger_context)
         VALUES ($1, 5, 'missing-evidence-head', 'base', 'requested_review', $2)`,
        [repositoryId, JSON.stringify({ source: "requested_review" })],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, trigger_source, trigger_context)
         VALUES ($1, 6, 'wrong-event-head', 'base', 'requested_review', $2)`,
        [
          repositoryId,
          JSON.stringify({
            source: "requested_review",
            webhookDeliveryId: "delivery-3",
            webhookEvent: "pull_request",
          }),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, trigger_source, trigger_context)
         VALUES ($1, 7, 'malformed-evidence-head', 'base', 'requested_review', $2)`,
        [
          repositoryId,
          JSON.stringify({
            source: "requested_review",
            webhookDeliveryId: "delivery-4",
            webhookEvent: "issue_comment",
            sourceCommentId: "not-a-number",
            sourceUrl: "https://example.com/not-github",
          }),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, trigger_source, trigger_context)
         VALUES ($1, 8, 'extra-evidence-head', 'base', 'requested_review', $2)`,
        [
          repositoryId,
          JSON.stringify({
            source: "requested_review",
            webhookDeliveryId: "delivery-5",
            webhookEvent: "issue_comment",
            unrelated: "not-provenance",
          }),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("defers historical validation while enforcing constraints on new rows", async () => {
    const constraints = await pool.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname IN (
          'reviews_trigger_source_check',
          'reviews_trigger_context_check',
          'usage_events_trigger_source_check'
        )
        ORDER BY conname`,
    );
    expect(constraints.rows).toEqual([
      { conname: "reviews_trigger_context_check", convalidated: false },
      { conname: "reviews_trigger_source_check", convalidated: false },
      { conname: "usage_events_trigger_source_check", convalidated: false },
    ]);
  });
});
