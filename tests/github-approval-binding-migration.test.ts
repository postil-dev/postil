import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import { ensureOperationalIndexes } from "../scripts/ensure-operational-indexes";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("GitHub approval binding migration", () => {
  const databaseName = `postil_github_approval_binding_${process.pid}_${Date.now()}`;
  let adminClient: Client | undefined;
  let client: Client | undefined;
  let orgId = 0;
  let installationId = 0;
  let repositoryId = 0;
  let reviewId = 0;
  let actorUserId = 0;
  let incompleteApprovalId = "";

  beforeAll(async () => {
    adminClient = new Client({ connectionString: TEST_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${databaseName}"`);

    const databaseUrl = new URL(TEST_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    const isolatedDatabaseUrl = databaseUrl.toString();
    client = new Client({ connectionString: isolatedDatabaseUrl });
    await client.connect();

    const migrationsDirectory = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql") && file < "0037_")
      .sort();
    for (const migration of migrations) {
      await applyMigration(client, join(migrationsDirectory, migration));
    }

    orgId = Number((await client.query<{ id: string }>(
      "INSERT INTO organizations (slug, name, github_org_id) VALUES ('approval-binding', 'Approval Binding', 101) RETURNING id",
    )).rows[0]!.id);
    installationId = Number((await client.query<{ id: string }>(
      `INSERT INTO installations (github_installation_id, org_id, account_login, account_type)
       VALUES (202, $1, 'approval-binding', 'Organization') RETURNING id`,
      [orgId],
    )).rows[0]!.id);
    repositoryId = Number((await client.query<{ id: string }>(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name, private, enabled)
       VALUES ($1, 303, 'approval-binding/repo', false, true) RETURNING id`,
      [installationId],
    )).rows[0]!.id);
    actorUserId = Number((await client.query<{ id: string }>(
      "INSERT INTO users (github_id, login) VALUES (404, 'admin') RETURNING id",
    )).rows[0]!.id);
    reviewId = Number((await client.query<{ id: string }>(
      `INSERT INTO reviews (
         repository_id, source_org_id, source_installation_id,
         source_github_installation_id, source_github_repo_id, source_repo_full_name,
         pr_number, head_sha, base_sha, status
       ) VALUES ($1, $2, $3, 202, 303, 'approval-binding/repo', 5, 'head-sha', 'base-sha', 'completed')
       RETURNING id`,
      [repositoryId, orgId, installationId],
    )).rows[0]!.id);
    await client.query(
      `INSERT INTO finding_approvals (
         review_id, finding_id, actor_user_id, actor_github_id,
         actor_login_snapshot, actor_role_snapshot, rationale, source
       ) VALUES ($1, 'legacy-finding', $2, '404', 'admin', 'admin', 'accepted risk', 'dashboard')`,
      [reviewId, actorUserId],
    );
    const incompleteReviewId = Number((await client.query<{ id: string }>(
      `INSERT INTO reviews (repository_id, pr_number, head_sha, base_sha, status)
       VALUES ($1, 6, 'legacy-head', 'base-sha', 'completed') RETURNING id`,
      [repositoryId],
    )).rows[0]!.id);
    incompleteApprovalId = (await client.query<{ id: string }>(
      `INSERT INTO finding_approvals (
         review_id, finding_id, actor_user_id, actor_github_id,
         actor_login_snapshot, actor_role_snapshot, rationale, source
       ) VALUES ($1, 'incomplete-legacy', $2, '404', 'admin', 'admin',
         'accepted risk', 'dashboard') RETURNING id`,
      [incompleteReviewId, actorUserId],
    )).rows[0]!.id;

    await applyMigration(client, join(migrationsDirectory, "0037_github_approval_bindings.sql"));
    const operationalPool = new Pool({ connectionString: isolatedDatabaseUrl, max: 1 });
    try {
      await ensureOperationalIndexes(operationalPool);
    } finally {
      await operationalPool.end();
    }
  }, 30_000);

  afterAll(async () => {
    await client?.end();
    if (adminClient) {
      await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminClient.end();
    }
  });

  test("backfills the immutable review identity onto existing approvals", async () => {
    const row = (await client!.query<{
      source_org_id: string;
      source_repository_id: string;
      source_github_installation_id: string;
      source_github_repo_id: string;
      source_pr_number: number;
      source_head_sha: string;
      source_binding_state: string;
    }>("SELECT * FROM finding_approvals WHERE finding_id = 'legacy-finding'" )).rows[0]!;

    expect(row).toMatchObject({
      source_org_id: String(orgId),
      source_repository_id: String(repositoryId),
      source_github_installation_id: "202",
      source_github_repo_id: "303",
      source_pr_number: 5,
      source_head_sha: "head-sha",
      source_binding_state: "exact",
    });
  });

  test("accepts an exact GitHub event binding and permits only revocation changes", async () => {
    const result = await client!.query<{ id: string; source_binding_state: string }>(
      `INSERT INTO finding_approvals (
         review_id, finding_id, actor_user_id, actor_github_id,
         actor_login_snapshot, actor_role_snapshot, rationale, source,
         source_url, source_org_id, source_repository_id,
         source_github_installation_id, source_github_repo_id, source_pr_number,
         source_head_sha, source_webhook_delivery_id, source_github_comment_id,
         source_comment_kind
       ) VALUES (
         $1, 'github-finding', $2, '404', 'admin', 'admin', 'accepted risk', 'github',
         'https://github.com/approval-binding/repo/pull/5#issuecomment-505',
         $3, $4, 202, 303, 5, 'head-sha', 'delivery-505', 505, 'issue_comment'
       ) RETURNING id, source_binding_state`,
      [reviewId, actorUserId, orgId, repositoryId],
    );
    const approvalId = result.rows[0]!.id;
    expect(result.rows[0]!.source_binding_state).toBe("exact");

    await client!.query(
      "UPDATE finding_approvals SET revoked_at = now(), revoked_by_user_id = $2 WHERE id = $1",
      [approvalId, actorUserId],
    );
    await expect(
      client!.query(
        "UPDATE finding_approvals SET source_head_sha = 'different-head' WHERE id = $1",
        [approvalId],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      client!.query(
        "UPDATE finding_approvals SET source_binding_state = 'legacy' WHERE id = $1",
        [approvalId],
      ),
    ).rejects.toThrow("immutable");
  });

  test("records a new dashboard approval with exact binding", async () => {
    const row = (await client!.query<{ source_binding_state: string }>(
      `INSERT INTO finding_approvals (
         review_id, finding_id, actor_user_id, actor_github_id,
         actor_login_snapshot, actor_role_snapshot, rationale, source,
         source_org_id, source_repository_id, source_github_installation_id,
         source_github_repo_id, source_pr_number, source_head_sha
       ) VALUES ($1, 'dashboard-exact', $2, '404', 'admin', 'admin',
         'accepted risk', 'dashboard', $3, $4, 202, 303, 5, 'head-sha')
       RETURNING source_binding_state`,
      [reviewId, actorUserId, orgId, repositoryId],
    )).rows[0]!;
    expect(row.source_binding_state).toBe("exact");
  });

  test("keeps an approval with unavailable legacy identity revocable", async () => {
    await client!.query(
      "UPDATE finding_approvals SET revoked_at = now(), revoked_by_user_id = $2 WHERE id = $1",
      [incompleteApprovalId, actorUserId],
    );
    const row = (await client!.query<{
      revoked: boolean;
      source_binding_state: string;
      source_org_id: string | null;
    }>(
      "SELECT revoked_at IS NOT NULL AS revoked, source_binding_state, source_org_id FROM finding_approvals WHERE id = $1",
      [incompleteApprovalId],
    )).rows[0]!;
    expect(row).toEqual({
      revoked: true,
      source_binding_state: "legacy",
      source_org_id: null,
    });
  });

  test("rejects attempts to create a new legacy-bound approval", async () => {
    await expect(
      client!.query(
        `INSERT INTO finding_approvals (
           review_id, finding_id, actor_user_id, actor_github_id,
           actor_login_snapshot, actor_role_snapshot, rationale, source,
           source_binding_state
         ) VALUES ($1, 'new-legacy', $2, '404', 'admin', 'admin',
           'accepted risk', 'dashboard', 'legacy')`,
        [reviewId, actorUserId],
      ),
    ).rejects.toThrow("require exact source binding");
  });

  test("rejects mismatched review identity and replayed webhook provenance", async () => {
    const values = [reviewId, actorUserId, orgId, repositoryId];
    await expect(
      client!.query(
        `INSERT INTO finding_approvals (
           review_id, finding_id, actor_user_id, actor_github_id,
           actor_login_snapshot, actor_role_snapshot, rationale, source,
           source_org_id, source_repository_id, source_github_installation_id,
           source_github_repo_id, source_pr_number, source_head_sha,
           source_webhook_delivery_id, source_github_comment_id, source_comment_kind
         ) VALUES ($1, 'mismatch', $2, '404', 'admin', 'admin', 'accepted risk', 'github',
           $3, $4, 202, 303, 5, 'wrong-head', 'delivery-506', 506, 'issue_comment')`,
        values,
      ),
    ).rejects.toThrow("does not match its review");

    await expect(
      client!.query(
        `INSERT INTO finding_approvals (
           review_id, finding_id, actor_user_id, actor_github_id,
           actor_login_snapshot, actor_role_snapshot, rationale, source,
           source_org_id, source_repository_id, source_github_installation_id,
           source_github_repo_id, source_pr_number, source_head_sha,
           source_webhook_delivery_id, source_github_comment_id, source_comment_kind
         ) VALUES ($1, 'replay', $2, '404', 'admin', 'admin', 'accepted risk', 'github',
           $3, $4, 202, 303, 5, 'head-sha', 'delivery-505', 507, 'issue_comment')`,
        values,
      ),
    ).rejects.toThrow("finding_approvals_github_delivery_idx");
  });
});

async function applyMigration(client: Client, path: string): Promise<void> {
  const sql = await readFile(path, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}
