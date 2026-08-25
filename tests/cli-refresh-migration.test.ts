import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "pg";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("CLI refresh session migration", () => {
  const databaseName = `postil_cli_refresh_migration_${process.pid}_${Date.now()}`;
  let adminClient: Client | undefined;
  let migrationClient: Client | undefined;
  let legacyTokenId = "";

  beforeAll(async () => {
    adminClient = new Client({ connectionString: TEST_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${databaseName}"`);

    const databaseUrl = new URL(TEST_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    migrationClient = new Client({ connectionString: databaseUrl.toString() });
    await migrationClient.connect();

    const migrationsDir = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationsDir))
      .filter((file) => /^\d{4}_.*\.sql$/.test(file) && file < "0051_")
      .sort();
    for (const migration of migrations) {
      await applyMigration(migrationClient, join(migrationsDir, migration));
    }

    const user = await migrationClient.query<{ id: string }>(
      `INSERT INTO users (github_id, login)
       VALUES (990051, 'refresh-migration-user')
       RETURNING id`,
    );
    const organization = await migrationClient.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ('refresh-migration-org', 'Refresh Migration Org')
       RETURNING id`,
    );
    const legacyToken = await migrationClient.query<{ id: string }>(
      `INSERT INTO cli_tokens
         (token_sha256, user_id, org_id, scope, expires_at)
       VALUES ($1, $2, $3, 'inference', clock_timestamp() + interval '12 hours')
       RETURNING id`,
      [
        digest("legacy-access-token"),
        user.rows[0]!.id,
        organization.rows[0]!.id,
      ],
    );
    legacyTokenId = legacyToken.rows[0]!.id;

    await applyMigration(
      migrationClient,
      join(migrationsDir, "0051_refreshable_cli_sessions.sql"),
    );
  }, 30_000);

  afterAll(async () => {
    await migrationClient?.end();
    if (adminClient) {
      if (process.env.POSTIL_KEEP_TEST_DATABASE !== "1") {
        await adminClient.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
      }
      await adminClient.end();
    }
  }, 30_000);

  test("upgrades populated 0050 state and enforces one current refresh row", async () => {
    const preserved = await migrationClient!.query<{
      id: string;
      refresh_session_id: string | null;
    }>(
      `SELECT id::text, refresh_session_id::text
       FROM cli_tokens
       WHERE id = $1`,
      [legacyTokenId],
    );
    expect(preserved.rows).toEqual([
      { id: legacyTokenId, refresh_session_id: null },
    ]);

    const session = await migrationClient!.query<{ id: string }>(
      `INSERT INTO cli_refresh_sessions
         (user_id, org_id, expires_at, last_used_at)
       SELECT user_id, org_id,
              clock_timestamp() + interval '180 days',
              clock_timestamp()
       FROM cli_tokens
       WHERE id = $1
       RETURNING id`,
      [legacyTokenId],
    );
    const sessionId = session.rows[0]!.id;
    await migrationClient!.query(
      `INSERT INTO cli_refresh_tokens (token_sha256, session_id, expires_at)
       VALUES ($1, $2, clock_timestamp() + interval '180 days')`,
      [digest("first-refresh-token"), sessionId],
    );
    await expect(
      migrationClient!.query(
        `INSERT INTO cli_refresh_tokens (token_sha256, session_id, expires_at)
         VALUES ($1, $2, clock_timestamp() + interval '180 days')`,
        [digest("second-refresh-token"), sessionId],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await migrationClient!.query(
      `UPDATE cli_refresh_tokens
       SET consumed_at = clock_timestamp()
       WHERE session_id = $1`,
      [sessionId],
    );
    await expect(
      migrationClient!.query(
        `INSERT INTO cli_refresh_tokens (token_sha256, session_id, expires_at)
         VALUES ($1, $2, clock_timestamp() + interval '180 days')`,
        [digest("second-refresh-token"), sessionId],
      ),
    ).resolves.toBeDefined();
  });
});

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

async function applyMigration(client: Client, path: string): Promise<void> {
  const source = await readFile(path, "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}
