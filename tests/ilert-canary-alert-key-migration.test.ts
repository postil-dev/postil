import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import { ensureOperationalIndexes } from "../scripts/ensure-operational-indexes";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("iLert canary alert key migration", () => {
  const databaseName = `postil_ilert_canary_key_${process.pid}_${Date.now()}`;
  let adminClient: Client | undefined;
  let client: Client | undefined;
  let pool: Pool | undefined;
  let migrationSource = "";
  let preMigrationError: unknown;
  let preMigrationIndex: string | null = null;
  let preMigrationReleaseStep = false;
  let firstReconciliation: string[] = [];
  let secondReconciliation: string[] = [];

  beforeAll(async () => {
    adminClient = new Client({ connectionString: TEST_URL });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${databaseName}"`);

    const databaseUrl = new URL(TEST_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    const isolatedDatabaseUrl = databaseUrl.toString();
    client = new Client({ connectionString: isolatedDatabaseUrl });
    await client.connect();
    pool = new Pool({ connectionString: isolatedDatabaseUrl, max: 1 });

    const migrationsDirectory = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql") && file < "0060_")
      .sort();
    for (const migration of migrations) {
      await applyMigration(client, join(migrationsDirectory, migration));
    }

    try {
      await ensureOperationalIndexes(pool);
    } catch (error) {
      preMigrationError = error;
    }
    preMigrationIndex = (await client.query<{ index_name: string | null }>(
      `SELECT to_regclass(
         'public.ilert_alert_events_canary_observation_idx'
       )::text AS index_name`,
    )).rows[0]?.index_name ?? null;
    preMigrationReleaseStep = (await client.query<{ completed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM release_steps WHERE name = 'operational-indexes-v6'
       ) AS completed`,
    )).rows[0]?.completed ?? false;

    migrationSource = await readFile(
      join(migrationsDirectory, "0060_ilert_canary_alert_key.sql"),
      "utf8",
    );
    await client.query("BEGIN");
    try {
      for (const statement of migrationSource.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    await client.query(
      `CREATE INDEX "ilert_alert_events_canary_observation_idx"
         ON "ilert_alert_events" ("alert_key")
      WHERE "alert_key" IS NULL`,
    );
    firstReconciliation = await ensureOperationalIndexes(pool);
    secondReconciliation = await ensureOperationalIndexes(pool);
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    await pool?.end();
    if (adminClient) {
      await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminClient.end();
    }
  });

  test("keeps the migration transactional and refuses premature reconciliation", async () => {
    expect(migrationSource).not.toContain("CREATE INDEX");
    expect(String(preMigrationError)).toContain(
      "requires migrated columns public.ilert_alert_events.alert_key",
    );
    expect(preMigrationIndex).toBeNull();
    expect(preMigrationReleaseStep).toBe(false);
    const column = await client!.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'ilert_alert_events'
            AND column_name = 'alert_key'
       ) AS exists`,
    );
    expect(column.rows[0]?.exists).toBe(true);
  });

  test("repairs and idempotently verifies the exact partial composite index", async () => {
    expect(firstReconciliation).toContain(
      "ilert_alert_events_canary_observation_idx",
    );
    expect(secondReconciliation).toEqual(firstReconciliation);

    const result = await client!.query<{
      access_method: string;
      columns: string[];
      indisready: boolean;
      indisvalid: boolean;
      predicate: string;
      table_name: string;
    }>(
      `SELECT access_method.amname AS access_method,
              array_agg(attribute.attname::text ORDER BY key.ordinality)::text[] AS columns,
              index_state.indisready,
              index_state.indisvalid,
              pg_get_expr(index_state.indpred, index_state.indrelid) AS predicate,
              index_state.indrelid::regclass::text AS table_name
         FROM pg_index AS index_state
         JOIN pg_class AS index_class
           ON index_class.oid = index_state.indexrelid
         JOIN pg_am AS access_method
           ON access_method.oid = index_class.relam
         CROSS JOIN LATERAL unnest(index_state.indkey)
           WITH ORDINALITY AS key(attnum, ordinality)
         JOIN pg_attribute AS attribute
           ON attribute.attrelid = index_state.indrelid
          AND attribute.attnum = key.attnum
        WHERE index_state.indexrelid =
              to_regclass('public.ilert_alert_events_canary_observation_idx')
        GROUP BY access_method.amname,
                 index_state.indisready,
                 index_state.indisvalid,
                 index_state.indpred,
                 index_state.indrelid`,
    );
    expect(result.rows).toEqual([
      {
        access_method: "btree",
        columns: ["alert_key", "event_type", "alert_source_id"],
        indisready: true,
        indisvalid: true,
        predicate: "(alert_key IS NOT NULL)",
        table_name: "ilert_alert_events",
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
