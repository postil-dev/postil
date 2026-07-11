import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "pg";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("postil-dev model override migration", () => {
  const schemaName = `postil_model_migration_${process.pid}_${Date.now()}`;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_URL });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}"`);
    await client.query(`
      CREATE TABLE organizations (
        id bigint PRIMARY KEY,
        slug text NOT NULL UNIQUE
      );
      CREATE TABLE org_settings (
        org_id bigint PRIMARY KEY REFERENCES organizations(id),
        model text,
        model_cascade text
      );
    `);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await client.end();
  });

  test("clears only the postil-dev model override and is idempotent", async () => {
    await client.query(`
      INSERT INTO organizations (id, slug)
      VALUES (1, 'postil-dev'), (2, 'another-org');
      INSERT INTO org_settings (org_id, model, model_cascade)
      VALUES
        (1, 'moonshotai/kimi-k2.6', 'stale/fallback'),
        (2, 'org/model', 'org/fallback');
    `);

    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0008_clear_postil_dev_model_override.sql"),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);

    const result = await client.query<{
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
