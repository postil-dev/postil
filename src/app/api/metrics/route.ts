import { NextResponse } from "next/server";

import { sql } from "drizzle-orm";

import { getDb, getPool, schema } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { queueDepth } from "@/lib/queue";
import { watchdogKillCount } from "@/worker/watchdog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["queued", "running", "completed", "failed", "stale"] as const;

/** Prometheus text exposition, protected by a bearer token. */
export async function GET(request: Request): Promise<NextResponse> {
  const token = optionalEnv("METRICS_TOKEN");
  if (!token) {
    return NextResponse.json(
      { error: "metrics disabled: METRICS_TOKEN is not configured" },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const [depth, byStatus, silence, watchdogKills] = await Promise.all([
    queueDepth(getPool()),
    db
      .select({ status: schema.reviews.status, count: sql<number>`count(*)::int` })
      .from(schema.reviews)
      .groupBy(schema.reviews.status),
    db
      .select({
        completed: sql<number>`count(*) FILTER (WHERE ${schema.reviews.status} = 'completed')::int`,
        silent: sql<number>`count(*) FILTER (WHERE ${schema.reviews.status} = 'completed' AND ${schema.reviews.silent})::int`,
      })
      .from(schema.reviews),
    watchdogKillCount(),
  ]);

  const statusCounts = new Map<string, number>(byStatus.map((r) => [r.status, r.count]));
  const completed = silence[0]?.completed ?? 0;
  const silent = silence[0]?.silent ?? 0;
  const silenceRate = completed > 0 ? silent / completed : 0;

  const lines: string[] = [
    "# HELP postil_queue_depth Jobs waiting in the queue.",
    "# TYPE postil_queue_depth gauge",
    `postil_queue_depth ${depth}`,
    "# HELP postil_reviews_total Reviews by status.",
    "# TYPE postil_reviews_total gauge",
    ...STATUSES.map((s) => `postil_reviews_total{status="${s}"} ${statusCounts.get(s) ?? 0}`),
    "# HELP postil_silence_rate Fraction of completed reviews with no findings.",
    "# TYPE postil_silence_rate gauge",
    `postil_silence_rate ${silenceRate.toFixed(4)}`,
    "# HELP postil_watchdog_kills_total Reviews killed by the watchdog.",
    "# TYPE postil_watchdog_kills_total counter",
    `postil_watchdog_kills_total ${watchdogKills}`,
  ];

  return new NextResponse(`${lines.join("\n")}\n`, {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
