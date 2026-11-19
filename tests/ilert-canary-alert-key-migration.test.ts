import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

import {
  ensureOperationalIndexes,
  MANAGED_RELEASE_OPERATIONAL_INDEXES,
} from "../scripts/ensure-operational-indexes";
import alertKeySnapshot from "../drizzle/meta/0064_snapshot.json";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describe("iLert canary alert key migration metadata", () => {
  test("records the applied schema as the latest generated snapshot", async () => {
    const previousSnapshot = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/0063_snapshot.json", import.meta.url),
        "utf8",
      ),
    ) as { id: string };
    const snapshot = alertKeySnapshot as {
      id: string;
      prevId: string;
      tables: Record<string, {
        columns: Record<string, {
          name: string;
          type: string;
          primaryKey: boolean;
          notNull: boolean;
        }>;
        indexes: Record<string, {
          columns: Array<{ expression: string }>;
          where?: string;
        }>;
        checkConstraints: Record<string, { value: string }>;
      }>;
    };
    const journal = JSON.parse(
      await readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    const events = snapshot.tables["public.ilert_alert_events"]!;

    expect(snapshot.prevId).toBe(previousSnapshot.id);
    expect(snapshot.id).not.toBe(previousSnapshot.id);
    expect(events.columns.alert_key).toEqual({
      name: "alert_key",
      type: "text",
      primaryKey: false,
      notNull: false,
    });
    expect(events.indexes.ilert_alert_events_canary_observation_idx).toMatchObject({
      columns: [
        { expression: "alert_key" },
        { expression: "event_type" },
        { expression: "alert_source_id" },
      ],
      where: '"ilert_alert_events"."alert_key" IS NOT NULL',
    });
    expect(
      events.checkConstraints.ilert_alert_events_alert_key_check?.value,
    ).toContain('length("ilert_alert_events"."alert_key") BETWEEN 1 AND 512');
    expect(journal.entries.at(-1)).toEqual({
      idx: 63,
      version: "7",
      when: 1791572108139,
      tag: "0064_ilert_canary_alert_key",
      breakpoints: true,
    });
  });
});

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
      .filter((file) => file.endsWith(".sql") && file < "0064_")
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

    // A row written before the migration stands in for existing production data.
    await insertAlertEvent(client, PRE_MIGRATION_EVENT_ID);

    migrationSource = await readFile(
      join(migrationsDirectory, "0064_ilert_canary_alert_key.sql"),
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

  test("adds the alert key check without validating existing rows", async () => {
    expect(migrationSource).toContain(
      'ADD CONSTRAINT "ilert_alert_events_alert_key_check" CHECK',
    );
    expect(migrationSource.trimEnd().endsWith(" NOT VALID;")).toBe(true);
    expect(migrationSource).not.toContain("VALIDATE CONSTRAINT");

    const constraint = await client!.query<{
      definition: string;
      type: string;
      validated: boolean;
    }>(
      `SELECT pg_get_constraintdef(oid) AS definition,
              contype::text AS type,
              convalidated AS validated
         FROM pg_constraint
        WHERE conrelid = 'public.ilert_alert_events'::regclass
          AND conname = 'ilert_alert_events_alert_key_check'`,
    );
    expect(constraint.rows).toEqual([
      {
        definition: expect.stringMatching(/^CHECK \(.*alert_key.*\) NOT VALID$/),
        type: "c",
        validated: false,
      },
    ]);
    const existing = await client!.query<{ alert_key: string | null }>(
      "SELECT alert_key FROM ilert_alert_events WHERE event_id = $1",
      [PRE_MIGRATION_EVENT_ID],
    );
    expect(existing.rows).toEqual([{ alert_key: null }]);
  });

  test("enforces the alert key check on every new and updated row", async () => {
    const boundaryKey = "k".repeat(512);
    // The deployed release writes rows without naming the new column.
    await insertAlertEvent(client!, "00000000-0000-4000-8000-000000000002");
    await insertAlertEvent(client!, "00000000-0000-4000-8000-000000000003", null);
    await insertAlertEvent(client!, "00000000-0000-4000-8000-000000000004", "k");
    await insertAlertEvent(client!, "00000000-0000-4000-8000-000000000005", boundaryKey);

    for (const [eventId, invalid] of [
      ["00000000-0000-4000-8000-000000000006", ""],
      ["00000000-0000-4000-8000-000000000007", `${boundaryKey}k`],
    ] as const) {
      await expect(insertAlertEvent(client!, eventId, invalid)).rejects.toMatchObject({
        code: "23514",
        constraint: "ilert_alert_events_alert_key_check",
      });
      await expect(client!.query(
        "UPDATE ilert_alert_events SET alert_key = $2 WHERE event_id = $1",
        [PRE_MIGRATION_EVENT_ID, invalid],
      )).rejects.toMatchObject({
        code: "23514",
        constraint: "ilert_alert_events_alert_key_check",
      });
    }

    const stored = await client!.query<{ event_id: string; key_length: number | null }>(
      `SELECT event_id::text, length(alert_key) AS key_length
         FROM ilert_alert_events
        ORDER BY event_id`,
    );
    expect(stored.rows).toEqual([
      { event_id: PRE_MIGRATION_EVENT_ID, key_length: null },
      { event_id: "00000000-0000-4000-8000-000000000002", key_length: null },
      { event_id: "00000000-0000-4000-8000-000000000003", key_length: null },
      { event_id: "00000000-0000-4000-8000-000000000004", key_length: 1 },
      { event_id: "00000000-0000-4000-8000-000000000005", key_length: 512 },
    ]);
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

  test("leaves a valid index with an unexpected definition in place and fails closed", async () => {
    // A unique index under the repairable name still enforces an invariant.
    const canaryIndex = "ilert_alert_events_canary_observation_idx";
    await client!.query(`DROP INDEX "${canaryIndex}"`);
    await client!.query(
      `CREATE UNIQUE INDEX "${canaryIndex}" ON "ilert_alert_events" ("event_id")`,
    );
    const uniqueCanary = await indexIdentity(client!, canaryIndex);
    expect(uniqueCanary).toMatchObject({ unique: true, valid: true });
    await expect(ensureOperationalIndexes(pool!)).rejects.toThrow(
      `operational index ${canaryIndex} has an unexpected definition`,
    );
    expect(await indexIdentity(client!, canaryIndex)).toEqual(uniqueCanary);

    await client!.query(`DROP INDEX "${canaryIndex}"`);
    expect(await ensureOperationalIndexes(pool!)).toEqual(firstReconciliation);

    // Indexes that predate the canary lookup never opt in to repair, whether
    // or not the drifted index is unique.
    for (const [name, drifted] of [
      [
        "finding_approvals_github_delivery_idx",
        'CREATE UNIQUE INDEX "finding_approvals_github_delivery_idx" ON "finding_approvals" ("id")',
      ],
      [
        "reviews_running_started_at_idx",
        'CREATE INDEX "reviews_running_started_at_idx" ON "reviews" ("id")',
      ],
    ] as const) {
      const expected = (await client!.query<{ definition: string }>(
        "SELECT pg_get_indexdef(to_regclass($1)) AS definition",
        [`public.${name}`],
      )).rows[0]!.definition;
      await client!.query(`DROP INDEX "${name}"`);
      await client!.query(drifted);
      const before = await indexIdentity(client!, name);
      expect(before?.valid).toBe(true);
      await expect(ensureOperationalIndexes(pool!)).rejects.toThrow(
        `operational index ${name} has an unexpected definition`,
      );
      expect(await indexIdentity(client!, name)).toEqual(before);
      await client!.query(`DROP INDEX "${name}"`);
      await client!.query(expected);
    }
    expect(await ensureOperationalIndexes(pool!)).toEqual(firstReconciliation);
  }, 60_000);

  test("builds only the canary index on the managed release path", async () => {
    const canaryIndex = "ilert_alert_events_canary_observation_idx";
    const unrelated = "reviews_running_started_at_idx";
    const expected = (await client!.query<{ definition: string }>(
      "SELECT pg_get_indexdef(to_regclass($1)) AS definition",
      [`public.${unrelated}`],
    )).rows[0]!.definition;
    const releaseStep = async () => (await client!.query<{ completed_at: Date; details: unknown }>(
      "SELECT completed_at, details FROM release_steps WHERE name = 'operational-indexes-v6'",
    )).rows;
    const stepBefore = await releaseStep();
    expect(stepBefore).toHaveLength(1);

    // The managed path neither inspects nor repairs an unrelated index.
    await client!.query(`DROP INDEX "${unrelated}"`);
    await client!.query(`CREATE INDEX "${unrelated}" ON "reviews" ("id")`);
    const driftedUnrelated = await indexIdentity(client!, unrelated);
    await client!.query(`DROP INDEX "${canaryIndex}"`);

    expect(MANAGED_RELEASE_OPERATIONAL_INDEXES).toEqual([canaryIndex]);
    expect(await ensureOperationalIndexes(pool!, { managedRelease: true })).toEqual([
      canaryIndex,
    ]);
    expect(await indexIdentity(client!, canaryIndex)).toMatchObject({
      unique: false,
      valid: true,
    });
    expect(await indexIdentity(client!, unrelated)).toEqual(driftedUnrelated);
    expect(await releaseStep()).toEqual(stepBefore);
    expect((await client!.query<{ statement_timeout: string }>(
      "SELECT current_setting('statement_timeout') AS statement_timeout",
    )).rows[0]?.statement_timeout).toBe("0");
    const pooled = await pool!.query<{ statement_timeout: string }>(
      "SELECT current_setting('statement_timeout') AS statement_timeout",
    );
    expect(pooled.rows[0]?.statement_timeout).toBe("0");
    // A second managed run verifies the built index without rebuilding it.
    const built = await indexIdentity(client!, canaryIndex);
    await ensureOperationalIndexes(pool!, { managedRelease: true });
    expect(await indexIdentity(client!, canaryIndex)).toEqual(built);

    await client!.query(`DROP INDEX "${unrelated}"`);
    await client!.query(expected);
    expect(await ensureOperationalIndexes(pool!)).toEqual(firstReconciliation);
  }, 60_000);
});

const PRE_MIGRATION_EVENT_ID = "00000000-0000-4000-8000-000000000001";

/** Insert one event, naming the alert key column only when a key is supplied. */
async function insertAlertEvent(
  client: Client,
  eventId: string,
  alertKey?: string | null,
): Promise<void> {
  const keyed = alertKey !== undefined;
  await client.query(
    `INSERT INTO ilert_alert_events
       (event_id, alert_id, event_type, status, priority, summary, details,
        alert_source_id, alert_source_name, report_time, occurred_at,
        payload_sha256${keyed ? ", alert_key" : ""})
     VALUES ($1, '20000001', 'alert-created', 'PENDING', 'HIGH', 'Fixture alert',
             '', 2269078, 'Postil production', now(), now(), repeat('a', 64)${keyed ? ", $2" : ""})`,
    keyed ? [eventId, alertKey] : [eventId],
  );
}

async function indexIdentity(
  client: Client,
  name: string,
): Promise<{ oid: string; unique: boolean; valid: boolean } | null> {
  const result = await client.query<{ oid: string; unique: boolean; valid: boolean }>(
    `SELECT indexrelid::text AS oid, indisunique AS unique, indisvalid AS valid
       FROM pg_index
      WHERE indexrelid = to_regclass($1)`,
    [`public.${name}`],
  );
  return result.rows[0] ?? null;
}

async function applyMigration(client: Client, path: string): Promise<void> {
  const sql = await readFile(path, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}
