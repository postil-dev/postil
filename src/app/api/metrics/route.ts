import { and, count, eq, gte, sql, sum } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { reviewFailureClass } from "@/lib/review-failure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/metrics?days=7
 *
 * Operator-only endpoint for billing and reliability observability.
 * Auth: Bearer token via METRICS_API_KEY env var.
 * Returns aggregate review counts, success rates, token usage, and
 * recent failure details for the requested time window.
 */
export async function GET(req: Request): Promise<Response> {
  // Bearer auth — operators set METRICS_API_KEY in env.
  if (env.METRICS_API_KEY) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${env.METRICS_API_KEY}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 90);

  const db = getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const staleReviewSince = new Date(Date.now() - 30 * 60 * 1000);

  // Review reliability counts.
  const reviewStats = await db
    .select({
      status: schema.reviews.status,
      count: count(),
    })
    .from(schema.reviews)
    .where(gte(schema.reviews.createdAt, since))
    .groupBy(schema.reviews.status);

  const statusCounts: Record<string, number> = {};
  for (const row of reviewStats) statusCounts[row.status] = Number(row.count);
  const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const completed = statusCounts.completed ?? 0;
  const successRate = total > 0 ? Math.round((completed / total) * 10000) / 100 : null;

  // Average review duration for completed reviews.
  const [durationRow] = await db
    .select({
      avgMs: sql<number>`avg(extract(epoch from (${schema.reviews.completedAt} - ${schema.reviews.createdAt})) * 1000)::int`,
    })
    .from(schema.reviews)
    .where(
      and(
        gte(schema.reviews.createdAt, since),
        eq(schema.reviews.status, "completed"),
      ),
    );

  // Token usage totals.
  const [tokenStats] = await db
    .select({
      totalTokens: sum(schema.usageEvents.quantity),
      eventCount: count(),
    })
    .from(schema.usageEvents)
    .where(
      and(
        gte(schema.usageEvents.createdAt, since),
        eq(schema.usageEvents.kind, "tokens_consumed"),
      ),
    );

  // Review-completed event count (for cross-checking).
  const [reviewEvents] = await db
    .select({ count: count() })
    .from(schema.usageEvents)
    .where(
      and(
        gte(schema.usageEvents.createdAt, since),
        eq(schema.usageEvents.kind, "review_completed"),
      ),
    );

  const [staleRunningReviews] = await db
    .select({ count: count() })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.status, "running"),
        sql`${schema.reviews.createdAt} < ${staleReviewSince}`,
      ),
    );

  // Recent failures for debugging.
  const recentFailures = await db
    .select({
      id: schema.reviews.id,
      repoFullName: schema.reviews.repoFullName,
      pullNumber: schema.reviews.pullNumber,
      status: schema.reviews.status,
      errorMessage: schema.reviews.errorMessage,
      createdAt: schema.reviews.createdAt,
    })
    .from(schema.reviews)
    .where(
      and(
        gte(schema.reviews.createdAt, since),
        eq(schema.reviews.status, "failed"),
      ),
    )
    .orderBy(schema.reviews.createdAt)
    .limit(20);

  return NextResponse.json({
    window: { days, since: since.toISOString() },
    reviews: {
      total,
      byStatus: statusCounts,
      successRatePct: successRate,
      avgDurationMs: durationRow?.avgMs ?? null,
      staleRunning: {
        olderThanMinutes: 30,
        count: Number(staleRunningReviews?.count ?? 0),
      },
    },
    usage: {
      totalTokens: Number(tokenStats?.totalTokens ?? 0),
      tokenEvents: Number(tokenStats?.eventCount ?? 0),
      reviewEvents: Number(reviewEvents?.count ?? 0),
    },
    recentFailures: recentFailures.map((f) => ({
      id: f.id,
      repo: f.repoFullName,
      pr: f.pullNumber,
      failureClass: reviewFailureClass(f.status, f.errorMessage),
      error: f.errorMessage,
      at: f.createdAt,
    })),
  });
}
