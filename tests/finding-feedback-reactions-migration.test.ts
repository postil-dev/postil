import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "pg";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

async function applyMigration(database: Client, path: string): Promise<void> {
  const source = await readFile(path, "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) await database.query(sql);
  }
}

describeDb("finding feedback reaction migration", () => {
  const databaseName = `postil_finding_feedback_reactions_${process.pid}_${Date.now()}`;
  let admin: Client | undefined;
  let database: Client | undefined;
  let publicationId = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);

    const databaseUrl = new URL(TEST_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    database = new Client({ connectionString: databaseUrl.toString() });
    await database.connect();

    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const previousMigrations = (await readdir(migrationDirectory))
      .filter((file) => /^\d{4}_.*[.]sql$/.test(file) && file < "0055_")
      .sort();
    for (const migration of previousMigrations) {
      await applyMigration(database, join(migrationDirectory, migration));
    }

    const fixture = await database.query<{ publication_id: string }>(
      `WITH inserted_org AS (
         INSERT INTO organizations (slug, name)
         VALUES ('feedback-migration-org', 'Feedback migration org')
         RETURNING id
       ), inserted_installation AS (
         INSERT INTO installations
           (github_installation_id, org_id, account_login, account_type)
         SELECT 99005501, id, 'feedback-migration-org', 'Organization'
         FROM inserted_org
         RETURNING id, github_installation_id, org_id
       ), inserted_repository AS (
         INSERT INTO repositories
           (installation_id, github_repo_id, full_name)
         SELECT id, 99005502, 'feedback-migration-org/repository'
         FROM inserted_installation
         RETURNING id, github_repo_id
       ), inserted_review AS (
         INSERT INTO reviews
           (repository_id, source_org_id, source_installation_id,
            source_github_installation_id, source_github_repo_id,
            source_repo_full_name, pr_number, head_sha, base_sha, status,
            author_github_id, author_login, finished_at)
         SELECT inserted_repository.id, inserted_installation.org_id,
                inserted_installation.id,
                inserted_installation.github_installation_id,
                inserted_repository.github_repo_id,
                'feedback-migration-org/repository', 55,
                'feedback-head', 'feedback-base', 'completed',
                99005503, 'pull-request-author', now()
         FROM inserted_repository, inserted_installation
         RETURNING id
       ), inserted_publication AS (
         INSERT INTO finding_publications
           (review_id, finding_id, stable_identity, initial_state,
            current_state, github_comment_id)
         SELECT id, 'legacy-reaction', true, 'inline', 'inline', '99005504'
         FROM inserted_review
         RETURNING id
       )
       SELECT id::text AS publication_id FROM inserted_publication`,
    );
    publicationId = fixture.rows[0]!.publication_id;

    await database.query(
      `INSERT INTO finding_feedback
         (finding_publication_id, source, source_github_comment_id,
          source_github_reaction_id, body, actor_github_id,
          actor_login_snapshot, pr_author_github_id,
          pr_author_login_snapshot, actor_is_pr_author, observed_at,
          source_delivery_id)
       VALUES ($1, 'reaction', 99005504, 99005505, NULL, 99005503,
               'pull-request-author', 99005503, 'pull-request-author', true,
               '2026-08-24T12:00:00Z', NULL)`,
      [publicationId],
    );

    await applyMigration(
      database,
      join(migrationDirectory, "0055_finding_feedback_reactions.sql"),
    );
  }, 60_000);

  afterAll(async () => {
    await database?.end();
    if (admin) {
      if (process.env.POSTIL_KEEP_TEST_DATABASE === "1") {
        console.error(`Preserved test database ${databaseName}`);
      } else {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      }
      await admin.end();
    }
  }, 30_000);

  test("preserves a legacy reaction without inventing its reaction type", async () => {
    const feedback = await database!.query<{
      source: string;
      source_github_reaction_id: string;
      reaction_content: string;
    }>(
      `SELECT source, source_github_reaction_id, reaction_content
         FROM finding_feedback
        WHERE finding_publication_id = $1`,
      [publicationId],
    );
    expect(feedback.rows).toEqual([{
      source: "reaction",
      source_github_reaction_id: "99005505",
      reaction_content: "unknown",
    }]);
  });

  test("keeps feedback immutable and admits typed reactions", async () => {
    await expect(
      database!.query(
        "UPDATE finding_feedback SET reaction_content = '+1' WHERE finding_publication_id = $1",
        [publicationId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });

    await database!.query(
      `INSERT INTO finding_feedback
         (finding_publication_id, source, source_github_comment_id,
          source_github_reaction_id, reaction_content, body, actor_github_id,
          actor_login_snapshot, pr_author_github_id,
          pr_author_login_snapshot, actor_is_pr_author, observed_at,
          source_delivery_id)
       VALUES ($1, 'reaction', 99005504, 99005506, '+1', NULL, 99005503,
               'pull-request-author', 99005503, 'pull-request-author', true,
               '2026-08-24T12:01:00Z', NULL)`,
      [publicationId],
    );
  });
});
