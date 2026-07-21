import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  CUSTOMER_EMAIL_SUMMARY_DELAY_MS,
  recordCustomerNotificationEmailFailure,
  runCustomerNotificationEmailJob,
  scheduleCustomerNotificationEmailJobs,
} from "@/lib/customer-notification-email";
import * as schema from "@/lib/db/schema";
import { renderTransactionalEmail } from "@/lib/transactional-email";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const NOW = new Date("2026-07-21T12:00:00.000Z");

describeDb("customer notification email delivery", () => {
  const pool = new Pool({ connectionString: TEST_URL, max: 6 });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const migration of migrations) {
      const source = await readFile(join(migrationDirectory, migration), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }
  }, 30_000);

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE customer_notification_email_delivery_events, customer_notification_email_deliveries, customer_notification_events, jobs, organization_notification_preferences, organization_entitlements, organizations RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  test("queues mandatory events immediately and delays one optional billing batch", async () => {
    const orgId = await seedOrganization(pool, "acme");
    await Promise.all([
      seedEvent(pool, orgId, "installation-suspended:11:delivery", "security", "GitHub App access is suspended", "Reviews are paused.", NOW),
      seedEvent(pool, orgId, "subscription-past-due:sub:event", "billing", "Payment needs attention", "Update billing details.", NOW),
      seedEvent(pool, orgId, "trial-expired:1:date", "trial", "Your trial has ended", "Choose a plan.", NOW),
      seedEvent(pool, orgId, "service-disruption:worker:date", "service", "Hosted reviews are delayed", "Queued reviews may take longer.", NOW),
      seedEvent(pool, orgId, "subscription-restored:sub:event", "billing", "Your subscription is active", "Reviews are available.", NOW),
      seedEvent(pool, orgId, "trial-started:1", "trial", "Your trial is active", "Reviews are available.", NOW),
    ]);

    const [first, concurrent] = await Promise.all([
      scheduleCustomerNotificationEmailJobs(db, NOW),
      scheduleCustomerNotificationEmailJobs(db, NOW),
    ]);
    expect(first.events + concurrent.events).toBe(4);
    expect(first.queued + concurrent.queued).toBe(4);
    expect(await deliveryCategories(pool)).toEqual([
      "payment_failure",
      "security",
      "service_incident",
      "trial_expiry",
    ]);
    expect((await pool.query("SELECT 1 FROM jobs WHERE kind = 'customer-notification-email'")).rowCount)
      .toBe(4);

    const afterDelay = new Date(
      NOW.getTime() + CUSTOMER_EMAIL_SUMMARY_DELAY_MS + 1,
    );
    expect(await scheduleCustomerNotificationEmailJobs(db, afterDelay)).toEqual({
      queued: 1,
      suppressed: 0,
      events: 1,
    });
    expect(await deliveryCategories(pool)).toEqual([
      "billing_summary",
      "payment_failure",
      "security",
      "service_incident",
      "trial_expiry",
    ]);
    const unassigned = await pool.query<{ idempotency_key: string }>(
      `SELECT event.idempotency_key
         FROM customer_notification_events event
         LEFT JOIN customer_notification_email_delivery_events assigned
           ON assigned.event_id = event.id
        WHERE assigned.event_id IS NULL
        ORDER BY event.idempotency_key`,
    );
    expect(unassigned.rows).toEqual([
      { idempotency_key: "trial-started:1" },
    ]);
  });

  test("suppresses disabled summaries and every event without a verified contact", async () => {
    const orgId = await seedOrganization(pool, "disabled", {
      billingSummaryEmail: false,
    });
    await seedEvent(
      pool,
      orgId,
      "subscription-canceled:sub:event",
      "billing",
      "Your subscription has ended",
      "Reviews are paused.",
      new Date(NOW.getTime() - CUSTOMER_EMAIL_SUMMARY_DELAY_MS),
    );
    const noContactOrgId = await seedOrganization(pool, "no-contact", {
      verifiedContact: false,
    });
    await seedEvent(
      pool,
      noContactOrgId,
      "service-recovery:worker:date",
      "service",
      "Hosted reviews are running normally",
      "Queued reviews can start normally.",
      NOW,
    );

    expect(await scheduleCustomerNotificationEmailJobs(db, NOW)).toEqual({
      queued: 0,
      suppressed: 2,
      events: 2,
    });
    const deliveries = await pool.query<{ email_category: string; status: string; last_error: string }>(
      `SELECT email_category, status, last_error
         FROM customer_notification_email_deliveries
        ORDER BY email_category`,
    );
    expect(deliveries.rows).toEqual([
      {
        email_category: "billing_summary",
        status: "suppressed",
        last_error: "email preference disabled",
      },
      {
        email_category: "service_incident",
        status: "suppressed",
        last_error: "verified billing contact unavailable",
      },
    ]);
    expect((await pool.query("SELECT 1 FROM jobs")).rowCount).toBe(0);
  });

  test("delivers through the verified contact with one stable logical key", async () => {
    const orgId = await seedOrganization(pool, "delivery");
    await seedEvent(
      pool,
      orgId,
      "service-disruption:public-site:date",
      "service",
      "Postil is temporarily unavailable",
      "The dashboard may be temporarily unavailable.",
      NOW,
    );
    expect(await scheduleCustomerNotificationEmailJobs(db, NOW)).toMatchObject({
      queued: 1,
    });
    const job = await pool.query<{ payload: { deliveryId: string } }>(
      "SELECT payload FROM jobs WHERE kind = 'customer-notification-email'",
    );
    const sent: Array<Record<string, unknown>> = [];
    const options = {
      publicOrigin: "https://postil.dev",
      apiKey: "test-api-key",
      now: NOW,
      send: async (input: Record<string, unknown>) => {
        sent.push(input);
        return { messageId: "customer-message-1" };
      },
    };

    expect(
      await runCustomerNotificationEmailJob(db, job.rows[0]!.payload, options),
    ).toBe("delivered");
    expect(
      await runCustomerNotificationEmailJob(db, job.rows[0]!.payload, options),
    ).toBe("noop");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      recipient: "billing@delivery.example",
      subject: "Postil service update for delivery",
      idempotencyKey: `postil-customer-email-${job.rows[0]!.payload.deliveryId}`,
    });
    const rendered = renderTransactionalEmail(
      sent[0]!.content as Parameters<typeof renderTransactionalEmail>[0],
    );
    expect(rendered.text).toContain("Postil is temporarily unavailable");
    expect(rendered.html).not.toMatch(/<(?:img|script|iframe|object|embed)\b/i);
    expect(`${rendered.text}\n${rendered.html}`).not.toMatch(
      /provider|paddle|model|token|cost|stack|exception|operator/i,
    );
    const delivery = await pool.query<{
      status: string;
      message_id: string;
      delivered_at: Date;
    }>("SELECT status, message_id, delivered_at FROM customer_notification_email_deliveries");
    expect(delivery.rows[0]).toEqual({
      status: "delivered",
      message_id: "customer-message-1",
      delivered_at: NOW,
    });
  });

  test("rechecks preferences before provider access and preserves suppression", async () => {
    const orgId = await seedOrganization(pool, "recheck");
    await seedEvent(
      pool,
      orgId,
      "subscription-paused:sub:event",
      "billing",
      "Your subscription is paused",
      "Reviews are paused.",
      new Date(NOW.getTime() - CUSTOMER_EMAIL_SUMMARY_DELAY_MS),
    );
    await scheduleCustomerNotificationEmailJobs(db, NOW);
    await pool.query(
      "UPDATE organization_notification_preferences SET billing_summary_email = false WHERE org_id = $1",
      [orgId],
    );
    const job = await pool.query<{ payload: { deliveryId: string } }>(
      "SELECT payload FROM jobs WHERE kind = 'customer-notification-email'",
    );
    let sendCalls = 0;
    expect(
      await runCustomerNotificationEmailJob(db, job.rows[0]!.payload, {
        publicOrigin: "https://postil.dev",
        apiKey: "test-api-key",
        send: async () => {
          sendCalls += 1;
          return { messageId: "unexpected" };
        },
      }),
    ).toBe("suppressed");
    expect(sendCalls).toBe(0);

    await recordCustomerNotificationEmailFailure(
      db,
      job.rows[0]!.payload,
      "x".repeat(3_000),
      true,
      NOW,
    );
    const suppressed = await pool.query<{ status: string; last_error: string }>(
      "SELECT status, last_error FROM customer_notification_email_deliveries",
    );
    expect(suppressed.rows[0]).toEqual({
      status: "suppressed",
      last_error: "email preference disabled",
    });
  });

  test("records a bounded terminal failure for an active delivery", async () => {
    const orgId = await seedOrganization(pool, "failure");
    await seedEvent(
      pool,
      orgId,
      "service-disruption:public-site:failure",
      "service",
      "Postil is temporarily unavailable",
      "The dashboard may be temporarily unavailable.",
      NOW,
    );
    await scheduleCustomerNotificationEmailJobs(db, NOW);
    const job = await pool.query<{ payload: { deliveryId: string } }>(
      "SELECT payload FROM jobs WHERE kind = 'customer-notification-email'",
    );

    await recordCustomerNotificationEmailFailure(
      db,
      job.rows[0]!.payload,
      "x".repeat(3_000),
      true,
      NOW,
    );
    const failed = await pool.query<{ status: string; error_length: number }>(
      "SELECT status, length(last_error)::int AS error_length FROM customer_notification_email_deliveries",
    );
    expect(failed.rows[0]).toEqual({ status: "failed", error_length: 2_000 });
  });
});

