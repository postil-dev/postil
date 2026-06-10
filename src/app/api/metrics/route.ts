import { and, count, eq, gte, lte, sql as drizzleSql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { reviews, usageEvents } from "@/db/schema";
import { requireBearer } from "@/lib/auth-bearer";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireBearer(req, "METRICS_API_KEY");
  if (denied) return denied;

  const days = Math.min(Number(new URL(req.url).searchParams.get("days") ?? "7"), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [reviewCounts] = await db
    .select({
      total: count(),
      completed: drizzleSql<number>`sum(case when ${reviews.status} = 'completed' then 1 else 0 end)::int`,
      failed: drizzleSql<number>`sum(case when ${reviews.status} = 'failed' then 1 else 0 end)::int`,
      running: drizzleSql<number>`sum(case when ${reviews.status} = 'running' then 1 else 0 end)::int`,
      avgDurationMs: drizzleSql<number>`avg(extract(epoch from (${reviews.completedAt} - ${reviews.startedAt})) * 1000)::int`,
    })
    .from(reviews)
    .where(gte(reviews.requestedAt, since));

  const staleCutoff = new Date(Date.now() - 30 * 60 * 1000);
  const [staleRunning] = await db
    .select({ count: count() })
    .from(reviews)
    .where(and(eq(reviews.status, "running"), lte(reviews.startedAt, staleCutoff)));

  // Silence rate — Postil's signature metric.
  const [silenceCounts] = await db
    .select({
      total: count(),
      silent: drizzleSql<number>`sum(case when ${usageEvents.kind} = 'review_silent' then 1 else 0 end)::int`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since));

  const totalReviews = reviewCounts?.total ?? 0;
  const completed = reviewCounts?.completed ?? 0;
  const successRate = totalReviews > 0 ? completed / totalReviews : null;
  const silentTotal = silenceCounts?.total ?? 0;
  const silentSilent = silenceCounts?.silent ?? 0;
  const silenceRate = silentTotal > 0 ? silentSilent / silentTotal : null;

  return NextResponse.json({
    windowDays: days,
    reviews: {
      total: totalReviews,
      completed,
      failed: reviewCounts?.failed ?? 0,
      running: reviewCounts?.running ?? 0,
      successRate,
      avgDurationMs: reviewCounts?.avgDurationMs ?? null,
    },
    staleRunning: staleRunning?.count ?? 0,
    silenceRate,
  });
}
