import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "pg";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("postil-dev model override migration", () => {
  const databaseName = `postil_model_migration_${process.pid}_${Date.now()}`;
  let adminClient: Client | undefined;
  let migrationClient: Client | undefined;

  beforeAll(async () => {
    adminClient = new Client({ connectionString: TEST_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${databaseName}"`);

    const databaseUrl = new URL(TEST_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    migrationClient = new Client({ connectionString: databaseUrl.toString() });
    await migrationClient.connect();

    const migrationsDir = join(import.meta.dir, "..", "drizzle");
    const setupMigrations = (await readdir(migrationsDir))
      .filter((file) => /^000[0-7]_.*\.sql$/.test(file))
      .sort();
    for (const file of setupMigrations) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await migrationClient.query(statement);
      }
    }
  });

  afterAll(async () => {
    await migrationClient?.end();
    if (adminClient) {
      await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminClient.end();
    }
  });

  test("clears only the postil-dev model override and is idempotent", async () => {
    await migrationClient!.query(`
      INSERT INTO organizations (slug, name)
      VALUES ('postil-dev', 'Postil'), ('another-org', 'Another org');
      INSERT INTO org_settings (org_id, model, model_cascade)
      SELECT id, 'moonshotai/kimi-k2.6', 'stale/fallback'
      FROM organizations
      WHERE slug = 'postil-dev';
      INSERT INTO org_settings (org_id, model, model_cascade)
      SELECT id, 'org/model', 'org/fallback'
      FROM organizations
      WHERE slug = 'another-org';
    `);

    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0008_clear_postil_dev_model_override.sql"),
      "utf8",
    );
    await migrationClient!.query(migration);
    await migrationClient!.query(migration);

    const result = await migrationClient!.query<{
      slug: string;
      model: string | null;
      model_cascade: string | null;
    }>(`
      SELECT organizations.slug, org_settings.model, org_settings.model_cascade
      FROM organizations
      JOIN org_settings ON org_settings.org_id = organizations.id
      ORDER BY organizations.slug
    `);

    expect(result.rows).toEqual([
      { slug: "another-org", model: "org/model", model_cascade: "org/fallback" },
      { slug: "postil-dev", model: null, model_cascade: null },
    ]);
  });
});
