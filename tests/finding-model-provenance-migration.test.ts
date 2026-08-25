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

describeDb("finding model provenance migration", () => {
  const databaseName = `postil_finding_model_provenance_${process.pid}_${Date.now()}`;
  let admin: Client | undefined;
  let database: Client | undefined;
  let userId = "";
  let reviewId = "";

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
      .filter((file) => /^\d{4}_.*[.]sql$/.test(file) && file < "0054_")
      .sort();
    for (const migration of previousMigrations) {
      await applyMigration(database, join(migrationDirectory, migration));
    }

    const fixture = await database.query<{
      user_id: string;
      review_id: string;
    }>(
      `WITH inserted_user AS (
         INSERT INTO users (github_id, login)
         VALUES (99005401, 'provenance-migration-user')
         RETURNING id
       ), inserted_org AS (
         INSERT INTO organizations (slug, name)
         VALUES ('provenance-migration-org', 'Provenance migration org')
         RETURNING id
       ), inserted_installation AS (
         INSERT INTO installations
           (github_installation_id, org_id, account_login, account_type)
         SELECT 99005402, inserted_org.id, 'provenance-migration-org',
                'Organization'
         FROM inserted_org
         RETURNING id, github_installation_id, org_id
       ), inserted_repository AS (
         INSERT INTO repositories
           (installation_id, github_repo_id, full_name)
         SELECT inserted_installation.id, 99005403,
                'provenance-migration-org/repository'
         FROM inserted_installation
         RETURNING id, github_repo_id
       ), inserted_review AS (
         INSERT INTO reviews
           (repository_id, source_org_id, source_installation_id,
            source_github_installation_id, source_github_repo_id,
            source_repo_full_name, pr_number, head_sha, base_sha, status)
         SELECT inserted_repository.id, inserted_org.id,
                inserted_installation.id,
                inserted_installation.github_installation_id,
                inserted_repository.github_repo_id,
                'provenance-migration-org/repository', 54,
                'provenance-head', 'provenance-base', 'completed'
         FROM inserted_repository, inserted_installation, inserted_org
         RETURNING id
       )
       SELECT inserted_user.id::text AS user_id,
              inserted_review.id::text AS review_id
       FROM inserted_user, inserted_review`,
    );
    userId = fixture.rows[0]!.user_id;
    reviewId = fixture.rows[0]!.review_id;

    await database.query(
      `INSERT INTO finding_approvals
         (review_id, finding_id, actor_user_id, actor_github_id,
          actor_login_snapshot, actor_role_snapshot, verb, reason_tag,
          author_self_dismissal, finding_kind, finding_severity,
          finding_confidence, finding_model, rationale, source,
          source_org_id, source_repository_id,
          source_github_installation_id, source_github_repo_id,
          source_pr_number, source_head_sha, source_binding_state)
       SELECT review.id, fixture.finding_id, $2, '99005401',
              'provenance-migration-user', 'admin', fixture.verb,
              fixture.reason_tag, false, fixture.finding_kind,
              fixture.finding_severity, fixture.finding_confidence,
              fixture.finding_model, fixture.rationale, 'dashboard',
              review.source_org_id, review.repository_id,
              review.source_github_installation_id,
              review.source_github_repo_id, review.pr_number,
              review.head_sha, 'exact'
       FROM reviews review
       CROSS JOIN (VALUES
         ('existing-approval', 'approve'::finding_approval_verb, NULL::text,
          NULL::text, NULL::text, NULL::real, NULL::text,
          'Approved before provenance migration'),
         ('existing-dismissal', 'dismiss'::finding_approval_verb,
          'false-positive', 'risk', 'error', 0.9::real,
          'generator/existing', 'Dismissed before provenance migration')
       ) AS fixture(
         finding_id, verb, reason_tag, finding_kind, finding_severity,
         finding_confidence, finding_model, rationale
       )
       WHERE review.id = $1`,
      [reviewId, userId],
    );

    await applyMigration(
      database,
      join(migrationDirectory, "0054_finding_model_provenance.sql"),
    );
  }, 60_000);

  afterAll(async () => {
    await database?.end();
    if (admin) {
      if (process.env.POSTIL_KEEP_TEST_DATABASE === "1") {
        console.error(`Preserved test database ${databaseName}`);
      } else {
        await admin.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
      }
      await admin.end();
    }
  }, 30_000);

  test("preserves generator provenance and initializes nullable scorer provenance", async () => {
    const rows = await database!.query<{
      finding_id: string;
      finding_model: string | null;
      finding_scorer_model: string | null;
    }>(
      `SELECT finding_id, finding_model, finding_scorer_model
         FROM finding_approvals
        WHERE review_id = $1
        ORDER BY finding_id`,
      [reviewId],
    );

    expect(rows.rows).toEqual([
      {
        finding_id: "existing-approval",
        finding_model: null,
        finding_scorer_model: null,
      },
      {
        finding_id: "existing-dismissal",
        finding_model: "generator/existing",
        finding_scorer_model: null,
      },
    ]);
  });

  test("stores scorer provenance only on complete dismissal audits", async () => {
    await database!.query(
      `INSERT INTO finding_approvals
         (review_id, finding_id, actor_user_id, actor_github_id,
          actor_login_snapshot, actor_role_snapshot, verb, reason_tag,
          author_self_dismissal, finding_kind, finding_severity,
          finding_confidence, finding_model, finding_scorer_model,
          rationale, source, source_org_id, source_repository_id,
          source_github_installation_id, source_github_repo_id,
          source_pr_number, source_head_sha, source_binding_state)
       SELECT review.id, 'scored-dismissal', $2, '99005401',
              'provenance-migration-user', 'admin', 'dismiss',
              'accepted-risk', false, 'risk', 'warn', 0.8,
              'generator/current', 'scorer/current',
              'Dismissed with complete model provenance', 'dashboard',
              review.source_org_id, review.repository_id,
              review.source_github_installation_id,
              review.source_github_repo_id, review.pr_number,
              review.head_sha, 'exact'
       FROM reviews review
       WHERE review.id = $1`,
      [reviewId, userId],
    );

    const stored = await database!.query<{
      finding_model: string;
      finding_scorer_model: string;
    }>(
      `SELECT finding_model, finding_scorer_model
         FROM finding_approvals
        WHERE review_id = $1 AND finding_id = 'scored-dismissal'`,
      [reviewId],
    );
    expect(stored.rows).toEqual([
      {
        finding_model: "generator/current",
        finding_scorer_model: "scorer/current",
      },
    ]);

    await expect(
      database!.query(
        `UPDATE finding_approvals
            SET finding_scorer_model = 'scorer/rewritten'
          WHERE review_id = $1 AND finding_id = 'scored-dismissal'`,
        [reviewId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  test("keeps approval provenance empty and preserves revocation behavior", async () => {
    await expect(
      database!.query(
        `INSERT INTO finding_approvals
           (review_id, finding_id, actor_user_id, actor_github_id,
            actor_login_snapshot, actor_role_snapshot, verb,
            finding_scorer_model, rationale, source, source_org_id,
            source_repository_id, source_github_installation_id,
            source_github_repo_id, source_pr_number, source_head_sha,
            source_binding_state)
         SELECT review.id, 'invalid-approval', $2, '99005401',
                'provenance-migration-user', 'admin', 'approve',
                'scorer/invalid', 'Invalid approval provenance', 'dashboard',
                review.source_org_id, review.repository_id,
                review.source_github_installation_id,
                review.source_github_repo_id, review.pr_number,
                review.head_sha, 'exact'
         FROM reviews review
         WHERE review.id = $1`,
        [reviewId, userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await database!.query(
      `UPDATE finding_approvals
          SET revoked_at = clock_timestamp(), revoked_by_user_id = $2
        WHERE review_id = $1 AND finding_id = 'existing-dismissal'`,
      [reviewId, userId],
    );
    const revoked = await database!.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked
         FROM finding_approvals
        WHERE review_id = $1 AND finding_id = 'existing-dismissal'`,
      [reviewId],
    );
    expect(revoked.rows).toEqual([{ revoked: true }]);
  });
});
