import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  formatUsdCents,
  formatUsdMicros,
  getOperatorBillingProviderActions,
  getOperatorFinancialSummary,
} from "@/lib/operator-financials";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDatabase = TEST_URL ? describe : describe.skip;

describe("operator financial ledger formatting", () => {
  test("keeps exact sub-cent model spend and cent-denominated settlement amounts distinct", () => {
    expect(formatUsdMicros(1_234_560n)).toBe("$1.23456");
    expect(formatUsdMicros(1_000_000n)).toBe("$1.00");
    expect(formatUsdCents(123_456n)).toBe("$1,234.56");
    expect(formatUsdCents(650n)).toBe("$6.50");
    expect(formatUsdMicros(-500_000n)).toBe("-$0.50");
    expect(formatUsdMicros(-1_234_567n)).toBe("-$1.234567");
  });

  test("exposes only known provider billing actions", () => {
    expect(getOperatorBillingProviderActions({}).model.href).toBe("https://openrouter.ai/activity");
    expect(
      getOperatorBillingProviderActions({
        POSTIL_API_BASE: "https://openrouter.ai/api/v1",
        POSTIL_PADDLE_BILLING_ENABLED: "1",
      }),
    ).toMatchObject({
      runtime: {
        status: "not_connected",
        href: "https://fly.io/dashboard",
      },
      customer: {
        provider: "Paddle",
        status: "connected",
        href: "https://vendors.paddle.com/",
      },
      model: {
        provider: "OpenRouter",
        status: "external",
        href: "https://openrouter.ai/activity",
      },
    });
    expect(
      getOperatorBillingProviderActions({
        POSTIL_API_BASE: "https://models.example/v1",
        POSTIL_PADDLE_BILLING_ENABLED: "0",
      }),
    ).toMatchObject({
      customer: { status: "not_connected", href: null },
      model: { status: "not_connected", href: null },
    });
  });
});

describeDatabase("operator financial ledger SQL", () => {
  let pool: Pool;
  let db: Parameters<typeof getOperatorFinancialSummary>[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 1 });
    db = drizzle(pool);
    await pool.query(`
      CREATE TEMPORARY TABLE usage_events (
        review_id bigint,
        model_used text,
        cost_micros bigint,
        created_at timestamptz NOT NULL
      )
    `);
    await pool.query(`
      CREATE TEMPORARY TABLE billing_author_settlements (
        total_amount_cents integer NOT NULL,
        status text NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  test("uses the bounded period, preserves partial model cost, and labels updated settlement state", async () => {
    await pool.query(`
      INSERT INTO usage_events (review_id, model_used, cost_micros, created_at) VALUES
        (1, 'provider-a/model-a', 2000000, '2026-08-06T12:00:00.000Z'),
        (2, 'provider-b/model-b', 500000, '2026-08-20T12:00:00.000Z'),
        (2, 'provider-b/model-b', NULL, '2026-08-20T12:01:00.000Z'),
        (NULL, NULL, 250000, '2026-08-25T12:00:00.000Z'),
        (3, 'outside/model', 9000000, '2026-09-05T12:00:00.000Z')
    `);
    await pool.query(`
      INSERT INTO billing_author_settlements (total_amount_cents, status, updated_at) VALUES
        (600, 'charged', '2026-08-06T12:00:00.000Z'),
        (600, 'pending', '2026-08-20T12:00:00.000Z'),
        (600, 'failed', '2026-08-21T12:00:00.000Z'),
        (600, 'charged', '2026-09-05T12:00:00.000Z')
    `);

    const summary = await getOperatorFinancialSummary(
      db,
      new Date("2026-09-05T12:00:00.000Z"),
    );

    expect(summary.period).toEqual({
      start: new Date("2026-08-06T12:00:00.000Z"),
      end: new Date("2026-09-05T12:00:00.000Z"),
    });
    expect(summary.modelUsage).toMatchObject({
      events: 4,
      unpricedEvents: 1,
      totalCostMicros: 2_750_000n,
      pricedReviews: 2,
      pricedReviewAverageMicros: 1_250_000n,
      models: [
        {
          model: "provider-a/model-a",
          events: 1,
          unpricedEvents: 0,
          costMicros: 2_000_000n,
        },
        {
          model: "provider-b/model-b",
          events: 2,
          unpricedEvents: 1,
          costMicros: 500_000n,
        },
        {
          model: "Model not recorded",
          events: 1,
          unpricedEvents: 0,
          costMicros: 250_000n,
        },
      ],
    });
    expect(summary.customerBilling).toEqual({
      chargedSettlements: 1,
      chargedCents: 600n,
      openSettlements: 1,
      openCents: 600n,
      failedSettlements: 1,
    });
  });
});
