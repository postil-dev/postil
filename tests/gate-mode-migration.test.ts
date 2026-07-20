import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "pg";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("gate mode migration", () => {
  const schemaName = `gate_mode_${process.pid}_${Date.now()}`;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_URL });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}"`);
    await client.query(`
      CREATE TABLE users (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY
      );
      CREATE TABLE organizations (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        slug text NOT NULL UNIQUE,
        name text NOT NULL
      );
      CREATE TABLE org_settings (
        org_id bigint PRIMARY KEY REFERENCES organizations(id) ON DELETE cascade
      );
      CREATE TABLE reviews (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY
      );
      CREATE TABLE repositories (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY
      );
      CREATE TABLE usage_events (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        org_id bigint,
        billing_scope text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE billing_credit_grants (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        org_id bigint NOT NULL,
        applies_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE repository_enablement_events (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        org_id bigint NOT NULL,
        github_repo_id bigint NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO organizations (slug, name) VALUES
        ('with-settings', 'With settings'),
        ('without-settings', 'Without settings');
      INSERT INTO org_settings (org_id)
      SELECT id FROM organizations WHERE slug = 'with-settings';
    `);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await client.end();
  });

  test("keeps every existing organization gated and gives new settings advisory defaults", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0034_gate_control_and_enforcement.sql"),
      "utf8",
    );
    await client.query(migration);

    const legacy = await client.query<{ slug: string; gate_enabled: boolean | null }>(`
      SELECT organizations.slug, org_settings.gate_enabled
      FROM organizations
      LEFT JOIN org_settings ON org_settings.org_id = organizations.id
      ORDER BY organizations.slug
    `);
    expect(legacy.rows.sort((a, b) => a.slug.localeCompare(b.slug))).toEqual([
      { slug: "with-settings", gate_enabled: true },
      { slug: "without-settings", gate_enabled: true },
    ].sort((a, b) => a.slug.localeCompare(b.slug)));

    const baselines = await client.query(`SELECT id FROM organization_setting_events`);
    expect(baselines.rows).toEqual([]);

    expect(migration).not.toMatch(/CREATE (?:UNIQUE )?INDEX[^;]+(?:usage_events|billing_credit_grants|repository_enablement_events)/i);

    const created = await client.query<{ gate_enabled: boolean }>(`
      WITH organization AS (
        INSERT INTO organizations (slug, name)
        VALUES ('new-organization', 'New organization')
        RETURNING id
      )
      INSERT INTO org_settings (org_id)
      SELECT id FROM organization
      RETURNING gate_enabled
    `);
    expect(created.rows).toEqual([{ gate_enabled: false }]);
  });
});
