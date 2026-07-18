import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

describeDb("operator alert delivery migration", () => {
  const pool = new Pool({ connectionString: TEST_URL, max: 2 });

  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql") && file < "0031_")
      .sort();
    for (const migration of migrations) {
      const source = await readFile(join(migrationDirectory, migration), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }

    const organization = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name, github_org_id) VALUES ('legacy', 'Legacy', 700) RETURNING id",
    );
    await pool.query(
      `INSERT INTO jobs (kind, payload, status, created_at)
       VALUES
         ('operator-alert', $1::jsonb, 'done', '2026-07-18T12:00:00Z'),
         ('operator-alert', $2::jsonb, 'queued', '2026-07-18T12:01:00Z'),
         ('operator-alert', $3::jsonb, 'failed', '2026-07-18T12:02:00Z'),
         ('operator-alert', $4::jsonb, 'running', '2026-07-18T12:03:00Z')`,
      [
        JSON.stringify({
          event: "trial_started",
          orgId: Number(organization.rows[0]!.id),
          orgSlug: "legacy",
          accountLogin: "Legacy",
          accountType: "Organization",
          githubOwnerId: 700,
          githubInstallationId: 701,
          trialEndsAt: "2026-08-17T12:00:00.000Z",
        }),
        JSON.stringify({
          event: "trial_started",
          orgId: 999_999,
          orgSlug: "removed",
          accountLogin: "Removed",
          accountType: "Organization",
          githubOwnerId: 800,
          githubInstallationId: 801,
          trialEndsAt: "2026-08-17T12:00:00.000Z",
        }),
        JSON.stringify({
          event: "trial_expired",
          eventKey: `trial-expired:${organization.rows[0]!.id}:2026-08-17T12:00:00.000Z`,
          orgId: Number(organization.rows[0]!.id),
          orgSlug: "legacy",
          accountLogin: "Legacy",
          githubOwnerId: 700,
          trialEndsAt: "2026-08-17T12:00:00.000Z",
        }),
        JSON.stringify({
          event: "installation_removed",
          eventKey: "installation-removed:701",
          orgId: Number(organization.rows[0]!.id),
          orgSlug: "legacy",
          accountLogin: "Legacy",
          accountType: "Organization",
          githubOwnerId: 700,
          githubInstallationId: 701,
        }),
      ],
    );

    const migration = await readFile(
      join(migrationDirectory, "0031_operator_alert_delivery_audit.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  test("backfills a stable event key and delivered audit without orphan failure", async () => {
    const legacyOrg = await pool.query<{ id: string }>(
      "SELECT id FROM organizations WHERE slug = 'legacy'",
    );
    const jobs = await pool.query<{ event_key: string }>(
      `SELECT payload ->> 'eventKey' AS event_key
       FROM jobs
       ORDER BY id`,
    );
    expect(jobs.rows).toEqual([
      { event_key: "trial-started:700" },
      { event_key: "trial-started:800" },
      {
        event_key: `trial-expired:${legacyOrg.rows[0]!.id}:2026-08-17T12:00:00.000Z`,
      },
      { event_key: "installation-removed:701" },
    ]);

    const deliveries = await pool.query<{
      event_key: string;
      status: string;
      delivered_at: Date | null;
    }>(
      `SELECT event_key, status, delivered_at
       FROM operator_alert_deliveries
       ORDER BY event_key`,
    );
    expect(deliveries).toMatchObject({
      rows: expect.arrayContaining([
        {
          event_key: "trial-started:700",
          status: "delivered",
          delivered_at: new Date("2026-07-18T12:00:00.000Z"),
        },
        {
          event_key: "trial-started:800",
          status: "queued",
          delivered_at: null,
        },
        {
          event_key: expect.stringMatching(/^trial-expired:/),
          status: "failed",
          delivered_at: null,
        },
        {
          event_key: "installation-removed:701",
          status: "retrying",
          delivered_at: null,
        },
      ]),
    });
  });
});
