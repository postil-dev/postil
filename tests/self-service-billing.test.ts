import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { EventEntity, Paddle } from "@paddle/paddle-node-sdk";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/lib/db/schema";
import {
  applyPaddleWebhookEvent,
  createPaddleCheckout,
  runBillingSettlement,
  scheduleBillingSettlementJobs,
} from "@/lib/paddle-billing";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const PRICE_ID = `pri_${"a".repeat(26)}`;
const ZERO_PRICE_ID = `pri_${"b".repeat(26)}`;

describeDb("self-service billing", () => {
  const pool = new Pool({ connectionString: TEST_URL, max: 4 });
  const db = drizzle(pool, { schema });
  let orgId = 0;
  let userId = 0;
  let checkoutId = "";

  beforeAll(async () => {
    process.env.PADDLE_ACTIVE_AUTHOR_PRICE_ID = PRICE_ID;
    process.env.PADDLE_ZERO_BASE_PRICE_ID = ZERO_PRICE_ID;
    process.env.PADDLE_CLIENT_TOKEN = "test_client_token";
    process.env.PADDLE_ENVIRONMENT = "sandbox";
    process.env.POSTIL_PADDLE_BILLING_ENABLED = "1";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.POSTIL_OPERATOR_ALERT_EMAIL = "operator@example.com";
    await pool.query(
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public",
    );
    const migrationDirectory = join(import.meta.dir, "..", "drizzle");
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const migration of migrations) {
      const source = await readFile(
        join(migrationDirectory, migration),
        "utf8",
      );
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await pool.query(statement);
      }
    }

    const user = await pool.query<{ id: string }>(
      "INSERT INTO users (github_id, login) VALUES (100, 'owner') RETURNING id",
    );
    userId = Number(user.rows[0]!.id);
    const organization = await pool.query<{ id: string }>(
      "INSERT INTO organizations (slug, name, github_org_id) VALUES ('customer', 'Customer', 200) RETURNING id",
    );
    orgId = Number(organization.rows[0]!.id);
    const checkout = await pool.query<{ id: string }>(
      `INSERT INTO billing_checkout_transactions
         (org_id, requested_by_user_id, status, expires_at)
       VALUES ($1, $2, 'pending', '2026-08-01T00:00:00Z')
       RETURNING id`,
      [orgId, userId],
    );
    checkoutId = checkout.rows[0]!.id;
    await pool.query(
      `INSERT INTO organization_entitlements
         (org_id, subscription_mode, status, trial_ends_at, updated_by)
       VALUES ($1, 'byok', 'trialing', '2026-07-15T00:00:00Z', 'test')`,
      [orgId],
    );
  });

  afterAll(async () => {
    delete process.env.PADDLE_ACTIVE_AUTHOR_PRICE_ID;
    delete process.env.PADDLE_ZERO_BASE_PRICE_ID;
    delete process.env.PADDLE_CLIENT_TOKEN;
    delete process.env.PADDLE_ENVIRONMENT;
    delete process.env.POSTIL_PADDLE_BILLING_ENABLED;
    delete process.env.POSTIL_PUBLIC_URL;
    delete process.env.POSTIL_OPERATOR_ALERT_EMAIL;
    await pool.end();
  });

  test("projects a verified subscription event once and rejects stale state", async () => {
    const created = subscriptionEvent({
      eventId: "evt_created",
      eventType: "subscription.created",
      occurredAt: "2026-07-18T00:00:00Z",
      status: "active",
      periodStartsAt: "2026-07-18T00:00:00Z",
      periodEndsAt: "2026-08-18T00:00:00Z",
      checkoutId,
    });
    expect(await applyPaddleWebhookEvent(db, created)).toEqual({
      duplicate: false,
      outcome: "applied",
    });
    expect(await applyPaddleWebhookEvent(db, created)).toEqual({
      duplicate: true,
      outcome: "ignored",
    });

    const projection = await pool.query<{
      status: string;
      entitlement_status: string;
      checkout_status: string;
    }>(
      `SELECT subscription.status,
              entitlement.status AS entitlement_status,
              checkout.status AS checkout_status
       FROM billing_provider_subscriptions AS subscription
       JOIN organization_entitlements AS entitlement USING (org_id)
       JOIN billing_checkout_transactions AS checkout USING (org_id)
       WHERE subscription.org_id = $1`,
      [orgId],
    );
    expect(projection.rows[0]).toEqual({
      status: "active",
      entitlement_status: "active",
      checkout_status: "completed",
    });

    const stale = subscriptionEvent({
      eventId: "evt_stale",
      eventType: "subscription.canceled",
      occurredAt: "2026-07-17T23:59:59Z",
      status: "canceled",
      periodStartsAt: "2026-07-18T00:00:00Z",
      periodEndsAt: "2026-08-18T00:00:00Z",
      checkoutId,
    });
    expect(await applyPaddleWebhookEvent(db, stale)).toEqual({
      duplicate: false,
      outcome: "stale",
    });

    const tied = subscriptionEvent({
      eventId: "evt_tied",
      eventType: "subscription.canceled",
      occurredAt: "2026-07-18T00:00:00Z",
      status: "canceled",
      periodStartsAt: "2026-07-18T00:00:00Z",
      periodEndsAt: "2026-08-18T00:00:00Z",
      checkoutId,
    });
    const currentProviderState = {
      subscriptions: {
        get: async () => ({
          id: "sub_test",
          customerId: "ctm_test",
          status: "active",
          currentBillingPeriod: {
            startsAt: "2026-07-18T00:00:00Z",
            endsAt: "2026-08-18T00:00:00Z",
          },
        }),
      },
    } as unknown as Paddle;
    expect(
      await applyPaddleWebhookEvent(
        db,
        tied,
        new Date("2026-07-18T00:00:03Z"),
        currentProviderState,
      ),
    ).toEqual({ duplicate: false, outcome: "applied" });
    const tiedProjection = await pool.query<{ status: string }>(
      "SELECT status FROM billing_provider_subscriptions WHERE org_id = $1",
      [orgId],
    );
    expect(tiedProjection.rows[0]!.status).toBe("active");
  });

  test("claims concurrent webhook replays before applying side effects", async () => {
    const event = subscriptionEvent({
      eventId: "evt_concurrent",
      eventType: "subscription.updated",
      occurredAt: "2026-07-18T00:00:01Z",
      status: "active",
      periodStartsAt: "2026-07-18T00:00:00Z",
      periodEndsAt: "2026-08-18T00:00:00Z",
      checkoutId,
    });
    const results = await Promise.all([
      applyPaddleWebhookEvent(db, event),
      applyPaddleWebhookEvent(db, event),
    ]);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
  });

  test("records and alerts on an unmatched verified subscription event", async () => {
    const event = subscriptionEvent({
      eventId: "evt_unmatched",
      eventType: "subscription.created",
      occurredAt: "2026-07-18T00:00:02Z",
      status: "active",
      periodStartsAt: "2026-07-18T00:00:00Z",
      periodEndsAt: "2026-08-18T00:00:00Z",
      checkoutId: "00000000-0000-4000-8000-000000000000",
      subscriptionId: "sub_unmatched",
    });
    expect(await applyPaddleWebhookEvent(db, event)).toEqual({
      duplicate: false,
      outcome: "unmatched",
    });
    const alert = await pool.query<{
      org_id: string | null;
      event: string;
      job_org_id: string | null;
    }>(
      `SELECT delivery.org_id, delivery.event,
              job.payload ->> 'orgId' AS job_org_id
       FROM operator_alert_deliveries AS delivery
       JOIN jobs AS job
         ON job.kind = 'operator-alert'
        AND job.payload ->> 'eventKey' = delivery.event_key
       WHERE delivery.event_key = $1`,
      ["billing-anomaly:evt_unmatched:unmatched-provider-event"],
    );
    expect(alert.rows[0]).toEqual({
      org_id: null,
      event: "billing_anomaly",
      job_org_id: null,
    });
  });

  test("recovers an ambiguous checkout without creating a second provider transaction", async () => {
    const account = await createCheckoutAccount(pool, "ambiguous", 610, 611);
    let createCalls = 0;
    let providerTransactions: Array<Record<string, unknown>> = [];
    const client = checkoutPaddleClient({
      create: async () => {
        createCalls += 1;
        throw new Error("provider timeout");
      },
      list: () => providerTransactions,
    });
    const input = {
      orgId: account.orgId,
      orgSlug: "ambiguous",
      requestedByUserId: account.userId,
      now: new Date("2026-07-18T03:00:00Z"),
    };
    await expect(createPaddleCheckout(db, input, client)).rejects.toThrow(
      "Paddle checkout creation failed",
    );
    const local = await pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM billing_checkout_transactions WHERE org_id = $1",
      [account.orgId],
    );
    expect(local.rows[0]!.status).toBe("creating");
    providerTransactions = [checkoutTransaction(local.rows[0]!.id)];

    expect(
      await createPaddleCheckout(
        db,
        { ...input, now: new Date("2026-07-18T03:01:00Z") },
        client,
      ),
    ).toMatchObject({ transactionId: "txn_checkout" });
    expect(createCalls).toBe(1);
    const recovered = await pool.query<{ status: string }>(
      "SELECT status FROM billing_checkout_transactions WHERE org_id = $1",
      [account.orgId],
    );
    expect(recovered.rows[0]!.status).toBe("pending");
  });

  test("retries checkout creation only after a provider scan proves no transaction exists", async () => {
    const account = await createCheckoutAccount(pool, "retry", 620, 621);
    let createCalls = 0;
    const client = checkoutPaddleClient({
      create: async () => {
        createCalls += 1;
        if (createCalls === 1) throw new Error("provider timeout");
        return checkoutTransaction("replacement-checkout", "txn_checkout_retry");
      },
      list: () => [],
    });
    const input = {
      orgId: account.orgId,
      orgSlug: "retry",
      requestedByUserId: account.userId,
      now: new Date("2026-07-18T04:00:00Z"),
    };
    await expect(createPaddleCheckout(db, input, client)).rejects.toThrow();
    expect(
      await createPaddleCheckout(
        db,
        { ...input, now: new Date("2026-07-18T04:31:00Z") },
        client,
      ),
    ).toMatchObject({ transactionId: "txn_checkout_retry" });
    expect(createCalls).toBe(2);
    const attempts = await pool.query<{ status: string }>(
      "SELECT status FROM billing_checkout_transactions WHERE org_id = $1 ORDER BY created_at",
      [account.orgId],
    );
    expect(attempts.rows.map((row) => row.status)).toEqual([
      "failed",
      "pending",
    ]);
  });

  test("closes a period with one immutable count and one settlement job", async () => {
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, org_id, account_login, account_type)
       VALUES (300, $1, 'customer', 'Organization') RETURNING id`,
      [orgId],
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories
         (installation_id, github_repo_id, full_name, private)
       VALUES ($1, 400, 'customer/private', true) RETURNING id`,
      [installation.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO reviews
         (repository_id, pr_number, author_github_id, head_sha, base_sha, queued_at)
       VALUES
         ($1, 1, 501, 'head-1', 'base', '2026-07-20T00:00:00Z'),
         ($1, 2, 501, 'head-2', 'base', '2026-07-21T00:00:00Z'),
         ($1, 3, 502, 'head-3', 'base', '2026-07-22T00:00:00Z')`,
      [repository.rows[0]!.id],
    );

    const renewed = subscriptionEvent({
      eventId: "evt_renewed",
      eventType: "subscription.updated",
      occurredAt: "2026-08-18T00:00:01Z",
      status: "active",
      periodStartsAt: "2026-08-18T00:00:00Z",
      periodEndsAt: "2026-09-18T00:00:00Z",
      checkoutId,
    });
    expect(await applyPaddleWebhookEvent(db, renewed)).toMatchObject({
      outcome: "applied",
    });
    expect(await applyPaddleWebhookEvent(db, renewed)).toMatchObject({
      duplicate: true,
    });

    const settlement = await pool.query<{
      id: string;
      active_author_count: number;
      total_amount_cents: number;
      status: string;
    }>(
      `SELECT id, active_author_count, total_amount_cents, status
       FROM billing_author_settlements
       WHERE org_id = $1`,
      [orgId],
    );
    expect(settlement.rows).toHaveLength(1);
    expect(settlement.rows[0]).toMatchObject({
      active_author_count: 2,
      total_amount_cents: 1_200,
      status: "pending",
    });
    const jobs = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs
       WHERE kind = 'billing-settlement'
         AND payload ->> 'settlementId' = $1`,
      [settlement.rows[0]!.id],
    );
    expect(jobs.rows[0]!.count).toBe(1);
  });

  test("charges once and reconciles by exact provider transaction", async () => {
    const settlement = await pool.query<{ id: string }>(
      "SELECT id FROM billing_author_settlements WHERE org_id = $1",
      [orgId],
    );
    let chargeCalls = 0;
    const client = fakePaddleClient({
      onCharge: () => {
        chargeCalls += 1;
      },
      transactions: [
        {
          id: "txn_charge",
          status: "completed",
          customData: {
            postil_billing_contract: "1",
            postil_settlement_id: settlement.rows[0]!.id,
          },
          items: [{ price: { id: PRICE_ID }, quantity: 2 }],
        },
      ],
    });
    const payload = { settlementId: settlement.rows[0]!.id };
    expect(
      await runBillingSettlement(
        db,
        payload,
        new Date("2026-08-18T00:01:00Z"),
        client,
      ),
    ).toBe("charged");
    expect(chargeCalls).toBe(1);
    expect(
      await runBillingSettlement(
        db,
        payload,
        new Date("2026-08-18T00:02:00Z"),
        client,
      ),
    ).toBe("noop");
    expect(chargeCalls).toBe(1);
  });

  test("never retries an ambiguous provider call", async () => {
    const settlement = await pool.query<{ id: string }>(
      `INSERT INTO billing_author_settlements
         (org_id, provider_subscription_id, period_starts_at, period_ends_at,
          active_author_count, total_amount_cents)
       VALUES ($1, 'sub_test', '2026-06-18T00:00:00Z', '2026-07-18T00:00:00Z', 1, 600)
       RETURNING id`,
      [orgId],
    );
    let chargeCalls = 0;
    const client = fakePaddleClient({
      onCharge: () => {
        chargeCalls += 1;
        throw new Error("provider timeout");
      },
      transactions: [],
    });
    const payload = { settlementId: settlement.rows[0]!.id };
    expect(
      await runBillingSettlement(
        db,
        payload,
        new Date("2026-07-18T00:01:00Z"),
        client,
      ),
    ).toBe("reconciling");
    expect(
      await runBillingSettlement(
        db,
        payload,
        new Date("2026-07-18T01:02:00Z"),
        client,
      ),
    ).toBe("failed");
    expect(chargeCalls).toBe(1);
  });

  test("recovers due settlement jobs without duplicate queue entries", async () => {
    process.env.POSTIL_PADDLE_BILLING_ENABLED = "1";
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO billing_author_settlements
         (org_id, provider_subscription_id, period_starts_at, period_ends_at,
          active_author_count, total_amount_cents)
       VALUES ($1, 'sub_test', '2026-05-18T00:00:00Z', '2026-06-18T00:00:00Z', 1, 600)
       RETURNING id`,
      [orgId],
    );
    expect(
      await scheduleBillingSettlementJobs(db, new Date("2026-07-18T02:00:00Z")),
    ).toBe(1);
    expect(
      await scheduleBillingSettlementJobs(db, new Date("2026-07-18T02:00:01Z")),
    ).toBe(0);
    const jobs = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs
       WHERE kind = 'billing-settlement'
         AND payload ->> 'settlementId' = $1
         AND status IN ('queued', 'running')`,
      [inserted.rows[0]!.id],
    );
    expect(jobs.rows[0]!.count).toBe(1);
    delete process.env.POSTIL_PADDLE_BILLING_ENABLED;
  });

  test("retains financial settlements when organization deletion is attempted", async () => {
    const account = await createCheckoutAccount(pool, "retained-ledger", 303, 403);
    const settlement = await pool.query<{ id: string }>(
      `INSERT INTO billing_author_settlements
         (org_id, provider_subscription_id, period_starts_at, period_ends_at,
          active_author_count, total_amount_cents, status)
       VALUES ($1, 'sub_retained', '2026-06-18T00:00:00Z', '2026-07-18T00:00:00Z', 1, 600, 'charged')
       RETURNING id`,
      [account.orgId],
    );

    await expect(
      pool.query("DELETE FROM organizations WHERE id = $1", [account.orgId]),
    ).rejects.toThrow(/foreign key constraint/);
    const retained = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM billing_author_settlements WHERE id = $1",
      [settlement.rows[0]!.id],
    );
    expect(retained.rows[0]!.count).toBe(1);
  });
});

