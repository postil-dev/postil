import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describe("gate enforcement migration source", () => {
  test("adds bounded repository observation state without rewriting existing rows", async () => {
    const migration = await migrationSource();
    expect(migration).toContain('CREATE TABLE "repository_gate_enforcement"');
    expect(migration).toContain('"last_successful_at" timestamp with time zone');
    expect(migration).toContain('"last_error" text');
    expect(migration).toContain('"status" IN (\'required\', \'not_required\', \'unknown\')');
    expect(migration).not.toContain("jobs_active_gate_enforcement_sweep_scope_idx");
    expect(migration).not.toMatch(/\bUPDATE\b/i);
  });
});

describeDb("gate enforcement migration behavior", () => {
  const schemaName = `gate_enforcement_${process.pid}_${Date.now()}`;
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
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY
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
      CREATE TABLE jobs (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        kind text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL
      );
      INSERT INTO repositories DEFAULT VALUES;
    `);
    await client.query(await migrationSource());
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await client.end();
  });

  test("enforces observation states", async () => {
    await client.query(`
      INSERT INTO repository_gate_enforcement
        (repository_id, status, checked_at)
      VALUES (1, 'unknown', now())
    `);
    await expect(
      client.query(`
        UPDATE repository_gate_enforcement
        SET status = 'assumed'
        WHERE repository_id = 1
      `),
    ).rejects.toThrow();
  });

});

function migrationSource(): Promise<string> {
  return readFile(
    new URL("../drizzle/0034_gate_control_and_enforcement.sql", import.meta.url),
    "utf8",
  );
}
