import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "pg";

import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("finding approvals repair migration", () => {
  let database: EphemeralDatabase;
  let migrationClient: Client | undefined;

  beforeAll(async () => {
    database = await createUnmigratedEphemeralDatabase("approvals_repair");
    migrationClient = new Client({ connectionString: database.url });
    await migrationClient.connect();

    const migrationsDir = join(import.meta.dir, "..", "drizzle");
    const setupMigrations = (await readdir(migrationsDir))
      .filter((file) => /^000[0-6]_.*\.sql$/.test(file) || file.startsWith("0008_"))
      .sort();
    for (const file of setupMigrations) {
      await applyMigration(migrationClient, join(migrationsDir, file));
    }
  });

  afterAll(async () => {
    await migrationClient?.end();
    await database?.drop();
  });

  test("repairs a database where the out-of-order 0007 migration was skipped", async () => {
    const migration = join(
      import.meta.dir,
      "..",
      "drizzle",
      "0009_repair_finding_approvals.sql",
    );
    await applyMigration(migrationClient!, migration);
    await applyMigration(migrationClient!, migration);

    const result = await migrationClient!.query<{
      approvals_table: string | null;
      engine_gate_failing: boolean;
      foreign_key_count: number;
      index_count: number;
    }>(`
      SELECT
        to_regclass('public.finding_approvals')::text AS approvals_table,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'reviews'
            AND column_name = 'engine_gate_failing'
        ) AS engine_gate_failing,
        (
          SELECT count(*)::int FROM pg_constraint
          WHERE conrelid = 'public.finding_approvals'::regclass
            AND contype = 'f'
        ) AS foreign_key_count,
        (
          SELECT count(*)::int FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'finding_approvals'
            AND indexname IN ('finding_approvals_active_idx', 'finding_approvals_review_idx')
        ) AS index_count
    `);

    expect(result.rows).toEqual([
      {
        approvals_table: "finding_approvals",
        engine_gate_failing: true,
        foreign_key_count: 3,
        index_count: 2,
      },
    ]);
  });
});

async function applyMigration(client: Client, path: string): Promise<void> {
  const sql = await readFile(path, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}