async function seedOrganization(
  pool: Pool,
  slug: string,
  options: { verifiedContact?: boolean; billingSummaryEmail?: boolean } = {},
): Promise<number> {
  const organization = await pool.query<{ id: string }>(
    "INSERT INTO organizations (slug, name) VALUES ($1, $1) RETURNING id",
    [slug],
  );
  const orgId = Number(organization.rows[0]!.id);
  await pool.query(
    `INSERT INTO organization_entitlements
       (org_id, subscription_mode, status, billing_contact_email,
        billing_contact_verified_at, updated_by)
     VALUES ($1, 'byok', 'active', $2, $3, 'test')`,
    [
      orgId,
      options.verifiedContact === false ? null : `billing@${slug}.example`,
      options.verifiedContact === false ? null : NOW,
    ],
  );
  await pool.query(
    `INSERT INTO organization_notification_preferences
       (org_id, billing_summary_email, service_summary_email)
     VALUES ($1, $2, true)`,
    [orgId, options.billingSummaryEmail ?? true],
  );
  return orgId;
}

async function seedEvent(
  pool: Pool,
  orgId: number,
  idempotencyKey: string,
  category: "trial" | "billing" | "service" | "security",
  title: string,
  body: string,
  createdAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO customer_notification_events
       (org_id, idempotency_key, severity, category, title, body,
        visibility, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'admins', $7::timestamptz,
             $7::timestamptz + interval '180 days')`,
    [
      orgId,
      idempotencyKey,
      idempotencyKey.includes("recovery") || idempotencyKey.includes("restored")
        ? "info"
        : idempotencyKey.includes("past-due")
          ? "critical"
          : "warning",
      category,
      title,
      body,
      createdAt,
    ],
  );
}

async function deliveryCategories(pool: Pool): Promise<string[]> {
  return (
    await pool.query<{ email_category: string }>(
      "SELECT email_category FROM customer_notification_email_deliveries ORDER BY email_category",
    )
  ).rows.map((row) => row.email_category);
}
