import { NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/metrics-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["queued", "running", "completed", "failed", "stale"] as const;
const INSTALLATION_STATES = ["active", "suspended"] as const;
const REPOSITORY_ENABLED = ["true", "false"] as const;
const REVIEW_ACTIVITY_EVENTS = ["queued", "started", "finished"] as const;
const JOB_AGE_STATUSES = ["queued", "running"] as const;
const DATABASE_METRICS_TIMEOUT_MS = 2_000;

interface DatabaseMetrics {
  databaseSizeBytes: number;
  activeSessions: number;
  queueDepth: number;
  reviewStatusCounts: Map<string, number>;
  review24hStatusCounts: Map<string, number>;
  reviewActivity24h: Map<string, number>;
  silenceRate: number;
  watchdogKills: number;
  installationCounts: Map<string, number>;
  repositoryCounts: Map<string, number>;
  webhookDeliveries24h: number;
  webhookDeliveries24hByEvent: Array<{ event: string; count: number }>;
  jobCounts: Array<{ kind: string; status: string; count: number }>;
  oldestJobAges: Map<string, number>;
  usageTokens: Array<{ model: string; type: "prompt" | "completion"; tokens: number }>;
}

/** Prometheus text exposition, protected by a bearer token. */
export async function GET(request: Request): Promise<NextResponse> {
  const token = metricsToken();
  if (!token) {
    return NextResponse.json(
      { error: "metrics disabled: METRICS_TOKEN is not configured" },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!bearerMatches(auth, token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const dbMetrics = await collectDatabaseMetricsOrNull();

  const lines: string[] = [
    "# HELP postil_database_up Database dependency reachability.",
    "# TYPE postil_database_up gauge",
    `postil_database_up ${dbMetrics ? 1 : 0}`,
  ];

  if (dbMetrics) {
    lines.push(
      "# HELP postil_queue_depth Jobs waiting in the queue.",
      "# TYPE postil_queue_depth gauge",
      `postil_queue_depth ${dbMetrics.queueDepth}`,
      "# HELP postil_database_size_bytes Current database size in bytes.",
      "# TYPE postil_database_size_bytes gauge",
      `postil_database_size_bytes ${dbMetrics.databaseSizeBytes}`,
      "# HELP postil_sessions_active Sessions that have not expired.",
      "# TYPE postil_sessions_active gauge",
      `postil_sessions_active ${dbMetrics.activeSessions}`,
      "# HELP postil_installations_current GitHub App installations by state.",
      "# TYPE postil_installations_current gauge",
      ...INSTALLATION_STATES.map(
        (state) =>
          `postil_installations_current{state="${state}"} ${
            dbMetrics.installationCounts.get(state) ?? 0
          }`,
      ),
      "# HELP postil_repositories_current Repositories by enabled state.",
      "# TYPE postil_repositories_current gauge",
      ...REPOSITORY_ENABLED.map(
        (enabled) =>
          `postil_repositories_current{enabled="${enabled}"} ${
            dbMetrics.repositoryCounts.get(enabled) ?? 0
          }`,
      ),
      "# HELP postil_reviews_total Reviews by status.",
      "# TYPE postil_reviews_total gauge",
      ...STATUSES.map(
        (s) => `postil_reviews_total{status="${s}"} ${dbMetrics.reviewStatusCounts.get(s) ?? 0}`,
      ),
      "# HELP postil_reviews_24h Reviews queued in the last 24 hours by current status.",
      "# TYPE postil_reviews_24h gauge",
      ...STATUSES.map(
        (s) =>
          `postil_reviews_24h{status="${s}"} ${
            dbMetrics.review24hStatusCounts.get(s) ?? 0
          }`,
      ),
      "# HELP postil_review_activity_24h Review lifecycle events observed in the last 24 hours.",
      "# TYPE postil_review_activity_24h gauge",
      ...REVIEW_ACTIVITY_EVENTS.map(
        (event) =>
          `postil_review_activity_24h{event="${event}"} ${
            dbMetrics.reviewActivity24h.get(event) ?? 0
          }`,
      ),
      "# HELP postil_silence_rate Fraction of completed reviews with no findings.",
      "# TYPE postil_silence_rate gauge",
      `postil_silence_rate ${dbMetrics.silenceRate.toFixed(4)}`,
      "# HELP postil_watchdog_kills_total Reviews killed by the watchdog.",
      "# TYPE postil_watchdog_kills_total counter",
      `postil_watchdog_kills_total ${dbMetrics.watchdogKills}`,
      "# HELP postil_webhook_deliveries_24h Webhook deliveries received in the last 24 hours.",
      "# TYPE postil_webhook_deliveries_24h gauge",
      `postil_webhook_deliveries_24h ${dbMetrics.webhookDeliveries24h}`,
      "# HELP postil_webhook_deliveries_24h_by_event Webhook deliveries received in the last 24 hours by event.",
      "# TYPE postil_webhook_deliveries_24h_by_event gauge",
      ...dbMetrics.webhookDeliveries24hByEvent.map(
        (row) =>
          `postil_webhook_deliveries_24h_by_event{event="${escapeLabelValue(row.event)}"} ${
            row.count
          }`,
      ),
      "# HELP postil_jobs_current Jobs by kind and status.",
      "# TYPE postil_jobs_current gauge",
      ...dbMetrics.jobCounts.map(
        (row) =>
          `postil_jobs_current{kind="${escapeLabelValue(row.kind)}",status="${escapeLabelValue(
            row.status,
          )}"} ${row.count}`,
      ),
      "# HELP postil_oldest_job_age_seconds Age in seconds of the oldest queued or running job.",
      "# TYPE postil_oldest_job_age_seconds gauge",
      ...JOB_AGE_STATUSES.map(
        (status) =>
          `postil_oldest_job_age_seconds{status="${status}"} ${
            dbMetrics.oldestJobAges.get(status) ?? 0
          }`,
      ),
      "# HELP postil_usage_tokens_total LLM usage tokens by model and token type.",
      "# TYPE postil_usage_tokens_total counter",
      ...dbMetrics.usageTokens.map(
        (row) =>
          `postil_usage_tokens_total{model="${escapeLabelValue(
            row.model,
          )}",type="${row.type}"} ${row.tokens}`,
      ),
    );
  }

  return new NextResponse(`${lines.join("\n")}\n`, {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

function metricsToken(): string | undefined {
  return optionalEnv("METRICS_TOKEN") ?? optionalEnv("METRICS_API_KEY");
}

async function collectDatabaseMetricsOrNull(): Promise<DatabaseMetrics | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      collectDatabaseMetrics().catch(() => null),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), DATABASE_METRICS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function collectDatabaseMetrics(): Promise<DatabaseMetrics> {
  const pool = getPool();
  const [
    overview,
    reviewsByStatus,
    reviews24hByStatus,
    silence,
    webhooks24hByEvent,
    jobsByKindStatus,
    oldestJobs,
    usageByModel,
  ] = await Promise.all([
    pool.query<{
      database_size_bytes: string;
      active_sessions: string;
      queue_depth: string;
      active_installations: string;
      suspended_installations: string;
      enabled_repositories: string;
      disabled_repositories: string;
      reviews_queued_24h: string;
      reviews_started_24h: string;
      reviews_finished_24h: string;
      webhook_deliveries_24h: string;
      watchdog_kills: string;
    }>(`
      SELECT
        pg_database_size(current_database())::text AS database_size_bytes,
        (SELECT count(*)::text FROM sessions WHERE expires_at > now()) AS active_sessions,
        (SELECT count(*)::text FROM jobs WHERE status = 'queued') AS queue_depth,
        (SELECT count(*)::text FROM installations WHERE suspended = false) AS active_installations,
        (SELECT count(*)::text FROM installations WHERE suspended = true) AS suspended_installations,
        (SELECT count(*)::text FROM repositories WHERE enabled = true) AS enabled_repositories,
        (SELECT count(*)::text FROM repositories WHERE enabled = false) AS disabled_repositories,
        (SELECT count(*)::text FROM reviews WHERE queued_at >= now() - interval '24 hours') AS reviews_queued_24h,
        (SELECT count(*)::text FROM reviews WHERE started_at >= now() - interval '24 hours') AS reviews_started_24h,
        (SELECT count(*)::text FROM reviews WHERE finished_at >= now() - interval '24 hours') AS reviews_finished_24h,
        (SELECT count(*)::text FROM webhook_deliveries WHERE received_at >= now() - interval '24 hours') AS webhook_deliveries_24h,
        (SELECT count(*)::text FROM reviews WHERE status = 'failed' AND error_message LIKE 'watchdog:%') AS watchdog_kills
    `),
    pool.query<{ status: string; count: string }>(`
      SELECT status::text, count(*)::text AS count
      FROM reviews
      GROUP BY status
    `),
    pool.query<{ status: string; count: string }>(`
      SELECT status::text, count(*)::text AS count
      FROM reviews
      WHERE queued_at >= now() - interval '24 hours'
      GROUP BY status
    `),
    pool.query<{ completed: string; silent: string }>(`
      SELECT
        count(*) FILTER (WHERE status = 'completed')::text AS completed,
        count(*) FILTER (WHERE status = 'completed' AND silent)::text AS silent
      FROM reviews
    `),
    pool.query<{ event: string; count: string }>(`
      SELECT event, count(*)::text AS count
      FROM webhook_deliveries
      WHERE received_at >= now() - interval '24 hours'
      GROUP BY event
      ORDER BY event
    `),
    pool.query<{ kind: string; status: string; count: string }>(`
      SELECT kind, status::text, count(*)::text AS count
      FROM jobs
      GROUP BY kind, status
      ORDER BY kind, status
    `),
    pool.query<{ status: string; age_seconds: string | null }>(`
      SELECT
        status::text,
        EXTRACT(EPOCH FROM now() - MIN(
          CASE
            WHEN status = 'running' THEN COALESCE(locked_at, created_at)
            ELSE created_at
          END
        ))::int::text AS age_seconds
      FROM jobs
      WHERE status IN ('queued', 'running')
      GROUP BY status
    `),
    pool.query<{ model: string; prompt_tokens: string; completion_tokens: string }>(`
      SELECT
        COALESCE(NULLIF(model_used, ''), 'unknown') AS model,
        COALESCE(sum(prompt_tokens), 0)::text AS prompt_tokens,
        COALESCE(sum(completion_tokens), 0)::text AS completion_tokens
      FROM usage_events
      GROUP BY COALESCE(NULLIF(model_used, ''), 'unknown')
      ORDER BY model
    `),
  ]);

  const row = overview.rows[0];
  if (!row) throw new Error("database metrics overview returned no row");

  const reviewStatusCounts = countMap(reviewsByStatus.rows, "status");
  const review24hStatusCounts = countMap(reviews24hByStatus.rows, "status");
  const completed = toNumber(silence.rows[0]?.completed);
  const silent = toNumber(silence.rows[0]?.silent);
  const silenceRate = completed > 0 ? silent / completed : 0;

  return {
    databaseSizeBytes: toNumber(row.database_size_bytes),
    activeSessions: toNumber(row.active_sessions),
    queueDepth: toNumber(row.queue_depth),
    reviewStatusCounts,
    review24hStatusCounts,
    reviewActivity24h: new Map([
      ["queued", toNumber(row.reviews_queued_24h)],
      ["started", toNumber(row.reviews_started_24h)],
      ["finished", toNumber(row.reviews_finished_24h)],
    ]),
    silenceRate,
    watchdogKills: toNumber(row.watchdog_kills),
    installationCounts: new Map([
      ["active", toNumber(row.active_installations)],
      ["suspended", toNumber(row.suspended_installations)],
    ]),
    repositoryCounts: new Map([
      ["true", toNumber(row.enabled_repositories)],
      ["false", toNumber(row.disabled_repositories)],
    ]),
    webhookDeliveries24h: toNumber(row.webhook_deliveries_24h),
    webhookDeliveries24hByEvent: webhooks24hByEvent.rows.map((eventRow) => ({
      event: eventRow.event,
      count: toNumber(eventRow.count),
    })),
    jobCounts: jobsByKindStatus.rows.map((jobRow) => ({
      kind: jobRow.kind,
      status: jobRow.status,
      count: toNumber(jobRow.count),
    })),
    oldestJobAges: new Map(
      oldestJobs.rows.map((jobRow) => [jobRow.status, toNumber(jobRow.age_seconds)]),
    ),
    usageTokens: usageByModel.rows.flatMap((usageRow) => [
      {
        model: usageRow.model,
        type: "prompt" as const,
        tokens: toNumber(usageRow.prompt_tokens),
      },
      {
        model: usageRow.model,
        type: "completion" as const,
        tokens: toNumber(usageRow.completion_tokens),
      },
    ]),
  };
}

function countMap<T extends Record<K, string> & { count: string }, K extends keyof T>(
  rows: T[],
  key: K,
): Map<string, number> {
  return new Map(rows.map((row) => [row[key], toNumber(row.count)]));
}

function toNumber(value: string | number | null | undefined): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
