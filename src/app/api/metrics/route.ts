import { NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/metrics-auth";
import { OPERATIONAL_REVIEW_FAILURE_SQL } from "@/lib/review-outcome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["queued", "running", "completed", "failed", "stale"] as const;
const INSTALLATION_STATES = ["active", "suspended"] as const;
const REPOSITORY_ENABLED = ["true", "false"] as const;
const REVIEW_ACTIVITY_EVENTS = ["queued", "started", "finished"] as const;
const JOB_AGE_STATUSES = ["queued", "running"] as const;
const REVIEW_INCIDENT_CATEGORIES = [
  "operational_failure",
  "scorer_failure",
  "scorer_fallback",
  "model_fallback",
  "invalid_output",
  "failed_job",
] as const;
const DATABASE_METRICS_TIMEOUT_MS = 2_000;

interface DatabaseMetrics {
  databaseSizeBytes: number;
  activeSessions: number;
  privateMonitorHeartbeatAgeSeconds: number;
  privateMonitorCollectionAgeSeconds: number;
  privateMonitorHeartbeatDeliveryAgeSeconds: number;
  privateMonitorConsecutiveFailedPasses: number;
  privateMonitorRunningPassAgeSeconds: number;
  ilertAlertLastReceivedAgeSeconds: number;
  queueDepth: number;
  usersTotal: number;
  organizationCounts: Array<{ status: string; count: number }>;
  reviewStatusCounts: Map<string, number>;
  review24hStatusCounts: Map<string, number>;
  reviewActivity24h: Map<string, number>;
  silenceRate: number;
  watchdogKills: number;
  installationCounts: Map<string, number>;
  repositoryCounts: Map<string, number>;
  webhookDeliveries24h: number;
  webhookPending: number;
  oldestWebhookPendingAge: number;
  webhookRecoveryRequests: number;
  webhookRecoveryAccepted: number;
  webhookRecoveryRecovered: number;
  webhookRecoveryUnresolved: number;
  webhookRecoveryTerminal: number;
  webhookRecoveryLastScanAge: number;
  webhookDeliveries24hByEvent: Array<{ event: string; count: number }>;
  jobCounts: Array<{ kind: string; status: string; count: number }>;
  operatorAlertCounts: Array<{ event: string; status: string; count: number }>;
  operatorAlertFailuresCurrent: number;
  oldestOperatorAlertPendingAge: number;
  billingSettlementFailuresCurrent: number;
  billingSettlementsReconcilingCurrent: number;
  oldestBillingSettlementPendingAge: number;
  unmatchedBillingProviderEvents24h: number;
  oldestBillingCheckoutOpenAge: number;
  billingCheckoutFailures24h: number;
  checkRunCleanupFailures30m: number;
  oldestJobAges: Map<string, number>;
  oldestRunningReviewAge: number;
  usageTokens: Array<{
    model: string;
    type: "prompt" | "completion";
    tokens: number;
  }>;
  reviewIncidents30m: Map<string, number>;
  monitorCheckFailures24h: Array<{
    key: string;
    recovered: boolean;
    count: number;
  }>;
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
      "# HELP postil_private_monitor_heartbeat_age_seconds Age of the private monitor process heartbeat, or 2147483647 when no heartbeat exists.",
      "# TYPE postil_private_monitor_heartbeat_age_seconds gauge",
      `postil_private_monitor_heartbeat_age_seconds ${dbMetrics.privateMonitorHeartbeatAgeSeconds}`,
      "# HELP postil_private_monitor_heartbeat_fresh Whether the private monitor process heartbeat is less than 15 minutes old.",
      "# TYPE postil_private_monitor_heartbeat_fresh gauge",
      `postil_private_monitor_heartbeat_fresh ${dbMetrics.privateMonitorHeartbeatAgeSeconds < 900 ? 1 : 0}`,
      "# HELP postil_private_monitor_collection_age_seconds Age of the latest completed private monitoring pass, or 2147483647 when no pass completed.",
      "# TYPE postil_private_monitor_collection_age_seconds gauge",
      `postil_private_monitor_collection_age_seconds ${dbMetrics.privateMonitorCollectionAgeSeconds}`,
      "# HELP postil_private_monitor_collection_fresh Whether a private monitoring pass completed less than 15 minutes ago.",
      "# TYPE postil_private_monitor_collection_fresh gauge",
      `postil_private_monitor_collection_fresh ${dbMetrics.privateMonitorCollectionAgeSeconds < 900 ? 1 : 0}`,
      "# HELP postil_monitor_heartbeat_delivery_age_seconds Age of the latest successful external dead-man heartbeat delivery, or 2147483647 when none succeeded.",
      "# TYPE postil_monitor_heartbeat_delivery_age_seconds gauge",
      `postil_monitor_heartbeat_delivery_age_seconds ${dbMetrics.privateMonitorHeartbeatDeliveryAgeSeconds}`,
      "# HELP postil_monitor_heartbeat_delivery_fresh Whether an external dead-man heartbeat was delivered less than 15 minutes ago.",
      "# TYPE postil_monitor_heartbeat_delivery_fresh gauge",
      `postil_monitor_heartbeat_delivery_fresh ${dbMetrics.privateMonitorHeartbeatDeliveryAgeSeconds < 900 ? 1 : 0}`,
      "# HELP postil_private_monitor_consecutive_failed_passes Private monitoring passes failed since the latest completed pass.",
      "# TYPE postil_private_monitor_consecutive_failed_passes gauge",
      `postil_private_monitor_consecutive_failed_passes ${dbMetrics.privateMonitorConsecutiveFailedPasses}`,
      "# HELP postil_private_monitor_running_pass_age_seconds Age of the currently running private monitoring pass, or zero when no pass is running.",
      "# TYPE postil_private_monitor_running_pass_age_seconds gauge",
      `postil_private_monitor_running_pass_age_seconds ${dbMetrics.privateMonitorRunningPassAgeSeconds}`,
      "# HELP postil_ilert_alert_last_received_age_seconds Age of the latest accepted iLert alert event, or 2147483647 when none was received.",
      "# TYPE postil_ilert_alert_last_received_age_seconds gauge",
      `postil_ilert_alert_last_received_age_seconds ${dbMetrics.ilertAlertLastReceivedAgeSeconds}`,
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
      "# HELP postil_users_total Registered users.",
      "# TYPE postil_users_total gauge",
      `postil_users_total ${dbMetrics.usersTotal}`,
      "# HELP postil_organizations_total Organizations by entitlement status.",
      "# TYPE postil_organizations_total gauge",
      ...dbMetrics.organizationCounts.map(
        (row) =>
          `postil_organizations_total{status="${escapeLabelValue(row.status)}"} ${
            row.count
          }`,
      ),
      "# HELP postil_reviews_total Reviews by status.",
      "# TYPE postil_reviews_total gauge",
      ...STATUSES.map(
        (s) =>
          `postil_reviews_total{status="${s}"} ${dbMetrics.reviewStatusCounts.get(s) ?? 0}`,
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
      "# HELP postil_webhook_dispatch_pending Durable webhook deliveries awaiting successful dispatch.",
      "# TYPE postil_webhook_dispatch_pending gauge",
      `postil_webhook_dispatch_pending ${dbMetrics.webhookPending}`,
      "# HELP postil_oldest_webhook_dispatch_age_seconds Age of the oldest incomplete webhook delivery.",
      "# TYPE postil_oldest_webhook_dispatch_age_seconds gauge",
      `postil_oldest_webhook_dispatch_age_seconds ${dbMetrics.oldestWebhookPendingAge}`,
      "# HELP postil_github_webhook_recovery_requests_30d GitHub App redelivery requests attempted in retained recovery metadata.",
      "# TYPE postil_github_webhook_recovery_requests_30d gauge",
      `postil_github_webhook_recovery_requests_30d ${dbMetrics.webhookRecoveryRequests}`,
      "# HELP postil_github_webhook_recovery_accepted_30d Redelivery requests accepted by GitHub in retained recovery metadata.",
      "# TYPE postil_github_webhook_recovery_accepted_30d gauge",
      `postil_github_webhook_recovery_accepted_30d ${dbMetrics.webhookRecoveryAccepted}`,
      "# HELP postil_github_webhook_recovery_recovered_30d Failed deliveries followed by a successful delivery in retained recovery metadata.",
      "# TYPE postil_github_webhook_recovery_recovered_30d gauge",
      `postil_github_webhook_recovery_recovered_30d ${dbMetrics.webhookRecoveryRecovered}`,
      "# HELP postil_github_webhook_recovery_unresolved Failed deliveries awaiting recovery.",
      "# TYPE postil_github_webhook_recovery_unresolved gauge",
      `postil_github_webhook_recovery_unresolved ${dbMetrics.webhookRecoveryUnresolved}`,
      "# HELP postil_github_webhook_recovery_terminal Failed deliveries whose bounded recovery stopped.",
      "# TYPE postil_github_webhook_recovery_terminal gauge",
      `postil_github_webhook_recovery_terminal ${dbMetrics.webhookRecoveryTerminal}`,
      "# HELP postil_github_webhook_recovery_last_scan_age_seconds Age of the last successful App delivery API page.",
      "# TYPE postil_github_webhook_recovery_last_scan_age_seconds gauge",
      `postil_github_webhook_recovery_last_scan_age_seconds ${dbMetrics.webhookRecoveryLastScanAge}`,
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
      "# HELP postil_operator_alerts_current Durable operator email alerts by event and delivery status.",
      "# TYPE postil_operator_alerts_current gauge",
      ...dbMetrics.operatorAlertCounts.map(
        (row) =>
          `postil_operator_alerts_current{event="${escapeLabelValue(
            row.event,
          )}",status="${escapeLabelValue(row.status)}"} ${row.count}`,
      ),
      "# HELP postil_operator_alert_failures_current Operator email alerts with exhausted delivery retries.",
      "# TYPE postil_operator_alert_failures_current gauge",
      `postil_operator_alert_failures_current ${dbMetrics.operatorAlertFailuresCurrent}`,
      "# HELP postil_oldest_operator_alert_pending_age_seconds Age of the oldest queued or retrying operator email alert.",
      "# TYPE postil_oldest_operator_alert_pending_age_seconds gauge",
      `postil_oldest_operator_alert_pending_age_seconds ${dbMetrics.oldestOperatorAlertPendingAge}`,
      "# HELP postil_billing_settlement_failures_current Closed billing periods that require operator resolution.",
      "# TYPE postil_billing_settlement_failures_current gauge",
      `postil_billing_settlement_failures_current ${dbMetrics.billingSettlementFailuresCurrent}`,
      "# HELP postil_billing_settlements_reconciling_current Provider charges whose outcome is being reconciled without a retry.",
      "# TYPE postil_billing_settlements_reconciling_current gauge",
      `postil_billing_settlements_reconciling_current ${dbMetrics.billingSettlementsReconcilingCurrent}`,
      "# HELP postil_oldest_billing_settlement_pending_age_seconds Age of the oldest pending, charging, or reconciling settlement.",
      "# TYPE postil_oldest_billing_settlement_pending_age_seconds gauge",
      `postil_oldest_billing_settlement_pending_age_seconds ${dbMetrics.oldestBillingSettlementPendingAge}`,
      "# HELP postil_unmatched_billing_provider_events_24h Verified billing events that could not be mapped to a customer organization.",
      "# TYPE postil_unmatched_billing_provider_events_24h gauge",
      `postil_unmatched_billing_provider_events_24h ${dbMetrics.unmatchedBillingProviderEvents24h}`,
      "# HELP postil_oldest_billing_checkout_open_age_seconds Age of the oldest checkout that has not completed or failed.",
      "# TYPE postil_oldest_billing_checkout_open_age_seconds gauge",
      `postil_oldest_billing_checkout_open_age_seconds ${dbMetrics.oldestBillingCheckoutOpenAge}`,
      "# HELP postil_billing_checkout_failures_24h Self-service checkout attempts that failed before completion.",
      "# TYPE postil_billing_checkout_failures_24h gauge",
      `postil_billing_checkout_failures_24h ${dbMetrics.billingCheckoutFailures24h}`,
      "# HELP postil_check_run_cleanup_failures_30m GitHub check cleanup jobs that reached terminal failure in the last 30 minutes.",
      "# TYPE postil_check_run_cleanup_failures_30m gauge",
      `postil_check_run_cleanup_failures_30m ${dbMetrics.checkRunCleanupFailures30m}`,
      "# HELP postil_oldest_job_age_seconds Age in seconds of the oldest queued or running job.",
      "# TYPE postil_oldest_job_age_seconds gauge",
      ...JOB_AGE_STATUSES.map(
        (status) =>
          `postil_oldest_job_age_seconds{status="${status}"} ${
            dbMetrics.oldestJobAges.get(status) ?? 0
          }`,
      ),
      "# HELP postil_oldest_running_review_age_seconds Age in seconds of the oldest running review.",
      "# TYPE postil_oldest_running_review_age_seconds gauge",
      `postil_oldest_running_review_age_seconds ${dbMetrics.oldestRunningReviewAge}`,
      "# HELP postil_usage_tokens_total LLM usage tokens by model and token type.",
      "# TYPE postil_usage_tokens_total counter",
      ...dbMetrics.usageTokens.map(
        (row) =>
          `postil_usage_tokens_total{model="${escapeLabelValue(
            row.model,
          )}",type="${row.type}"} ${row.tokens}`,
      ),
      "# HELP postil_review_incidents_30m Operational review incidents observed in the last 30 minutes.",
      "# TYPE postil_review_incidents_30m gauge",
      ...REVIEW_INCIDENT_CATEGORIES.map(
        (category) =>
          `postil_review_incidents_30m{category="${category}"} ${
            dbMetrics.reviewIncidents30m.get(category) ?? 0
          }`,
      ),
      "# HELP postil_private_monitor_check_failures_24h Failed private monitor check attempts in the last 24 hours; recovered attempts succeeded on retry within the same pass.",
      "# TYPE postil_private_monitor_check_failures_24h gauge",
      ...dbMetrics.monitorCheckFailures24h.map(
        (row) =>
          `postil_private_monitor_check_failures_24h{key="${escapeLabelValue(
            row.key,
          )}",recovered="${row.recovered ? "true" : "false"}"} ${row.count}`,
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
    operatorAlertsByEventStatus,
    organizationsByStatus,
    oldestJobs,
    oldestRunningReview,
    usageByModel,
    reviewIncidents30m,
    monitorCheckFailures24h,
  ] = await Promise.all([
    pool.query<{
      database_size_bytes: string;
      active_sessions: string;
      private_monitor_heartbeat_age_seconds: string;
      private_monitor_collection_age_seconds: string;
      private_monitor_heartbeat_delivery_age_seconds: string;
      private_monitor_consecutive_failed_passes: string;
      private_monitor_running_pass_age_seconds: string;
      ilert_alert_last_received_age_seconds: string;
      queue_depth: string;
      users_total: string;
      active_installations: string;
      suspended_installations: string;
      enabled_repositories: string;
      disabled_repositories: string;
      reviews_queued_24h: string;
      reviews_started_24h: string;
      reviews_finished_24h: string;
      webhook_deliveries_24h: string;
      webhook_pending: string;
      oldest_webhook_pending_age_seconds: string;
      webhook_recovery_requests: string;
      webhook_recovery_accepted: string;
      webhook_recovery_recovered: string;
      webhook_recovery_unresolved: string;
      webhook_recovery_terminal: string;
      webhook_recovery_last_scan_age_seconds: string;
      operator_alert_failures_current: string;
      oldest_operator_alert_pending_age_seconds: string;
      billing_settlement_failures_current: string;
      billing_settlements_reconciling_current: string;
      oldest_billing_settlement_pending_age_seconds: string;
      unmatched_billing_provider_events_24h: string;
      oldest_billing_checkout_open_age_seconds: string;
      billing_checkout_failures_24h: string;
      check_run_cleanup_failures_30m: string;
      watchdog_kills: string;
    }>(`
      SELECT
        pg_database_size(current_database())::text AS database_size_bytes,
        (SELECT count(*)::text FROM sessions WHERE expires_at > now()) AS active_sessions,
        COALESCE(
          (SELECT EXTRACT(EPOCH FROM now() - observed_at)::int
             FROM service_heartbeats
            WHERE component = 'monitor'),
          2147483647
        )::text AS private_monitor_heartbeat_age_seconds,
        COALESCE(
          (SELECT EXTRACT(EPOCH FROM now() - last_completed_at)::int
             FROM private_monitor_state
            WHERE id = 1),
          2147483647
        )::text AS private_monitor_collection_age_seconds,
        COALESCE(
          (SELECT EXTRACT(EPOCH FROM now() - observed_at)::int
             FROM service_heartbeats
            WHERE component = 'monitor-heartbeat-delivery'),
          2147483647
        )::text AS private_monitor_heartbeat_delivery_age_seconds,
        (SELECT count(*)::text
           FROM private_monitor_runs failed
          WHERE failed.status = 'failed'
            AND failed.id > COALESCE(
              (SELECT MAX(completed.id)
                 FROM private_monitor_runs completed
                WHERE completed.status = 'completed'),
              0
            )) AS private_monitor_consecutive_failed_passes,
        (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(started_at)), 0)::int::text
           FROM private_monitor_runs
          WHERE status = 'running') AS private_monitor_running_pass_age_seconds,
        COALESCE(
          (SELECT EXTRACT(EPOCH FROM now() - received_at)::int
             FROM ilert_alert_events
            ORDER BY sequence DESC
            LIMIT 1),
          2147483647
        )::text AS ilert_alert_last_received_age_seconds,
        (SELECT count(*)::text FROM jobs WHERE status = 'queued') AS queue_depth,
        (SELECT count(*)::text FROM users) AS users_total,
        (SELECT count(*)::text FROM installations WHERE suspended = false) AS active_installations,
        (SELECT count(*)::text FROM installations WHERE suspended = true) AS suspended_installations,
        (SELECT count(*)::text FROM repositories WHERE enabled = true) AS enabled_repositories,
        (SELECT count(*)::text FROM repositories WHERE enabled = false) AS disabled_repositories,
        (SELECT count(*)::text FROM reviews WHERE queued_at >= now() - interval '24 hours') AS reviews_queued_24h,
        (SELECT count(*)::text FROM reviews WHERE started_at >= now() - interval '24 hours') AS reviews_started_24h,
        (SELECT count(*)::text FROM reviews WHERE finished_at >= now() - interval '24 hours') AS reviews_finished_24h,
        (SELECT count(*)::text FROM webhook_deliveries WHERE received_at >= now() - interval '24 hours') AS webhook_deliveries_24h,
        (SELECT count(*)::text FROM webhook_deliveries WHERE completed_at IS NULL) AS webhook_pending,
        (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(received_at)), 0)::int::text FROM webhook_deliveries WHERE completed_at IS NULL) AS oldest_webhook_pending_age_seconds,
        (SELECT COALESCE(sum(request_attempts), 0)::text FROM github_webhook_delivery_recoveries WHERE delivered_at >= now() - interval '30 days') AS webhook_recovery_requests,
        (SELECT count(*)::text FROM github_webhook_delivery_recoveries WHERE delivered_at >= now() - interval '30 days' AND request_status_code = 202) AS webhook_recovery_accepted,
        (SELECT count(*)::text FROM github_webhook_delivery_recoveries WHERE delivered_at >= now() - interval '30 days' AND recovery_delivery_id IS NOT NULL) AS webhook_recovery_recovered,
        (SELECT count(*)::text FROM github_webhook_delivery_recoveries WHERE outcome = 'failure' AND recovery_delivery_id IS NULL AND COALESCE(request_state, '') NOT IN ('terminal', 'exhausted')) AS webhook_recovery_unresolved,
        (SELECT count(*)::text FROM github_webhook_delivery_recoveries WHERE request_state IN ('terminal', 'exhausted')) AS webhook_recovery_terminal,
        (SELECT COALESCE(EXTRACT(EPOCH FROM now() - last_page_at), 0)::int::text FROM github_webhook_redelivery_state WHERE id = 1) AS webhook_recovery_last_scan_age_seconds,
        (SELECT count(*)::text FROM operator_alert_deliveries WHERE status = 'failed') AS operator_alert_failures_current,
        (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)), 0)::int::text FROM operator_alert_deliveries WHERE status IN ('queued', 'retrying')) AS oldest_operator_alert_pending_age_seconds,
        (SELECT count(*)::text FROM billing_author_settlements WHERE status = 'failed') AS billing_settlement_failures_current,
        (SELECT count(*)::text FROM billing_author_settlements WHERE status = 'reconciling') AS billing_settlements_reconciling_current,
        (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)), 0)::int::text FROM billing_author_settlements WHERE status IN ('pending', 'charging', 'reconciling')) AS oldest_billing_settlement_pending_age_seconds,
        (SELECT count(*)::text FROM billing_provider_events WHERE outcome = 'unmatched' AND occurred_at >= now() - interval '24 hours') AS unmatched_billing_provider_events_24h,
        (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)), 0)::int::text FROM billing_checkout_transactions WHERE status IN ('creating', 'pending')) AS oldest_billing_checkout_open_age_seconds,
        (SELECT count(*)::text FROM billing_checkout_transactions WHERE status = 'failed' AND updated_at >= now() - interval '24 hours') AS billing_checkout_failures_24h,
        (SELECT count(*)::text FROM jobs
          WHERE kind = 'check-run-cleanup'
            AND status = 'failed'
            AND run_after >= now() - interval '30 minutes') AS check_run_cleanup_failures_30m,
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
    pool.query<{ event: string; status: string; count: string }>(`
      SELECT event, status, count(*)::text AS count
      FROM operator_alert_deliveries
      GROUP BY event, status
      ORDER BY event, status
    `),
    pool.query<{ status: string; count: string }>(`
      SELECT COALESCE(oe.status, 'none') AS status, count(*)::text AS count
      FROM organizations o
      LEFT JOIN organization_entitlements oe ON oe.org_id = o.id
      GROUP BY COALESCE(oe.status, 'none')
      ORDER BY status
    `),
    pool.query<{ status: string; age_seconds: string | null }>(`
      SELECT
        status::text,
        EXTRACT(EPOCH FROM now() - MIN(
          CASE
            WHEN status = 'running' THEN COALESCE(locked_at, created_at)
            ELSE run_after
          END
        ))::int::text AS age_seconds
      FROM jobs
      WHERE status = 'running'
         OR (status = 'queued' AND run_after <= now())
      GROUP BY status
    `),
    pool.query<{ age_seconds: string | null }>(`
      SELECT EXTRACT(EPOCH FROM now() - MIN(started_at))::int::text AS age_seconds
      FROM reviews
      WHERE status = 'running'
    `),
    pool.query<{
      model: string;
      prompt_tokens: string;
      completion_tokens: string;
    }>(`
      SELECT
        COALESCE(NULLIF(model_used, ''), 'unknown') AS model,
        COALESCE(sum(prompt_tokens), 0)::text AS prompt_tokens,
        COALESCE(sum(completion_tokens), 0)::text AS completion_tokens
      FROM usage_events
      GROUP BY COALESCE(NULLIF(model_used, ''), 'unknown')
      ORDER BY model
    `),
    pool.query<{
      operational_failure: string;
      scorer_failure: string;
      scorer_fallback: string;
      model_fallback: string;
      invalid_output: string;
      failed_job: string;
    }>(`
      SELECT
        (SELECT count(*)::text
         FROM reviews
         WHERE finished_at >= now() - interval '30 minutes'
           AND (
             (${OPERATIONAL_REVIEW_FAILURE_SQL})
             OR (
               status = 'completed'
               AND EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(COALESCE(envelope -> 'findings', '[]'::jsonb)) AS finding
                 WHERE finding ->> 'path' IN (
                   '.postil/provider',
                   '.postil/model-output',
                   '.postil/operational'
                 )
               )
             )
           )) AS operational_failure,
        (SELECT count(*)::text
         FROM reviews
         WHERE status = 'completed'
           AND finished_at >= now() - interval '30 minutes'
           AND (
             NULLIF(btrim(envelope ->> 'scorerError'), '') IS NOT NULL
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(COALESCE(envelope -> 'modelIncidents', '[]'::jsonb)) AS incident
               WHERE incident ->> 'phase' = 'scorer'
                 AND incident ->> 'recovered' = 'false'
             )
           )) AS scorer_failure,
        (SELECT count(*)::text
         FROM reviews
         WHERE status = 'completed'
           AND finished_at >= now() - interval '30 minutes'
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(envelope -> 'modelIncidents', '[]'::jsonb)) AS incident
             WHERE incident ->> 'phase' = 'scorer'
               AND incident ->> 'recovery' = 'fallback'
           )) AS scorer_fallback,
        (SELECT count(*)::text
         FROM reviews
         WHERE status = 'completed'
           AND finished_at >= now() - interval '30 minutes'
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(envelope -> 'modelIncidents', '[]'::jsonb)) AS incident
             WHERE incident ->> 'phase' = 'review'
               AND incident ->> 'recovery' = 'fallback'
           )) AS model_fallback,
        (SELECT count(*)::text
         FROM reviews
         WHERE status = 'completed'
           AND finished_at >= now() - interval '30 minutes'
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(envelope -> 'modelIncidents', '[]'::jsonb)) AS incident
             WHERE incident ->> 'category' = 'invalidOutput'
           )) AS invalid_output,
        (SELECT count(*)::text
         FROM jobs
         WHERE status = 'failed'
           -- Queue terminal transitions stamp run_after with their completion
           -- time because failed jobs no longer use it for scheduling.
           AND run_after >= now() - interval '30 minutes') AS failed_job
    `),
    pool.query<{ key: string; recovered: boolean; count: string }>(`
      SELECT key, recovered, count(*)::text AS count
        FROM private_monitor_check_failures
       WHERE observed_at >= now() - interval '24 hours'
       GROUP BY key, recovered
       ORDER BY key, recovered
    `),
  ]);

  const row = overview.rows[0];
  if (!row) throw new Error("database metrics overview returned no row");

  const reviewStatusCounts = countMap(reviewsByStatus.rows, "status");
  const review24hStatusCounts = countMap(reviews24hByStatus.rows, "status");
  const completed = toNumber(silence.rows[0]?.completed);
  const silent = toNumber(silence.rows[0]?.silent);
  const silenceRate = completed > 0 ? silent / completed : 0;
  const incidentRow = reviewIncidents30m.rows[0];

  return {
    databaseSizeBytes: toNumber(row.database_size_bytes),
    activeSessions: toNumber(row.active_sessions),
    privateMonitorHeartbeatAgeSeconds: toNumber(
      row.private_monitor_heartbeat_age_seconds,
    ),
    privateMonitorCollectionAgeSeconds: toNumber(
      row.private_monitor_collection_age_seconds,
    ),
    privateMonitorHeartbeatDeliveryAgeSeconds: toNumber(
      row.private_monitor_heartbeat_delivery_age_seconds,
    ),
    privateMonitorConsecutiveFailedPasses: toNumber(
      row.private_monitor_consecutive_failed_passes,
    ),
    privateMonitorRunningPassAgeSeconds: toNumber(
      row.private_monitor_running_pass_age_seconds,
    ),
    ilertAlertLastReceivedAgeSeconds: toNumber(
      row.ilert_alert_last_received_age_seconds,
    ),
    queueDepth: toNumber(row.queue_depth),
    usersTotal: toNumber(row.users_total),
    organizationCounts: organizationsByStatus.rows.map((orgRow) => ({
      status: orgRow.status,
      count: toNumber(orgRow.count),
    })),
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
    webhookPending: toNumber(row.webhook_pending),
    oldestWebhookPendingAge: toNumber(row.oldest_webhook_pending_age_seconds),
    webhookRecoveryRequests: toNumber(row.webhook_recovery_requests),
    webhookRecoveryAccepted: toNumber(row.webhook_recovery_accepted),
    webhookRecoveryRecovered: toNumber(row.webhook_recovery_recovered),
    webhookRecoveryUnresolved: toNumber(row.webhook_recovery_unresolved),
    webhookRecoveryTerminal: toNumber(row.webhook_recovery_terminal),
    webhookRecoveryLastScanAge: toNumber(
      row.webhook_recovery_last_scan_age_seconds,
    ),
    webhookDeliveries24hByEvent: webhooks24hByEvent.rows.map((eventRow) => ({
      event: eventRow.event,
      count: toNumber(eventRow.count),
    })),
    jobCounts: jobsByKindStatus.rows.map((jobRow) => ({
      kind: jobRow.kind,
      status: jobRow.status,
      count: toNumber(jobRow.count),
    })),
    operatorAlertCounts: operatorAlertsByEventStatus.rows.map((alertRow) => ({
      event: alertRow.event,
      status: alertRow.status,
      count: toNumber(alertRow.count),
    })),
    operatorAlertFailuresCurrent: toNumber(row.operator_alert_failures_current),
    oldestOperatorAlertPendingAge: toNumber(
      row.oldest_operator_alert_pending_age_seconds,
    ),
    billingSettlementFailuresCurrent: toNumber(
      row.billing_settlement_failures_current,
    ),
    billingSettlementsReconcilingCurrent: toNumber(
      row.billing_settlements_reconciling_current,
    ),
    oldestBillingSettlementPendingAge: toNumber(
      row.oldest_billing_settlement_pending_age_seconds,
    ),
    unmatchedBillingProviderEvents24h: toNumber(
      row.unmatched_billing_provider_events_24h,
    ),
    oldestBillingCheckoutOpenAge: toNumber(
      row.oldest_billing_checkout_open_age_seconds,
    ),
    billingCheckoutFailures24h: toNumber(row.billing_checkout_failures_24h),
    checkRunCleanupFailures30m: toNumber(
      row.check_run_cleanup_failures_30m,
    ),
    oldestJobAges: new Map(
      oldestJobs.rows.map((jobRow) => [
        jobRow.status,
        toNumber(jobRow.age_seconds),
      ]),
    ),
    oldestRunningReviewAge: toNumber(oldestRunningReview.rows[0]?.age_seconds),
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
    reviewIncidents30m: new Map(
      REVIEW_INCIDENT_CATEGORIES.map((category) => [
        category,
        toNumber(incidentRow?.[category]),
      ]),
    ),
    monitorCheckFailures24h: monitorCheckFailures24h.rows.map((failureRow) => ({
      key: failureRow.key,
      recovered: failureRow.recovered === true,
      count: toNumber(failureRow.count),
    })),
  };
}

function countMap<
  T extends Record<K, string> & { count: string },
  K extends keyof T,
>(rows: T[], key: K): Map<string, number> {
  return new Map(rows.map((row) => [row[key], toNumber(row.count)]));
}

function toNumber(value: string | number | null | undefined): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}
