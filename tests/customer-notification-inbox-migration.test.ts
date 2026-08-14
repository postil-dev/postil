import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "pg";

import {
  createUnmigratedEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("customer notification inbox migration", () => {
  let database: EphemeralDatabase;
  let client: Client;

  beforeAll(async () => {
    database = await createUnmigratedEphemeralDatabase("customer_notification_inbox");
    client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query(`
      CREATE TABLE users (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY
      );
      CREATE TABLE organizations (
        id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        slug text NOT NULL UNIQUE,
        name text NOT NULL
      );
    `);
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0040_customer_notification_inbox.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.end();
    await database?.drop();
  });

  test("enforces org idempotency, visibility, safe actions, and cascading reads", async () => {
    const organization = await client.query<{ id: string }>(
      "INSERT INTO organizations (slug, name) VALUES ('acme', 'Acme') RETURNING id",
    );
    const user = await client.query<{ id: string }>(
      "INSERT INTO users DEFAULT VALUES RETURNING id",
    );
    const values = [
      organization.rows[0]!.id,
      "trial-started:70",
      "info",
      "trial",
      "Your 30-day trial is active",
      "Postil can review enabled repositories during your trial.",
      "Open dashboard",
      "/orgs/acme",
      "members",
      new Date("2027-01-16T12:00:00.000Z"),
    ];
    const event = await client.query<{ id: string }>(
      `INSERT INTO customer_notification_events
       (org_id, idempotency_key, severity, category, title, body,
        action_label, action_href, visibility, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      values,
    );
    await expect(client.query(
      `INSERT INTO customer_notification_events
       (org_id, idempotency_key, severity, category, title, body, visibility, expires_at)
       VALUES ($1,$2,'info','trial','Duplicate','Duplicate','members',$3)`,
      [values[0], values[1], values[9]],
    )).rejects.toMatchObject({ code: "23505" });
    await client.query(
      "INSERT INTO customer_notification_reads (event_id, user_id) VALUES ($1, $2)",
      [event.rows[0]!.id, user.rows[0]!.id],
    );
    await client.query("DELETE FROM customer_notification_events WHERE id = $1", [event.rows[0]!.id]);
    const reads = await client.query("SELECT id FROM customer_notification_reads");
    expect(reads.rows).toEqual([]);
  });
});

describe("customer notification migration source", () => {
  test("is additive and assigns the required retention indexes and constraints", async () => {
    const migration = await readFile(
      new URL("../drizzle/0040_customer_notification_inbox.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('CREATE TABLE "customer_notification_events"');
    expect(migration).toContain('CREATE TABLE "customer_notification_reads"');
    expect(migration).toContain('customer_notification_events_org_key_idx');
    expect(migration).toContain('customer_notification_events_expiry_idx');
    expect(migration).toContain('ON DELETE cascade');
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE/);
  });
});
