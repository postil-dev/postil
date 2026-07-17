import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "pg";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("webhook inbox activation migration", () => {
  const databaseName = `postil_webhook_migration_${process.pid}_${Date.now()}`;
  let admin: Client;
  let client: Client;

  beforeAll(async () => {
    const adminUrl = new URL(TEST_URL!);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);

    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    client = new Client({ connectionString: databaseUrl.toString() });
    await client.connect();

    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const preparationMigrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql") && file < "0025_")
      .sort();
    for (const migration of preparationMigrations) {
      await applyMigration(client, join(migrationDirectory, migration));
    }

    await client.query(`
      INSERT INTO webhook_deliveries (delivery_id, event, payload, completed_at)
      VALUES
        ('completed', 'ping', NULL, now()),
        ('missing-completion', 'ping', NULL, NULL),
        ('pending', 'pull_request', '{"action":"opened"}'::jsonb, NULL),
        ('retained-completed', 'issues', '{"action":"opened"}'::jsonb, now())
    `);
    await applyMigration(
      client,
      join(migrationDirectory, "0025_activate_durable_webhook_inbox.sql"),
    );
  }, 120_000);

  afterAll(async () => {
    await client?.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  test("normalizes completion state and queues every retained payload", async () => {
    const deliveries = await client.query<{
      delivery_id: string;
      completed: boolean;
      payload_retained: boolean;
    }>(`
      SELECT delivery_id,
             completed_at IS NOT NULL AS completed,
             payload IS NOT NULL AS payload_retained
      FROM webhook_deliveries
      ORDER BY delivery_id
    `);
    expect(deliveries.rows).toEqual([
      { delivery_id: "completed", completed: true, payload_retained: false },
      { delivery_id: "missing-completion", completed: true, payload_retained: false },
      { delivery_id: "pending", completed: false, payload_retained: true },
      { delivery_id: "retained-completed", completed: false, payload_retained: true },
    ]);

    const jobs = await client.query<{ delivery_id: string; count: number }>(`
      SELECT payload->>'deliveryId' AS delivery_id, count(*)::int AS count
      FROM jobs
      WHERE kind = 'webhook-dispatch'
      GROUP BY payload->>'deliveryId'
      ORDER BY payload->>'deliveryId'
    `);
    expect(jobs.rows).toEqual([
      { delivery_id: "pending", count: 1 },
      { delivery_id: "retained-completed", count: 1 },
    ]);
  });

  test("validates the payload-completion constraint and removes the legacy default", async () => {
    const state = await client.query<{ validated: boolean; default_expression: string | null }>(`
      SELECT constraint_row.convalidated AS validated,
             pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
      LEFT JOIN pg_attribute AS column_row
        ON column_row.attrelid = table_row.oid
       AND column_row.attname = 'completed_at'
      LEFT JOIN pg_attrdef AS default_row
        ON default_row.adrelid = table_row.oid
       AND default_row.adnum = column_row.attnum
      WHERE table_row.relname = 'webhook_deliveries'
        AND constraint_row.conname = 'webhook_deliveries_payload_completion_check'
    `);
    expect(state.rows[0]).toEqual({ validated: true, default_expression: null });
  });
});

async function applyMigration(client: Client, path: string): Promise<void> {
  const source = await readFile(path, "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}
