import { sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";

export const OPERATOR_FINANCIAL_PERIOD_DAYS = 30;

export interface OperatorModelUsage {
  model: string;
  events: number;
  unpricedEvents: number;
  costMicros: bigint;
}

export interface OperatorFinancialSummary {
  period: { start: Date; end: Date };
  modelUsage: {
    events: number;
    unpricedEvents: number;
    totalCostMicros: bigint;
    pricedReviews: number;
    pricedReviewAverageMicros: bigint | null;
    models: OperatorModelUsage[];
  };
  customerBilling: {
    chargedSettlements: number;
    chargedCents: bigint;
    openSettlements: number;
    openCents: bigint;
    failedSettlements: number;
  };
}

export interface OperatorBillingProviderAction {
  provider: string;
  status: "connected" | "external" | "not_connected";
  href: string | null;
  action: string | null;
  instruction: string | null;
}

interface ModelUsageSummaryRow extends Record<string, unknown> {
  events: number;
  unpricedEvents: number;
  totalCostMicros: string;
}

interface ModelUsageRow extends Record<string, unknown> {
  model: string;
  events: number;
  unpricedEvents: number;
  costMicros: string;
}

interface PricedReviewRow extends Record<string, unknown> {
  reviews: number;
  totalCostMicros: string;
}

interface CustomerBillingRow extends Record<string, unknown> {
  chargedSettlements: number;
  chargedCents: string;
  openSettlements: number;
  openCents: string;
  failedSettlements: number;
}

export function operatorFinancialPeriod(now = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(now.getTime() - OPERATOR_FINANCIAL_PERIOD_DAYS * 24 * 60 * 60 * 1_000),
    end: now,
  };
}

/** Returns aggregate financial records only, so the operator page does not expose tenant billing detail. */
export async function getOperatorFinancialSummary(
  db: Pick<Database, "execute">,
  now = new Date(),
): Promise<OperatorFinancialSummary> {
  const period = operatorFinancialPeriod(now);
  const [modelUsage, modelRows, reviewUsage, customerBilling] = await Promise.all([
    db.execute<ModelUsageSummaryRow>(sql`
      SELECT
        COUNT(*)::int AS "events",
        COUNT(*) FILTER (WHERE ${schema.usageEvents.costMicros} IS NULL)::int AS "unpricedEvents",
        COALESCE(SUM(${schema.usageEvents.costMicros}), 0)::bigint AS "totalCostMicros"
      FROM ${schema.usageEvents}
      WHERE ${schema.usageEvents.createdAt} >= ${period.start}
        AND ${schema.usageEvents.createdAt} < ${period.end}
    `),
    db.execute<ModelUsageRow>(sql`
      SELECT
        COALESCE(NULLIF(BTRIM(${schema.usageEvents.modelUsed}), ''), 'Model not recorded') AS "model",
        COUNT(*)::int AS "events",
        COUNT(*) FILTER (WHERE ${schema.usageEvents.costMicros} IS NULL)::int AS "unpricedEvents",
        COALESCE(SUM(${schema.usageEvents.costMicros}), 0)::bigint AS "costMicros"
      FROM ${schema.usageEvents}
      WHERE ${schema.usageEvents.createdAt} >= ${period.start}
        AND ${schema.usageEvents.createdAt} < ${period.end}
      GROUP BY 1
      ORDER BY "costMicros" DESC, "model" ASC
    `),
    db.execute<PricedReviewRow>(sql`
      WITH review_usage AS (
        SELECT
          ${schema.usageEvents.reviewId} AS "reviewId",
          BOOL_OR(${schema.usageEvents.costMicros} IS NOT NULL) AS "hasPricedEvent",
          COALESCE(SUM(${schema.usageEvents.costMicros}), 0)::bigint AS "costMicros"
        FROM ${schema.usageEvents}
        WHERE ${schema.usageEvents.reviewId} IS NOT NULL
          AND ${schema.usageEvents.createdAt} >= ${period.start}
          AND ${schema.usageEvents.createdAt} < ${period.end}
        GROUP BY ${schema.usageEvents.reviewId}
      )
      SELECT
        COUNT(*) FILTER (WHERE "hasPricedEvent")::int AS "reviews",
        COALESCE(SUM("costMicros") FILTER (WHERE "hasPricedEvent"), 0)::bigint AS "totalCostMicros"
      FROM review_usage
    `),
    db.execute<CustomerBillingRow>(sql`
      SELECT
        COUNT(*) FILTER (WHERE ${schema.billingAuthorSettlements.status} = 'charged')::int AS "chargedSettlements",
        COALESCE(SUM(${schema.billingAuthorSettlements.totalAmountCents}) FILTER (WHERE ${schema.billingAuthorSettlements.status} = 'charged'), 0)::bigint AS "chargedCents",
        COUNT(*) FILTER (WHERE ${schema.billingAuthorSettlements.status} IN ('pending', 'charging', 'reconciling'))::int AS "openSettlements",
        COALESCE(SUM(${schema.billingAuthorSettlements.totalAmountCents}) FILTER (WHERE ${schema.billingAuthorSettlements.status} IN ('pending', 'charging', 'reconciling')), 0)::bigint AS "openCents",
        COUNT(*) FILTER (WHERE ${schema.billingAuthorSettlements.status} = 'failed')::int AS "failedSettlements"
      FROM ${schema.billingAuthorSettlements}
      WHERE ${schema.billingAuthorSettlements.updatedAt} >= ${period.start}
        AND ${schema.billingAuthorSettlements.updatedAt} < ${period.end}
    `),
  ]);

  return operatorFinancialSummaryFromRows(
    period,
    modelUsage.rows[0],
    modelRows.rows,
    reviewUsage.rows[0],
    customerBilling.rows[0],
  );
}