function subscriptionEvent(input: {
  eventId: string;
  eventType:
    "subscription.created" | "subscription.updated" | "subscription.canceled";
  occurredAt: string;
  status: "active" | "canceled";
  periodStartsAt: string;
  periodEndsAt: string;
  checkoutId: string;
  subscriptionId?: string;
}): EventEntity {
  return {
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    notificationId: `ntf_${input.eventId}`,
    data: {
      id: input.subscriptionId ?? "sub_test",
      customerId: "ctm_test",
      status: input.status,
      customData: {
        postil_checkout_id: input.checkoutId,
        postil_billing_contract: "1",
      },
      currentBillingPeriod: {
        startsAt: input.periodStartsAt,
        endsAt: input.periodEndsAt,
      },
    },
  } as unknown as EventEntity;
}

async function createCheckoutAccount(
  pool: Pool,
  slug: string,
  githubUserId: number,
  githubOrgId: number,
): Promise<{ orgId: number; userId: number }> {
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users (github_id, login) VALUES ($1, $2) RETURNING id",
    [githubUserId, `${slug}-owner`],
  );
  const organization = await pool.query<{ id: string }>(
    "INSERT INTO organizations (slug, name, github_org_id) VALUES ($1, $2, $3) RETURNING id",
    [slug, slug, githubOrgId],
  );
  await pool.query(
    `INSERT INTO organization_entitlements
       (org_id, subscription_mode, status, trial_ends_at, updated_by)
     VALUES ($1, 'byok', 'trialing', '2026-08-17T00:00:00Z', 'test')`,
    [organization.rows[0]!.id],
  );
  return {
    orgId: Number(organization.rows[0]!.id),
    userId: Number(user.rows[0]!.id),
  };
}

function checkoutPaddleClient(input: {
  create: () => Promise<Record<string, unknown>>;
  list: () => Array<Record<string, unknown>>;
}): Paddle {
  return {
    transactions: {
      create: input.create,
      list: () => ({
        async *[Symbol.asyncIterator]() {
          yield* input.list();
        },
      }),
    },
  } as unknown as Paddle;
}

function checkoutTransaction(
  checkoutId: string,
  transactionId = "txn_checkout",
): Record<string, unknown> {
  return {
    id: transactionId,
    status: "draft",
    origin: "api",
    customData: {
      postil_checkout_id: checkoutId,
      postil_billing_contract: "1",
    },
    items: [{ price: { id: ZERO_PRICE_ID }, quantity: 1 }],
    checkout: { url: `https://checkout.paddle.test/${transactionId}` },
  };
}

function fakePaddleClient(input: {
  onCharge: () => void;
  transactions: Array<{
    id: string;
    status: string;
    customData?: Record<string, unknown>;
    items: Array<{ price: { id: string }; quantity: number }>;
  }>;
}): Paddle {
  return {
    subscriptions: {
      update: async () => ({}),
      createOneTimeCharge: async () => {
        input.onCharge();
        return {};
      },
    },
    transactions: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          yield* input.transactions;
        },
      }),
    },
  } as unknown as Paddle;
}