export function operatorFinancialSummaryFromRows(
  period: OperatorFinancialSummary["period"],
  modelUsage: ModelUsageSummaryRow | undefined,
  modelRows: ModelUsageRow[],
  reviewUsage: PricedReviewRow | undefined,
  customerBilling: CustomerBillingRow | undefined,
): OperatorFinancialSummary {
  const pricedReviews = reviewUsage?.reviews ?? 0;
  const pricedReviewCostMicros = BigInt(reviewUsage?.totalCostMicros ?? "0");
  return {
    period,
    modelUsage: {
      events: modelUsage?.events ?? 0,
      unpricedEvents: modelUsage?.unpricedEvents ?? 0,
      totalCostMicros: BigInt(modelUsage?.totalCostMicros ?? "0"),
      pricedReviews,
      pricedReviewAverageMicros:
        pricedReviews > 0 ? pricedReviewCostMicros / BigInt(pricedReviews) : null,
      models: modelRows.map((row) => ({
        model: row.model,
        events: row.events,
        unpricedEvents: row.unpricedEvents,
        costMicros: BigInt(row.costMicros),
      })),
    },
    customerBilling: {
      chargedSettlements: customerBilling?.chargedSettlements ?? 0,
      chargedCents: BigInt(customerBilling?.chargedCents ?? "0"),
      openSettlements: customerBilling?.openSettlements ?? 0,
      openCents: BigInt(customerBilling?.openCents ?? "0"),
      failedSettlements: customerBilling?.failedSettlements ?? 0,
    },
  };
}

export function getOperatorBillingProviderActions(
  environment: Record<string, string | undefined> = process.env,
): {
  runtime: OperatorBillingProviderAction;
  customer: OperatorBillingProviderAction;
  model: OperatorBillingProviderAction;
} {
  const openRouterConfigured = configuredUrlHasHost(
    environment.POSTIL_API_BASE ?? "https://openrouter.ai/api/v1",
    "openrouter.ai",
  );
  const paddleConfigured = environment.POSTIL_PADDLE_BILLING_ENABLED === "1";
  return {
    runtime: {
      provider: "Fly.io",
      status: "not_connected",
      href: "https://fly.io/dashboard",
      action: "Open Fly.io dashboard",
      instruction: "Select the billing organization, then Billing.",
    },
    customer: {
      provider: "Paddle",
      status: paddleConfigured ? "connected" : "not_connected",
      href: paddleConfigured ? "https://vendors.paddle.com/" : null,
      action: paddleConfigured ? "Open Paddle dashboard" : null,
      instruction: null,
    },
    model: {
      provider: "OpenRouter",
      status: openRouterConfigured ? "external" : "not_connected",
      href: openRouterConfigured ? "https://openrouter.ai/activity" : null,
      action: openRouterConfigured ? "Open OpenRouter activity" : null,
      instruction: openRouterConfigured ? "OpenRouter is the selected hosted endpoint. Open the provider account to inspect billing; customer BYOK accounts are separate." : null,
    },
  };
}

export function formatUsdMicros(micros: bigint): string {
  return formatUsd(micros, 6);
}

export function formatUsdCents(cents: bigint): string {
  return formatUsd(cents, 2);
}

function configuredUrlHasHost(value: string | undefined, host: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).hostname === host;
  } catch {
    return false;
  }
}

function formatUsd(value: bigint, scale: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const dollars = magnitude / divisor;
  const fraction = (magnitude % divisor)
    .toString()
    .padStart(scale, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${negative ? "-" : ""}$${dollars.toLocaleString("en-US")}.${fraction}`;
}
