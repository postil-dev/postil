import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  type CustomerServiceIncidentKey,
  enqueueCustomerServiceTransitionForAllOrganizationsSql,
} from "@/lib/customer-notifications";
import {
  configuredMonitoringAlertTransport,
  sendOperatorNotification,
  type OperatorNotificationTransport,
} from "@/lib/operator-notifications";
import { redactSecrets } from "@/lib/redact";
import { OPERATIONAL_REVIEW_FAILURE_SQL } from "@/lib/review-outcome";
import type { TransactionalEmailContent } from "@/lib/transactional-email";

export type PrivateMonitoringGroup =
  | "availability"
  | "billing"
  | "email"
  | "fleet"
  | "monitoring"
  | "provider"
  | "queue"
  | "signup"
  | "webhook";
export type PrivateMonitoringSeverity = "warning" | "critical";

export interface PrivateMonitoringCheck {
  key: string;
  group: PrivateMonitoringGroup;
  severity: PrivateMonitoringSeverity;
  healthy: boolean;
  summary: string;
  detail: string;
  /** Attempts the check made within the pass; absent for single-shot checks. */
  attempts?: number;
  /**
   * Bounded evidence for every attempt that failed before the final one. A
   * healthy check with entries here recovered through a retry.
   */
  attemptFailures?: readonly string[];
}

export interface PrivateMonitoringIncidentEvent {
  id: number;
  key: string;
  group: string;
  severity: PrivateMonitoringSeverity;
  transition: "opened" | "resolved";
  summary: string;
  detail: string;
  occurrenceCount: number;
  firstDetectedAt: Date;
  occurredAt: Date;
}

export interface PrivateMonitoringCheckFailure {
  id: number;
  runId: number;
  key: string;
  attempt: number;
  recovered: boolean;
  detail: string;
  observedAt: Date;
}

export interface PrivateMonitoringNotification {
  incidentKey: string;
  notificationKey: string;
  kind: "opened" | "reminder" | "resolved";
  capability: PrivateMonitoringGroup;
  severity: PrivateMonitoringSeverity;
  summary: string;
  detail: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
  resolvedAt: Date | null;
  attempt: number;
}

export interface PrivateMonitoringPass {
  runId: number;
  owner: string;
  scheduledFor: Date;
}

export interface MonitorPassFailureState {
  bucket: Date | null;
  failuresInBucket: number;
  lastAlertBucket: Date | null;
}

export interface PrivateMonitoringDashboard {
  state: {
    lastStartedAt: Date | null;
    lastCompletedAt: Date | null;
    lastError: string | null;
    heartbeatDeliveryError: string | null;
  };
  heartbeats: Array<{
    component: string;
    instanceId: string;
    observedAt: Date;
  }>;
  incidents: Array<{
    key: string;
    group: string;
    severity: PrivateMonitoringSeverity;
    summary: string;
    detail: string;
    openedDetail: string | null;
    state: "open" | "resolved";
    occurrenceCount: number;
    firstDetectedAt: Date;
    lastDetectedAt: Date;
    resolvedAt: Date | null;
    notificationAttempts: number;
    lastNotifiedAt: Date | null;
    lastNotificationError: string | null;
  }>;
  runs: Array<{
    id: number;
    status: "running" | "completed" | "failed";
    checkCount: number;
    failureCount: number;
    startedAt: Date;
    finishedAt: Date | null;
  }>;
  events: PrivateMonitoringIncidentEvent[];
  checkFailures: PrivateMonitoringCheckFailure[];
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;

export interface PublicProbeOptions {
  /** Delay implementation between retry attempts; tests replace it. */
  sleep?: Sleep;
}

interface ProbeAttempt {
  response: Response;
  body: string;
}

interface ProbeEvaluation {
  healthy: boolean;
  detail: string;
}

const MONITOR_STATE_ID = 1;
const DEFAULT_LEASE_MS = 2 * 60 * 1_000;
const PUBLIC_PROBE_TIMEOUT_MS = 8_000;
/**
 * A probe retries transport failures and transient statuses before it counts
 * as unhealthy. The delays are long enough to outlive a proxy reconnect or a
 * single slow response, and short enough that a pass still finishes well
 * inside the monitoring interval when every probe is down.
 */
const PUBLIC_PROBE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];
const TRANSIENT_PUBLIC_PROBE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const PUBLIC_PROBE_BODY_LIMIT = 32_768;
const CHECK_FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const INCIDENT_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const HEARTBEAT_DELIVERY_MAX_AGE_SECONDS = 15 * 60;
/** Retried attempts that recovered within 24 hours before flapping is reported. */
const CHECK_RECOVERY_FLAP_THRESHOLD = 2;
const INCIDENT_REMINDER_MS = 6 * 60 * 60 * 1_000;
const NOTIFICATION_LEASE_MS = 60 * 1_000;
const MAX_NOTIFICATION_ATTEMPTS = 5;
const NOTIFICATION_RETRY_EPOCH_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const MONITOR_PASS_ALERT_BUCKET_MS = 6 * 60 * 60 * 1_000;
const STALE_MONITOR_RUN_MS = 30 * 60 * 1_000;
const MONITOR_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_DETAIL_CHARS = 1_000;
const SAFE_COMPONENT = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_INSTANCE = /^[A-Za-z0-9._:-]{1,160}$/;

export async function recordServiceHeartbeat(
  pool: Pool,
  component: "worker" | "monitor" | "monitor-heartbeat-delivery",
  instanceId: string,
  now = new Date(),
): Promise<void> {
  if (!SAFE_INSTANCE.test(instanceId)) {
    throw new Error("service heartbeat instance id is malformed");
  }
  await pool.query(
    `INSERT INTO service_heartbeats (component, instance_id, observed_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (component) DO UPDATE SET
       instance_id = EXCLUDED.instance_id,
       observed_at = GREATEST(service_heartbeats.observed_at, EXCLUDED.observed_at)`,
    [component, instanceId, now],
  );
}

export async function deliverExternalMonitorHeartbeat(
  pool: Pool,
  options: {
    url: string | undefined;
    instanceId: string;
    now?: Date;
    fetchImpl?: Fetch;
  },
): Promise<"disabled" | "delivered"> {
  if (!options.url) return "disabled";
  const url = new URL(options.url);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(
      "external monitor heartbeat URL must use HTTPS without URL user info",
    );
  }
  const now = options.now ?? new Date();
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const message = boundedDetail(
      `external monitor heartbeat request failed: ${redactSecrets(error)}`,
    );
    await recordHeartbeatDeliveryError(pool, message, now);
    throw new Error(message);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const reason = redactSecrets(body).replace(/\s+/g, " ").trim().slice(0, 300);
    const message = boundedDetail(
      `external monitor heartbeat returned HTTP ${response.status}${reason ? `: ${reason}` : ""}`,
    );
    await recordHeartbeatDeliveryError(pool, message, now);
    throw new Error(message);
  }
  await response.body?.cancel().catch(() => undefined);
  await recordServiceHeartbeat(
    pool,
    "monitor-heartbeat-delivery",
    options.instanceId,
    now,
  );
  await recordHeartbeatDeliveryError(pool, null, now);
  return "delivered";
}

async function recordHeartbeatDeliveryError(
  pool: Pool,
  message: string | null,
  now: Date,
): Promise<void> {
  await pool
    .query(
      `INSERT INTO private_monitor_state (id, heartbeat_delivery_error, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         heartbeat_delivery_error = EXCLUDED.heartbeat_delivery_error,
         updated_at = EXCLUDED.updated_at`,
      [MONITOR_STATE_ID, message, now],
    )
    .catch(() => undefined);
}

export async function getPrivateMonitoringDashboard(
  pool: Pool,
): Promise<PrivateMonitoringDashboard> {
  const [
    stateResult,
    heartbeatResult,
    incidentResult,
    runResult,
    eventResult,
    checkFailureResult,
  ] = await Promise.all([
    pool.query<{
      last_started_at: Date | null;
      last_completed_at: Date | null;
      last_error: string | null;
      heartbeat_delivery_error: string | null;
    }>(
      `SELECT last_started_at, last_completed_at, last_error, heartbeat_delivery_error
         FROM private_monitor_state
        WHERE id = $1`,
      [MONITOR_STATE_ID],
    ),
    pool.query<{
      component: string;
      instance_id: string;
      observed_at: Date;
    }>(
      `SELECT component, instance_id, observed_at
         FROM service_heartbeats
        ORDER BY component`,
    ),
    pool.query<{
      key: string;
      group: string;
      severity: PrivateMonitoringSeverity;
      summary: string;
      detail: string;
      opened_detail: string | null;
      state: "open" | "resolved";
      occurrence_count: number;
      first_detected_at: Date;
      last_detected_at: Date;
      resolved_at: Date | null;
      notification_attempts: number;
      last_notified_at: Date | null;
      last_notification_error: string | null;
    }>(
      `SELECT key, "group", severity, summary, detail, opened_detail, state,
              occurrence_count, first_detected_at, last_detected_at, resolved_at,
              notification_attempts, last_notified_at, last_notification_error
         FROM private_monitor_incidents
        ORDER BY (state = 'open') DESC,
                 (severity = 'critical') DESC,
                 last_detected_at DESC
        LIMIT 100`,
    ),
    pool.query<{
      id: string;
      status: "running" | "completed" | "failed";
      check_count: number;
      failure_count: number;
      started_at: Date;
      finished_at: Date | null;
    }>(
      `SELECT id, status, check_count, failure_count, started_at, finished_at
         FROM private_monitor_runs
        ORDER BY id DESC
        LIMIT 24`,
    ),
    pool.query<{
      id: string;
      key: string;
      group: string;
      severity: PrivateMonitoringSeverity;
      transition: "opened" | "resolved";
      summary: string;
      detail: string;
      occurrence_count: number;
      first_detected_at: Date;
      occurred_at: Date;
    }>(
      `SELECT id, key, "group", severity, transition, summary, detail,
              occurrence_count, first_detected_at, occurred_at
         FROM private_monitor_incident_events
        ORDER BY id DESC
        LIMIT 100`,
    ),
    pool.query<{
      id: string;
      run_id: string;
      key: string;
      attempt: number;
      recovered: boolean;
      detail: string;
      observed_at: Date;
    }>(
      `SELECT id, run_id, key, attempt, recovered, detail, observed_at
         FROM private_monitor_check_failures
        WHERE observed_at >= now() - interval '24 hours'
        ORDER BY id DESC
        LIMIT 100`,
    ),
  ]);
  const state = stateResult.rows[0];
  return {
    state: {
      lastStartedAt: state?.last_started_at ?? null,
      lastCompletedAt: state?.last_completed_at ?? null,
      lastError: state?.last_error ?? null,
      heartbeatDeliveryError: state?.heartbeat_delivery_error ?? null,
    },
    heartbeats: heartbeatResult.rows.map((row) => ({
      component: row.component,
      instanceId: row.instance_id,
      observedAt: row.observed_at,
    })),
    incidents: incidentResult.rows.map((row) => ({
      key: row.key,
      group: row.group,
      severity: row.severity,
      summary: row.summary,
      detail: row.detail,
      openedDetail: row.opened_detail,
      state: row.state,
      occurrenceCount: row.occurrence_count,
      firstDetectedAt: row.first_detected_at,
      lastDetectedAt: row.last_detected_at,
      resolvedAt: row.resolved_at,
      notificationAttempts: row.notification_attempts,
      lastNotifiedAt: row.last_notified_at,
      lastNotificationError: row.last_notification_error,
    })),
    runs: runResult.rows.map((row) => ({
      id: Number(row.id),
      status: row.status,
      checkCount: row.check_count,
      failureCount: row.failure_count,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    })),
    events: eventResult.rows.map((row) => ({
      id: Number(row.id),
      key: row.key,
      group: row.group,
      severity: row.severity,
      transition: row.transition,
      summary: row.summary,
      detail: row.detail,
      occurrenceCount: row.occurrence_count,
      firstDetectedAt: row.first_detected_at,
      occurredAt: row.occurred_at,
    })),
    checkFailures: checkFailureResult.rows.map((row) => ({
      id: Number(row.id),
      runId: Number(row.run_id),
      key: row.key,
      attempt: row.attempt,
      recovered: row.recovered,
      detail: row.detail,
      observedAt: row.observed_at,
    })),
  };
}

export async function acquirePrivateMonitorLease(
  pool: Pool,
  owner: string,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
): Promise<boolean> {
  if (!SAFE_INSTANCE.test(owner)) throw new Error("private monitor owner is malformed");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 10 * 60_000) {
    throw new Error("private monitor lease must be between 30 seconds and 10 minutes");
  }
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  await pool.query(
    `INSERT INTO private_monitor_state (id, updated_at)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [MONITOR_STATE_ID, now],
  );
  const result = await pool.query(
    `UPDATE private_monitor_state
        SET lease_owner = $2,
            lease_expires_at = $3,
            updated_at = $4
      WHERE id = $1
        AND (
          lease_expires_at IS NULL
          OR lease_expires_at <= $4
          OR lease_owner = $2
        )
      RETURNING id`,
    [MONITOR_STATE_ID, owner, leaseExpiresAt, now],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function startPrivateMonitoringPass(
  pool: Pool,
  owner: string,
  scheduledFor: Date,
  now = new Date(),
): Promise<PrivateMonitoringPass | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lease = await client.query(
      `SELECT id
         FROM private_monitor_state
        WHERE id = $1
          AND lease_owner = $2
          AND lease_expires_at > $3
        FOR UPDATE`,
      [MONITOR_STATE_ID, owner, now],
    );
    if ((lease.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE private_monitor_runs
          SET status = 'failed',
              check_count = GREATEST(check_count, 1),
              failure_count = GREATEST(failure_count, 1),
              finished_at = $1,
              error = 'Monitor process stopped before pass completion.'
        WHERE status = 'running'
          AND started_at < $2`,
      [now, new Date(now.getTime() - STALE_MONITOR_RUN_MS)],
    );
    await client.query(
      `DELETE FROM private_monitor_runs
        WHERE status IN ('completed', 'failed')
          AND COALESCE(finished_at, started_at) < $1`,
      [new Date(now.getTime() - MONITOR_RUN_RETENTION_MS)],
    );
    await client.query(
      `DELETE FROM private_monitor_check_failures WHERE observed_at < $1`,
      [new Date(now.getTime() - CHECK_FAILURE_RETENTION_MS)],
    );
    await client.query(
      `DELETE FROM private_monitor_incident_events WHERE occurred_at < $1`,
      [new Date(now.getTime() - INCIDENT_EVENT_RETENTION_MS)],
    );
    const result = await client.query<{ id: string }>(
      `INSERT INTO private_monitor_runs
         (scheduled_for, owner, status, started_at)
       VALUES ($1, $2, 'running', $3)
       ON CONFLICT (scheduled_for) DO NOTHING
       RETURNING id`,
      [scheduledFor, owner, now],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE private_monitor_state
          SET last_started_at = $2,
              last_error = NULL,
              updated_at = $2
        WHERE id = $1`,
      [MONITOR_STATE_ID, now],
    );
    await client.query("COMMIT");
    return { runId: Number(row.id), owner, scheduledFor };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function finishPrivateMonitoringPass(
  pool: Pool,
  pass: PrivateMonitoringPass,
  checks: readonly PrivateMonitoringCheck[],
  now = new Date(),
): Promise<void> {
  validateCheckSet(checks);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lease = await client.query(
      `SELECT id
         FROM private_monitor_state
        WHERE id = $1
          AND lease_owner = $2
          AND lease_expires_at > $3
        FOR UPDATE`,
      [MONITOR_STATE_ID, pass.owner, now],
    );
    if ((lease.rowCount ?? 0) !== 1) {
      throw new Error("private monitor lease was lost before the pass completed");
    }
    for (const check of checks) {
      await reconcileCheck(client, check, now);
    }
    await recordCheckFailures(client, pass.runId, checks, now);
    const failureCount = checks.filter((check) => !check.healthy).length;
    await client.query(
      `UPDATE private_monitor_runs
          SET status = 'completed',
              check_count = $2,
              failure_count = $3,
              finished_at = $4,
              error = NULL
        WHERE id = $1 AND status = 'running'`,
      [pass.runId, checks.length, failureCount, now],
    );
    await client.query(
      `UPDATE private_monitor_state
          SET last_completed_at = $2,
              last_error = NULL,
              updated_at = $2
        WHERE id = $1 AND lease_owner = $3`,
      [MONITOR_STATE_ID, now, pass.owner],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function failPrivateMonitoringPass(
  pool: Pool,
  pass: PrivateMonitoringPass,
  error: unknown,
  now = new Date(),
): Promise<void> {
  const message = boundedDetail(redactSecrets(error));
  await pool.query(
    `UPDATE private_monitor_runs
        SET status = 'failed', finished_at = $2, error = $3
      WHERE id = $1 AND status = 'running'`,
    [pass.runId, now, message],
  );
  await pool.query(
    `UPDATE private_monitor_state
        SET last_error = $2, updated_at = $3
      WHERE id = $1 AND lease_owner = $4`,
    [MONITOR_STATE_ID, message, now, pass.owner],
  );
}

/**
 * Probes the public origin. Serving probes (site, liveness, dependencies)
 * are critical; hygiene probes (sitemap, favicon, robots, redirects, noindex
 * headers) are warnings because their failure degrades discoverability, not
 * service. Every probe retries transport failures and transient statuses
 * before it counts as unhealthy, and records each failed attempt so a probe
 * that only ever recovers on retry is still visible as flapping.
 */
export async function runPublicMonitoringChecks(
  publicOrigin: string,
  fetchImpl: Fetch = fetch,
  options: PublicProbeOptions = {},
): Promise<PrivateMonitoringCheck[]> {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password) {
    throw new Error("private monitor public origin must be a credential-free HTTPS URL");
  }
  const probe = (
    key: string,
    summary: string,
    severity: PrivateMonitoringSeverity,
    url: URL,
    init: RequestInit,
    evaluate: (attempt: ProbeAttempt) => ProbeEvaluation,
  ) => probeWithRetry({ key, summary, severity, url, init, evaluate, fetchImpl, options });
  const ok = (attempt: ProbeAttempt, url: URL): ProbeEvaluation => ({
    healthy: attempt.response.ok,
    detail: `${url.toString()} returned HTTP ${attempt.response.status}.`,
  });
  const site = new URL("/", origin);
  const liveness = new URL("/api/health", origin);
  const sitemap = new URL("/sitemap.xml", origin);
  const favicon = new URL("/favicon.ico", origin);
  const dependencies = new URL("/api/health/dependencies", origin);
  const robots = new URL("/robots.txt", origin);
  const checks = await Promise.all([
    probe("public-site", "Public site responds", "critical", site, { redirect: "follow" }, (attempt) => ok(attempt, site)),
    probe("public-liveness", "Web liveness endpoint responds", "critical", liveness, { redirect: "follow" }, (attempt) => ok(attempt, liveness)),
    probe("public-sitemap", "Sitemap responds", "warning", sitemap, { redirect: "follow" }, (attempt) => ok(attempt, sitemap)),
    probe("public-favicon", "Favicon responds", "warning", favicon, { redirect: "follow" }, (attempt) => ok(attempt, favicon)),
    probe("public-dependencies", "Web dependencies are ready", "critical", dependencies, { redirect: "follow" }, (attempt) =>
      evaluateDependencies(dependencies, attempt),
    ),
    probe("public-robots", "Robots policy exposes public pages", "warning", robots, { redirect: "follow" }, (attempt) =>
      evaluateRobots(origin, robots, attempt),
    ),
    probe(
      "redirect-about",
      "Legacy about route redirects",
      "warning",
      new URL("/about", origin),
      { redirect: "manual" },
      (attempt) => evaluateRedirect(new URL("/about", origin), new URL("/why-postil", origin), attempt),
    ),
    probe("noindex-login", "Login is excluded from indexing", "warning", new URL("/login", origin), { redirect: "follow" }, (attempt) =>
      evaluateNoIndex(new URL("/login", origin), attempt),
    ),
    probe(
      "noindex-api-health",
      "Health API is excluded from indexing",
      "warning",
      new URL("/api/health", origin),
      { redirect: "follow" },
      (attempt) => evaluateNoIndex(new URL("/api/health", origin), attempt),
    ),
  ]);
  if (origin.hostname === "postil.dev") {
    const www = new URL("https://www.postil.dev/docs?utm_source=monitor");
    checks.push(
      await probe(
        "redirect-www",
        "WWW traffic reaches the canonical origin",
        "warning",
        www,
        { redirect: "manual" },
        (attempt) =>
          evaluateRedirect(www, new URL("https://postil.dev/docs?utm_source=monitor"), attempt),
      ),
    );
  }
  return checks;
}

export async function runDatabaseMonitoringChecks(
  pool: Pool,
  options: {
    workerHeartbeatMaxAgeSeconds?: number;
    /** Whether an external dead-man heartbeat URL is configured, so its delivery is a check. */
    externalHeartbeatConfigured?: boolean;
  } = {},
): Promise<PrivateMonitoringCheck[]> {
  const workerHeartbeatMaxAgeSeconds =
    options.workerHeartbeatMaxAgeSeconds ?? 180;
  const externalHeartbeatConfigured = options.externalHeartbeatConfigured ?? false;
  if (
    !Number.isSafeInteger(workerHeartbeatMaxAgeSeconds) ||
    workerHeartbeatMaxAgeSeconds < 30 ||
    workerHeartbeatMaxAgeSeconds > 24 * 60 * 60
  ) {
    throw new Error(
      "worker heartbeat maximum age must be between 30 and 86400 seconds",
    );
  }
  const result = await pool.query<Record<string, string | null>>(`
    SELECT
      (SELECT EXTRACT(EPOCH FROM now() - observed_at)::int::text
         FROM service_heartbeats WHERE component = 'worker') AS worker_heartbeat_age,
      (SELECT EXTRACT(EPOCH FROM now() - observed_at)::int::text
         FROM service_heartbeats
        WHERE component = 'monitor-heartbeat-delivery') AS heartbeat_delivery_age,
      (SELECT heartbeat_delivery_error
         FROM private_monitor_state WHERE id = 1) AS heartbeat_delivery_error,
      (SELECT count(*)::text FROM private_monitor_check_failures
         WHERE recovered
           AND observed_at >= now() - interval '24 hours') AS check_recoveries_24h,
      (SELECT string_agg(key || ' ' || attempts::text, ', ' ORDER BY attempts DESC, key)
         FROM (
           SELECT key, count(*) AS attempts
             FROM private_monitor_check_failures
            WHERE recovered
              AND observed_at >= now() - interval '24 hours'
            GROUP BY key
            LIMIT 12
         ) AS recovered_checks) AS check_recovery_summary_24h,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(started_at)), 0)::int::text
         FROM reviews WHERE status = 'running') AS running_review_age,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(run_after)), 0)::int::text
         FROM jobs
        WHERE status = 'queued' AND run_after <= now()) AS queued_job_age,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(locked_at)), 0)::int::text
         FROM jobs WHERE status = 'running') AS running_job_age,
      (SELECT count(*)::text FROM jobs
         WHERE kind = 'check-run-cleanup'
           AND status = 'failed'
           AND run_after >= now() - interval '30 minutes') AS cleanup_failures,
      (SELECT count(*)::text FROM operator_alert_deliveries
         WHERE status = 'failed') AS email_failures,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)), 0)::int::text
         FROM operator_alert_deliveries WHERE status IN ('queued', 'retrying')) AS email_pending_age,
      (SELECT count(*)::text FROM billing_author_settlements
         WHERE status = 'failed') AS billing_settlement_failures,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)), 0)::int::text
         FROM billing_author_settlements
         WHERE status IN ('pending', 'charging', 'reconciling')) AS billing_settlement_age,
      (SELECT count(*)::text FROM billing_provider_events
         WHERE outcome = 'unmatched'
           AND occurred_at >= now() - interval '24 hours') AS unmatched_billing_events,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)), 0)::int::text
         FROM billing_checkout_transactions
         WHERE status IN ('creating', 'pending')) AS billing_checkout_age,
      (SELECT count(*)::text FROM billing_checkout_transactions
         WHERE status = 'failed'
           AND updated_at >= now() - interval '24 hours') AS billing_checkout_failures,
      (SELECT count(*)::text
         FROM self_service_trial_grants AS grant_row
         LEFT JOIN organization_entitlements AS entitlement ON entitlement.org_id = grant_row.org_id
         WHERE entitlement.org_id IS NULL) AS trial_entitlement_gaps,
      (SELECT count(*)::text
         FROM self_service_trial_grants AS grant_row
         WHERE NOT EXISTS (
           SELECT 1
             FROM operator_alert_deliveries AS delivery
            WHERE delivery.org_id = grant_row.org_id
              AND delivery.event = 'trial_started'
              AND delivery.status = 'delivered'
         )) AS trial_alert_gaps,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(received_at)), 0)::int::text
         FROM webhook_deliveries WHERE completed_at IS NULL) AS webhook_pending_age,
      (SELECT count(*)::text FROM github_webhook_delivery_recoveries
         WHERE request_state IN ('terminal', 'exhausted')
           AND updated_at >= now() - interval '30 minutes') AS webhook_terminal,
      (SELECT CASE
         WHEN EXISTS (SELECT 1 FROM installations WHERE suspended = false)
           THEN COALESCE(
             (SELECT EXTRACT(EPOCH FROM now() - last_page_at)::int::text
                FROM github_webhook_redelivery_state WHERE id = 1),
             '2147483647'
           )
         ELSE '0'
       END) AS webhook_scan_age,
      (SELECT last_error_category
         FROM github_webhook_redelivery_state WHERE id = 1) AS webhook_scan_error_category,
      (SELECT count(*)::text
         FROM reviews
         WHERE finished_at >= now() - interval '30 minutes'
           AND (
             (${OPERATIONAL_REVIEW_FAILURE_SQL})
             OR (status = 'completed' AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(envelope -> 'findings') = 'array'
                   THEN envelope -> 'findings' ELSE '[]'::jsonb END
               ) AS finding
               -- The CLI emits a provider sentinel with an exhausted scorer
               -- provider incident, and one operational sentinel with an
               -- unrecovered invalid-output incident. Collapse those exact
               -- pairs. A second operational sentinel represents another
               -- failure, such as incomplete coverage, and remains page-worthy.
               WHERE (
                    finding ->> 'path' = '.postil/operational'
                    AND (
                      NOT EXISTS (
                        SELECT 1 FROM jsonb_array_elements(
                          CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
                            THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
                        ) AS incident
                        WHERE incident ->> 'category' = 'invalidOutput'
                          AND incident ->> 'recovered' = 'false'
                      )
                      OR (
                        SELECT count(*) FROM jsonb_array_elements(
                          CASE WHEN jsonb_typeof(envelope -> 'findings') = 'array'
                            THEN envelope -> 'findings' ELSE '[]'::jsonb END
                        ) AS operational_finding
                        WHERE operational_finding ->> 'path' = '.postil/operational'
                      ) > 1
                    )
                  )
                  OR (
                    finding ->> 'path' = '.postil/provider'
                    AND NOT EXISTS (
                      SELECT 1 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
                          THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
                      ) AS incident
                      WHERE incident ->> 'phase' = 'scorer'
                        AND incident ->> 'category' = 'providerError'
                        AND incident ->> 'recovered' = 'false'
                    )
                  )
                  OR (
                    finding ->> 'path' = '.postil/model-output'
                    AND NOT EXISTS (
                      SELECT 1 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
                          THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
                      ) AS incident
                      WHERE incident ->> 'category' = 'invalidOutput'
                        AND incident ->> 'recovered' = 'false'
                    )
                  )
             ))
           )) AS operational_failures,
      (SELECT count(*)::text FROM reviews
         WHERE status = 'completed' AND finished_at >= now() - interval '30 minutes'
           AND (
             -- An invalid scorer output has the narrower alert below. Preserve
             -- every other typed scorer failure and untyped legacy error.
             EXISTS (
               SELECT 1 FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
                   THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
               ) AS incident
               WHERE incident ->> 'phase' = 'scorer' AND incident ->> 'recovered' = 'false'
                 AND (incident ->> 'category') IS DISTINCT FROM 'invalidOutput'
             )
             OR (
               NULLIF(btrim(envelope ->> 'scorerError'), '') IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
                     THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
                 ) AS incident
                 WHERE incident ->> 'phase' = 'scorer'
                   AND incident ->> 'recovered' = 'false'
               )
             )
           )) AS scorer_failures,
      (SELECT count(*)::text FROM reviews
         WHERE status = 'completed' AND finished_at >= now() - interval '30 minutes'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
                 THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
             ) AS incident
             WHERE incident ->> 'phase' = 'scorer' AND incident ->> 'recovery' = 'fallback'
           )) AS scorer_fallbacks,
      (SELECT count(*)::text FROM reviews
         WHERE status = 'completed' AND finished_at >= now() - interval '30 minutes'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
                 THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
             ) AS incident
             WHERE incident ->> 'phase' = 'review' AND incident ->> 'recovery' = 'fallback'
           )) AS model_fallbacks,
      -- Only output the run could not repair or fall back from. A recovered
      -- incident is the review pipeline working as designed, and the metrics
      -- endpoint still counts every observation for trend reporting.
      (SELECT count(*)::text FROM reviews
         WHERE status = 'completed' AND finished_at >= now() - interval '30 minutes'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(envelope -> 'modelIncidents') = 'array'
                 THEN envelope -> 'modelIncidents' ELSE '[]'::jsonb END
             ) AS incident
             WHERE incident ->> 'category' = 'invalidOutput'
               AND incident ->> 'recovered' = 'false'
           )) AS invalid_outputs,
      (SELECT count(*)::text FROM jobs
         WHERE status = 'failed'
           AND run_after >= now() - interval '30 minutes') AS failed_jobs
  `);
  const row = result.rows[0];
  if (!row) throw new Error("private monitoring database query returned no row");

  const age = (key: string) => numeric(row[key], key);
  const count = (key: string) => numeric(row[key], key);
  const thresholdCheck = (
    key: string,
    group: PrivateMonitoringGroup,
    severity: PrivateMonitoringSeverity,
    summary: string,
    value: number,
    threshold: number,
    unit: "count" | "seconds" = "count",
  ): PrivateMonitoringCheck => ({
    key,
    group,
    severity,
    healthy: value <= threshold,
    summary,
    detail: `${value.toLocaleString("en-US")} ${unit} observed; threshold ${threshold.toLocaleString("en-US")}.`,
  });

  const workerHeartbeat = row.worker_heartbeat_age === null
    ? Number.POSITIVE_INFINITY
    : age("worker_heartbeat_age");
  const heartbeatDelivery = row.heartbeat_delivery_age === null
    ? Number.POSITIVE_INFINITY
    : age("heartbeat_delivery_age");
  const heartbeatDeliveryError = row.heartbeat_delivery_error?.trim() || null;
  const checkRecoveries = count("check_recoveries_24h");
  const checkRecoverySummary = row.check_recovery_summary_24h?.trim() || null;
  return [
    {
      key: "monitor-heartbeat-delivery",
      group: "monitoring",
      severity: "critical",
      healthy:
        !externalHeartbeatConfigured ||
        heartbeatDelivery <= HEARTBEAT_DELIVERY_MAX_AGE_SECONDS,
      summary: "External dead-man heartbeat is accepted",
      detail: boundedDetail(
        !externalHeartbeatConfigured
          ? "No external heartbeat URL is configured."
          : `${
              Number.isFinite(heartbeatDelivery)
                ? `${heartbeatDelivery.toLocaleString("en-US")} seconds since the external heartbeat was accepted`
                : "No external heartbeat has ever been accepted"
            }; threshold ${HEARTBEAT_DELIVERY_MAX_AGE_SECONDS.toLocaleString("en-US")}.${
              heartbeatDeliveryError ? ` Last delivery result: ${heartbeatDeliveryError}` : ""
            }`,
      ),
    },
    {
      key: "check-flapping",
      group: "monitoring",
      severity: "warning",
      healthy: checkRecoveries <= CHECK_RECOVERY_FLAP_THRESHOLD,
      summary: "Checks pass without relying on retries",
      detail: boundedDetail(
        `${checkRecoveries.toLocaleString("en-US")} failed attempts recovered by retry in 24 hours; threshold ${CHECK_RECOVERY_FLAP_THRESHOLD.toLocaleString("en-US")}.${
          checkRecoverySummary ? ` Recovered attempts by check: ${checkRecoverySummary}.` : ""
        }`,
      ),
    },
    {
      key: "worker-heartbeat",
      group: "fleet",
      severity: "critical",
      healthy: workerHeartbeat <= workerHeartbeatMaxAgeSeconds,
      summary: "Review worker heartbeat is fresh",
      detail: Number.isFinite(workerHeartbeat)
        ? `${workerHeartbeat.toLocaleString("en-US")} seconds since the worker heartbeat; threshold ${workerHeartbeatMaxAgeSeconds.toLocaleString("en-US")}.`
        : "No worker heartbeat has been recorded.",
    },
    thresholdCheck("running-review-age", "queue", "critical", "Running reviews finish or recover", age("running_review_age"), 1_800, "seconds"),
    thresholdCheck("queued-job-age", "queue", "critical", "Queued work is claimed promptly", age("queued_job_age"), 1_800, "seconds"),
    thresholdCheck("running-job-age", "queue", "critical", "Claimed work reaches a terminal state", age("running_job_age"), 1_800, "seconds"),
    thresholdCheck("check-run-cleanup", "queue", "critical", "Recent GitHub check cleanup succeeds", count("cleanup_failures"), 0),
    thresholdCheck("operator-email-failures", "email", "critical", "Operator email has no unresolved delivery failure", count("email_failures"), 0),
    thresholdCheck("operator-email-delay", "email", "critical", "Operator email leaves the outbox promptly", age("email_pending_age"), 1_800, "seconds"),
    thresholdCheck("billing-settlement-failures", "billing", "critical", "Billing settlements have no unresolved failure", count("billing_settlement_failures"), 0),
    thresholdCheck("billing-settlement-delay", "billing", "warning", "Billing reconciliation remains current", age("billing_settlement_age"), 3_600, "seconds"),
    thresholdCheck("billing-unmatched-events", "billing", "critical", "Billing events map to an organization", count("unmatched_billing_events"), 0),
    thresholdCheck("billing-checkout-delay", "billing", "warning", "Billing checkout completes", age("billing_checkout_age"), 3_600, "seconds"),
    thresholdCheck("billing-checkout-failures", "billing", "warning", "Billing checkout requests succeed", count("billing_checkout_failures"), 0),
    thresholdCheck("trial-entitlement-gaps", "signup", "critical", "Trial signup grants an entitlement", count("trial_entitlement_gaps"), 0),
    thresholdCheck("trial-alert-gaps", "signup", "warning", "Trial signup reaches the private operator audit", count("trial_alert_gaps"), 0),
    thresholdCheck("webhook-dispatch-delay", "webhook", "critical", "Webhook deliveries dispatch", age("webhook_pending_age"), 1_800, "seconds"),
    thresholdCheck("webhook-recovery-terminal", "webhook", "critical", "Recent webhook recovery remains retryable", count("webhook_terminal"), 0),
    {
      key: "webhook-recovery-scan",
      group: "webhook",
      severity: "warning",
      healthy: row.webhook_scan_age !== null && age("webhook_scan_age") <= 1_800,
      summary: "Webhook recovery scan is fresh",
      detail: row.webhook_scan_age === null
        ? "No webhook recovery scan has been recorded for an active installation."
        : `${age("webhook_scan_age").toLocaleString("en-US")} seconds since the recovery scan; threshold 1,800.${
            row.webhook_scan_error_category
              ? ` Last scanner result: ${recoveryErrorLabel(row.webhook_scan_error_category)}.`
              : ""
          }`,
    },
    thresholdCheck("review-operational-failures", "provider", "critical", "Reviews complete without operational sentinels", count("operational_failures"), 0),
    // Model-quality incidents page only when they burst. One unrecovered
    // scorer or output failure in a window is a flaky upstream completion;
    // the sibling thresholds match the scheduled GitHub monitor.
    thresholdCheck("scorer-failures", "provider", "critical", "Scoring completes", count("scorer_failures"), 2),
    thresholdCheck("scorer-fallbacks", "provider", "warning", "Scoring avoids repeated fallback", count("scorer_fallbacks"), 2),
    thresholdCheck("model-fallbacks", "provider", "warning", "Review models avoid repeated fallback", count("model_fallbacks"), 5),
    thresholdCheck("invalid-model-output", "provider", "critical", "Model output validates", count("invalid_outputs"), 2),
    thresholdCheck("failed-jobs", "queue", "critical", "Queue jobs avoid terminal failure", count("failed_jobs"), 0),
  ];
}

export async function claimPrivateMonitoringNotifications(
  pool: Pool,
  owner: string,
  now = new Date(),
  limit = 20,
): Promise<PrivateMonitoringNotification[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("private monitoring notification claim limit must be in 1..100");
  }
  const leaseExpiresAt = new Date(now.getTime() + NOTIFICATION_LEASE_MS);
  const result = await pool.query<{
    key: string;
    notification_key: string;
    notification_kind: PrivateMonitoringNotification["kind"];
    group: PrivateMonitoringGroup;
    severity: PrivateMonitoringSeverity;
    summary: string;
    detail: string;
    first_detected_at: Date;
    last_detected_at: Date;
    resolved_at: Date | null;
    attempt: number;
  }>(
    `WITH candidates AS (
       SELECT key
         FROM private_monitor_incidents
        WHERE pending_notification_key IS NOT NULL
          AND COALESCE(notification_available_at, '-infinity'::timestamptz) <= $2
          AND COALESCE(notification_lease_expires_at, '-infinity'::timestamptz) <= $2
        ORDER BY notification_available_at NULLS FIRST, key
        LIMIT $3
        FOR UPDATE SKIP LOCKED
     )
     UPDATE private_monitor_incidents AS incident
        SET notification_lease_owner = $4,
            notification_lease_expires_at = $5,
            notification_attempts = CASE
              WHEN notification_attempts >= $1 THEN 1
              ELSE notification_attempts + 1
            END,
            updated_at = $2
       FROM candidates
      WHERE incident.key = candidates.key
      RETURNING incident.key,
                incident.pending_notification_key AS notification_key,
                incident.pending_notification_kind AS notification_kind,
                incident."group",
                incident.severity,
                incident.summary,
                incident.detail,
                incident.first_detected_at,
                incident.last_detected_at,
                incident.resolved_at,
                incident.notification_attempts AS attempt`,
    [MAX_NOTIFICATION_ATTEMPTS, now, limit, owner, leaseExpiresAt],
  );
  return result.rows.map((row) => ({
    incidentKey: row.key,
    notificationKey: row.notification_key,
    kind: row.notification_kind,
    capability: row.group,
    severity: row.severity,
    summary: row.notification_kind === "resolved"
      ? `${capabilityLabel(row.group)} recovered`
      : row.summary,
    detail: row.detail,
    firstObservedAt: row.first_detected_at,
    lastObservedAt: row.last_detected_at,
    resolvedAt: row.resolved_at,
    attempt: row.attempt,
  }));
}

export async function deliverPrivateMonitoringNotification(
  pool: Pool,
  notification: PrivateMonitoringNotification,
  input: {
    recipient: string;
    publicOrigin: string;
    transport?: OperatorNotificationTransport;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const dashboardUrl = new URL("/operator#monitoring", input.publicOrigin).toString();
  const content = privateMonitoringIncidentEmailContent(
    notification,
    dashboardUrl,
  );
  try {
    await sendOperatorNotification(
      {
        recipient: input.recipient,
        subject: `[${notification.severity}] Postil monitor: ${content.title}`,
        content,
        idempotencyKey: notification.notificationKey,
        incident: {
          key: notification.incidentKey,
          state: notification.kind === "resolved" ? "resolved" : "open",
          critical: notification.severity === "critical",
        },
      },
      input.transport ?? configuredMonitoringAlertTransport(),
    );
    await recordDeliveredNotification(pool, notification, now);
  } catch (error) {
    const delayMs =
      notification.attempt >= MAX_NOTIFICATION_ATTEMPTS
        ? NOTIFICATION_RETRY_EPOCH_COOLDOWN_MS
        : Math.min(
            60 * 60 * 1_000,
            30_000 * 2 ** (notification.attempt - 1),
          );
    await pool.query(
      `UPDATE private_monitor_incidents
          SET notification_available_at = $3,
              notification_lease_owner = NULL,
              notification_lease_expires_at = NULL,
              last_notification_error = $4,
              updated_at = $5
        WHERE key = $1 AND pending_notification_key = $2`,
      [
        notification.incidentKey,
        notification.notificationKey,
        new Date(now.getTime() + delayMs),
        boundedDetail(redactSecrets(error)),
        now,
      ],
    );
    throw error;
  }
}

async function recordDeliveredNotification(
  pool: Pool,
  notification: PrivateMonitoringNotification,
  now: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recorded = await client.query(
      `UPDATE private_monitor_incidents
          SET pending_notification_key = NULL,
              pending_notification_kind = NULL,
              notification_attempts = 0,
              notification_available_at = NULL,
              notification_lease_owner = NULL,
              notification_lease_expires_at = NULL,
              last_notified_at = $3,
              last_notification_error = NULL,
              updated_at = $3
        WHERE key = $1 AND pending_notification_key = $2`,
      [notification.incidentKey, notification.notificationKey, now],
    );
    if ((recorded.rowCount ?? 0) === 0 && notification.kind !== "resolved") {
      const resolutionKey = incidentNotificationKey(
        notification.incidentKey,
        "resolved",
        now,
      );
      await client.query(
        `UPDATE private_monitor_incidents
            SET pending_notification_key = $2,
                pending_notification_kind = 'resolved',
                notification_attempts = 0,
                notification_available_at = $3,
                notification_lease_owner = NULL,
                notification_lease_expires_at = NULL,
                last_notified_at = $3,
                last_notification_error = NULL,
                updated_at = $3
          WHERE key = $1
            AND state = 'resolved'
            AND pending_notification_key IS NULL`,
        [notification.incidentKey, resolutionKey, now],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function sendMonitorPassFailureNotification(input: {
  recipient: string;
  publicOrigin: string;
  bucket: Date;
  failureCount: number;
  observedAt: Date;
  transport?: OperatorNotificationTransport;
}): Promise<void> {
  const bucket = monitorPassAlertBucket(input.bucket);
  if (bucket.getTime() !== input.bucket.getTime()) {
    throw new Error("monitor pass alert bucket is not aligned");
  }
  const notificationKey = `postil-monitor-pass-failed-${bucket.toISOString()}`;
  await sendOperatorNotification(
    {
      recipient: input.recipient,
      subject: "[critical] Postil monitor: monitoring pass failed",
      content: privateMonitoringPassFailureEmailContent(
        input.publicOrigin,
        input.failureCount,
        input.observedAt,
      ),
      idempotencyKey: notificationKey,
      incident: { key: notificationKey, state: "open", critical: true },
    },
    input.transport ?? configuredMonitoringAlertTransport(),
  );
}

export function privateMonitoringIncidentEmailContent(
  notification: Pick<
    PrivateMonitoringNotification,
    | "incidentKey"
    | "kind"
    | "capability"
    | "severity"
    | "summary"
    | "detail"
    | "firstObservedAt"
    | "lastObservedAt"
    | "resolvedAt"
  >,
  dashboardUrl: string,
): TransactionalEmailContent {
  const resolved = notification.kind === "resolved";
  const stateLabel = resolved ? "Resolved" : "Open";
  const title = notification.summary;
  const lastObservedAt = notification.resolvedAt ?? notification.lastObservedAt;
  return {
    preheader: resolved
      ? `${title}. The incident is resolved.`
      : `${title}. ${capabilityLabel(notification.capability)} is affected.`,
    category: "Production monitor",
    title,
    summary: notification.kind === "resolved"
      ? `${capabilityLabel(notification.capability)} has recovered.`
      : `${capabilityLabel(notification.capability)} needs operator attention.`,
    reason: "This address is configured to receive Postil production alerts.",
    details: [
      { label: "Affected capability", value: capabilityLabel(notification.capability) },
      { label: "State", value: stateLabel },
      { label: "Severity", value: notification.severity },
      { label: "First observed", value: formatMonitoringTimestamp(notification.firstObservedAt) },
      { label: "Last observed", value: formatMonitoringTimestamp(lastObservedAt) },
      { label: "Evidence", value: boundedDetail(notification.detail) },
      {
        label: "Recommended action",
        value: resolved
          ? "No action is required. Open private monitoring for retained evidence."
          : incidentRecommendedAction(notification.incidentKey),
      },
    ],
    action: { label: "Open private monitoring", url: dashboardUrl },
    note: "Operational alerts are private and do not appear in organization member notifications.",
    intent:
      notification.kind === "resolved"
        ? "success"
        : notification.severity === "critical"
          ? "critical"
          : "warning",
  };
}

export function privateMonitoringPassFailureEmailContent(
  publicOrigin: string,
  failureCount = 2,
  observedAt = new Date(),
): TransactionalEmailContent {
  return {
    preheader: "The private production monitor could not complete its health checks.",
    category: "Production monitor",
    title: "Monitoring pass failed",
    summary: "Production health could not be fully evaluated.",
    reason: "This address is configured to receive Postil production alerts.",
    details: [
      { label: "Affected capability", value: "Private production monitoring" },
      { label: "State", value: "Open" },
      { label: "First observed", value: formatMonitoringTimestamp(observedAt) },
      { label: "Last observed", value: formatMonitoringTimestamp(observedAt) },
      {
        label: "Evidence",
        value: `${failureCount.toLocaleString("en-US")} consecutive monitor passes did not complete.`,
      },
      {
        label: "Recommended action",
        value: "Open private monitoring and inspect the failed pass before changing production state.",
      },
    ],
    action: {
      label: "Open private monitoring",
      url: new URL("/operator#monitoring", publicOrigin).toString(),
    },
    note: "This alert bypasses the database incident outbox when the monitor cannot record a normal incident.",
    intent: "critical",
  };
}

export function monitorPassAlertBucket(now: Date): Date {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("monitor pass alert time is invalid");
  }
  return new Date(
    Math.floor(timestamp / MONITOR_PASS_ALERT_BUCKET_MS) *
      MONITOR_PASS_ALERT_BUCKET_MS,
  );
}

export function recordMonitorPassFailure(
  state: MonitorPassFailureState,
  now: Date,
  alertAfterFailures = 2,
): { state: MonitorPassFailureState; shouldAlert: boolean } {
  if (!Number.isSafeInteger(alertAfterFailures) || alertAfterFailures < 1) {
    throw new Error("monitor pass alert threshold must be a positive integer");
  }
  const bucket = monitorPassAlertBucket(now);
  const sameBucket = state.bucket?.getTime() === bucket.getTime();
  const failuresInBucket = sameBucket ? state.failuresInBucket + 1 : 1;
  return {
    state: {
      bucket,
      failuresInBucket,
      lastAlertBucket: state.lastAlertBucket,
    },
    shouldAlert:
      failuresInBucket >= alertAfterFailures &&
      state.lastAlertBucket?.getTime() !== bucket.getTime(),
  };
}

export function markMonitorPassAlertSent(
  state: MonitorPassFailureState,
): MonitorPassFailureState {
  if (!state.bucket) {
    throw new Error("monitor pass alert cannot be recorded without a bucket");
  }
  return { ...state, lastAlertBucket: state.bucket };
}

export function recordMonitorPassSuccess(
  state: MonitorPassFailureState,
): MonitorPassFailureState {
  return {
    bucket: null,
    failuresInBucket: 0,
    lastAlertBucket: state.lastAlertBucket,
  };
}

function incidentTitle(check: PrivateMonitoringCheck): string {
  const titles: Record<string, string> = {
    "public-site": "Public site is unavailable",
    "public-liveness": "Web liveness check failed",
    "public-sitemap": "Sitemap is unavailable",
    "public-favicon": "Favicon is unavailable",
    "public-dependencies": "Web dependencies are unavailable",
    "public-robots": "Robots policy is invalid",
    "redirect-about": "Legacy route redirect is broken",
    "redirect-www": "Canonical host redirect is broken",
    "noindex-login": "Login page indexing protection is missing",
    "noindex-api-health": "Health endpoint indexing protection is missing",
    "worker-heartbeat": "Review worker heartbeat is stale",
    "running-review-age": "A review is stuck running",
    "queued-job-age": "Queued work is not being claimed",
    "running-job-age": "Claimed work is stuck",
    "check-run-cleanup": "GitHub check cleanup is failing",
    "operator-email-failures": "Operator email delivery is failing",
    "operator-email-delay": "Operator email delivery is delayed",
    "billing-settlement-failures": "Billing settlement is failing",
    "billing-settlement-delay": "Billing reconciliation is delayed",
    "billing-unmatched-events": "A billing event is unmatched",
    "billing-checkout-delay": "Billing checkout is delayed",
    "billing-checkout-failures": "Billing checkout is failing",
    "trial-entitlement-gaps": "A trial is missing its entitlement",
    "trial-alert-gaps": "A trial operator alert is missing",
    "webhook-dispatch-delay": "Webhook dispatch is delayed",
    "webhook-recovery-terminal": "Webhook recovery reached a terminal state",
    "webhook-recovery-scan": "Webhook recovery scan is stale",
    "review-operational-failures": "Review operations are failing",
    "scorer-failures": "Finding scoring is failing",
    "scorer-fallbacks": "Finding scoring is repeatedly falling back",
    "model-fallbacks": "Review models are repeatedly falling back",
    "invalid-model-output": "Model output is invalid",
    "monitor-heartbeat-delivery": "Monitor heartbeat delivery is failing",
    "check-flapping": "Monitoring checks are flapping",
    "openrouter-monitoring-configuration": "OpenRouter cap monitoring needs configuration",
    "openrouter-keys-metadata": "OpenRouter key metadata is unavailable",
    "openrouter-credits-metadata": "OpenRouter account credit metadata is unavailable",
    "openrouter-account-balance": "OpenRouter account balance is near exhaustion",
    "openrouter-development-daily-cap": "Development review key is near its daily cap",
    "openrouter-production-daily-cap": "Production review key is near its daily cap",
    "openrouter-emergency-configuration": "Emergency review key configuration changed",
    "openrouter-emergency-unused": "Emergency review key has usage",
    "failed-jobs": "Queue jobs are failing",
  };
  return titles[check.key] ?? `${check.summary}: check failed`;
}

function capabilityLabel(capability: PrivateMonitoringGroup): string {
  return {
    availability: "Public web availability",
    billing: "Billing operations",
    email: "Operator email delivery",
    fleet: "Review worker fleet",
    monitoring: "Production monitoring",
    provider: "Review inference",
    queue: "Review job processing",
    signup: "Customer signup",
    webhook: "GitHub webhook processing",
  }[capability];
}

function incidentRecommendedAction(key: string): string {
  if (key.startsWith("public-") || key.startsWith("redirect-") || key.startsWith("noindex-")) {
    return "Open private monitoring, verify the affected public endpoint, and inspect the web process if the check remains open.";
  }
  if (key === "webhook-recovery-scan") {
    return "Inspect the recovery cursor and its latest bounded response error before retrying the scan.";
  }
  if (key.startsWith("webhook-")) {
    return "Inspect webhook delivery and recovery state, then confirm GitHub delivery processing reaches a terminal state.";
  }
  if (key.startsWith("billing-") || key.startsWith("trial-")) {
    return "Inspect the private billing or signup ledger and reconcile the affected record before changing customer access.";
  }
  if (key.startsWith("operator-email-")) {
    return "Inspect the private delivery audit and Brevo API result, then retry the affected message through the normal outbox.";
  }
  if (key.includes("scorer") || key.includes("model") || key === "review-operational-failures") {
    return "Inspect recent private review runs and provider incidents, then verify the configured route before changing model policy.";
  }
  if (key.startsWith("openrouter-")) {
    return "Restore the private management credential and three exact key-name bindings if needed, inspect sanitized OpenRouter metadata, and verify the emergency key remains outside every inference binding.";
  }
  if (key === "worker-heartbeat") {
    return "Inspect the worker process and heartbeat before restarting or replacing a machine.";
  }
  if (key === "monitor-heartbeat-delivery") {
    return "Confirm the alerting account still accepts heartbeat pings and the configured heartbeat URL is current; until then a dead monitor cannot page.";
  }
  if (key === "check-flapping") {
    return "Open private monitoring and read the retained failed attempts before treating the affected checks as healthy.";
  }
  return "Open private monitoring, inspect the affected run and queue state, and preserve evidence before retrying work.";
}

function formatMonitoringTimestamp(value: Date): string {
  return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function recoveryErrorLabel(category: string): string {
  return {
    aborted: "scan cancelled",
    api: "GitHub API rejected the request",
    invalid_cursor: "saved cursor rejected",
    invalid_pagination: "pagination rejected",
    invalid_response: "GitHub response did not match the recovery contract",
    oversized_response: "GitHub response exceeded the size limit",
    rate_limited: "GitHub API rate limited",
    transport: "GitHub API transport failed",
  }[category] ?? "recovery scan failed";
}

async function reconcileCheck(
  client: PoolClient,
  check: PrivateMonitoringCheck,
  now: Date,
): Promise<void> {
  const existing = await client.query<{
    state: "open" | "resolved";
    detail: string;
    opened_detail: string | null;
    occurrence_count: number;
    first_detected_at: Date;
    last_notified_at: Date | null;
    pending_notification_key: string | null;
    notification_lease_expires_at: Date | null;
  }>(
    `SELECT state, detail, opened_detail, occurrence_count, first_detected_at,
            last_notified_at, pending_notification_key,
            notification_lease_expires_at
       FROM private_monitor_incidents
      WHERE key = $1
      FOR UPDATE`,
    [check.key],
  );
  const row = existing.rows[0];

  if (!check.healthy && !row) {
    const notificationKey = incidentNotificationKey(check.key, "opened", now);
    await client.query(
      `INSERT INTO private_monitor_incidents
         (key, "group", severity, summary, detail, opened_detail, state,
          occurrence_count, first_detected_at, last_detected_at,
          pending_notification_key, pending_notification_kind,
          notification_available_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, 'open', 1, $6, $6, $7, 'opened', $6, $6)`,
      [
        check.key,
        check.group,
        check.severity,
        incidentTitle(check),
        boundedDetail(check.detail),
        now,
        notificationKey,
      ],
    );
    await recordIncidentEvent(client, check, "opened", {
      detail: check.detail,
      occurrenceCount: 1,
      firstDetectedAt: now,
      occurredAt: now,
    });
    await broadcastCustomerServiceTransition(client, check.key, "opened", now, now);
    return;
  }

  if (!row) return;
  if (!check.healthy) {
    const reopened = row.state === "resolved";
    const reminderDue =
      row.state === "open" &&
      row.pending_notification_key === null &&
      row.last_notified_at !== null &&
      now.getTime() - row.last_notified_at.getTime() >= INCIDENT_REMINDER_MS;
    const notificationKind = reopened ? "opened" : reminderDue ? "reminder" : null;
    const notificationKey = notificationKind
      ? incidentNotificationKey(check.key, notificationKind, now)
      : null;
    await client.query(
      `UPDATE private_monitor_incidents
          SET "group" = $2,
              severity = $3,
              summary = $4,
              detail = $5,
              opened_detail = CASE WHEN $6 OR opened_detail IS NULL THEN $5 ELSE opened_detail END,
              state = 'open',
              occurrence_count = CASE WHEN $6 THEN 1 ELSE occurrence_count + 1 END,
              first_detected_at = CASE WHEN $6 THEN $7 ELSE first_detected_at END,
              last_detected_at = $7,
              resolved_at = NULL,
              pending_notification_key = COALESCE($8, pending_notification_key),
              pending_notification_kind = COALESCE($9, pending_notification_kind),
              notification_attempts = CASE WHEN $8 IS NULL THEN notification_attempts ELSE 0 END,
              notification_available_at = CASE WHEN $8 IS NULL THEN notification_available_at ELSE $7 END,
              notification_lease_owner = CASE WHEN $8 IS NULL THEN notification_lease_owner ELSE NULL END,
              notification_lease_expires_at = CASE WHEN $8 IS NULL THEN notification_lease_expires_at ELSE NULL END,
              last_notified_at = CASE WHEN $6 THEN NULL ELSE last_notified_at END,
              last_notification_error = CASE WHEN $8 IS NULL THEN last_notification_error ELSE NULL END,
              updated_at = $7
        WHERE key = $1`,
      [
        check.key,
        check.group,
        check.severity,
        incidentTitle(check),
        boundedDetail(check.detail),
        reopened,
        now,
        notificationKey,
        notificationKind,
      ],
    );
    if (reopened) {
      await recordIncidentEvent(client, check, "opened", {
        detail: check.detail,
        occurrenceCount: 1,
        firstDetectedAt: now,
        occurredAt: now,
      });
      await broadcastCustomerServiceTransition(client, check.key, "opened", now, now);
    }
    return;
  }

  if (row.state === "resolved") return;
  if (
    row.pending_notification_key !== null &&
    row.notification_lease_expires_at !== null &&
    row.notification_lease_expires_at > now
  ) {
    return;
  }
  const notifyResolution = row.last_notified_at !== null;
  const notificationKey = notifyResolution
    ? incidentNotificationKey(check.key, "resolved", now)
    : null;
  await client.query(
    `UPDATE private_monitor_incidents
        SET "group" = $2,
            severity = $3,
            summary = $4,
            detail = $5,
            state = 'resolved',
            resolved_at = $6::timestamptz,
            pending_notification_key = $7::text,
            pending_notification_kind = CASE WHEN $7::text IS NULL THEN NULL ELSE 'resolved' END,
            notification_attempts = 0,
            notification_available_at = CASE WHEN $7::text IS NULL THEN NULL ELSE $6::timestamptz END,
            notification_lease_owner = NULL,
            notification_lease_expires_at = NULL,
            last_notification_error = NULL,
            updated_at = $6::timestamptz
      WHERE key = $1`,
    [
      check.key,
      check.group,
      check.severity,
      incidentTitle(check),
      boundedDetail(check.detail),
      now,
      notificationKey,
    ],
  );
  await recordIncidentEvent(client, check, "resolved", {
    detail: row.opened_detail ?? row.detail,
    occurrenceCount: row.occurrence_count,
    firstDetectedAt: row.first_detected_at,
    occurredAt: now,
  });
  await broadcastCustomerServiceTransition(
    client,
    check.key,
    "resolved",
    row.first_detected_at,
    now,
  );
}

async function recordIncidentEvent(
  client: PoolClient,
  check: PrivateMonitoringCheck,
  transition: "opened" | "resolved",
  event: {
    detail: string;
    occurrenceCount: number;
    firstDetectedAt: Date;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO private_monitor_incident_events
       (key, "group", severity, transition, summary, detail, occurrence_count,
        first_detected_at, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      check.key,
      check.group,
      check.severity,
      transition,
      incidentTitle(check),
      boundedDetail(event.detail),
      Math.max(1, event.occurrenceCount),
      event.firstDetectedAt,
      event.occurredAt,
    ],
  );
}

/**
 * Persists every failed attempt of the pass. An unhealthy check contributes
 * its final evidence; a check that recovered through retry contributes only
 * the attempts that failed, flagged as recovered.
 */
async function recordCheckFailures(
  client: PoolClient,
  runId: number,
  checks: readonly PrivateMonitoringCheck[],
  now: Date,
): Promise<void> {
  const rows: Array<[string, number, boolean, string]> = [];
  for (const check of checks) {
    const attemptFailures = check.attemptFailures ?? [];
    attemptFailures.forEach((detail, index) => {
      rows.push([check.key, index + 1, check.healthy, boundedDetail(detail)]);
    });
    if (!check.healthy) {
      rows.push([
        check.key,
        check.attempts ?? attemptFailures.length + 1,
        false,
        boundedDetail(check.detail),
      ]);
    }
  }
  for (const [key, attempt, recovered, detail] of rows) {
    await client.query(
      `INSERT INTO private_monitor_check_failures
         (run_id, key, attempt, recovered, detail, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, key, attempt, recovered, detail, now],
    );
  }
}

function customerServiceIncidentKey(key: string): CustomerServiceIncidentKey | null {
  return key === "public-site" ||
      key === "public-liveness" ||
      key === "public-dependencies" ||
      key === "worker-heartbeat"
    ? key
    : null;
}

async function broadcastCustomerServiceTransition(
  client: PoolClient,
  incidentKey: string,
  transition: "opened" | "resolved",
  firstObservedAt: Date,
  now: Date,
): Promise<void> {
  const customerIncidentKey = customerServiceIncidentKey(incidentKey);
  if (!customerIncidentKey) return;
  await enqueueCustomerServiceTransitionForAllOrganizationsSql(
    client,
    { incidentKey: customerIncidentKey, transition, firstObservedAt },
    now,
  );
}

async function probeWithRetry(input: {
  key: string;
  summary: string;
  severity: PrivateMonitoringSeverity;
  url: URL;
  init: RequestInit;
  evaluate: (attempt: ProbeAttempt) => ProbeEvaluation;
  fetchImpl: Fetch;
  options: PublicProbeOptions;
}): Promise<PrivateMonitoringCheck> {
  const sleep = input.options.sleep ?? defaultSleep;
  const attemptFailures: string[] = [];
  const maxAttempts = PUBLIC_PROBE_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let outcome: { evaluation: ProbeEvaluation; transient: boolean };
    try {
      const response = await input.fetchImpl(input.url, {
        ...input.init,
        cache: "no-store",
        headers: { "cache-control": "no-cache", "user-agent": "postil-private-monitor/1" },
        signal: AbortSignal.timeout(PUBLIC_PROBE_TIMEOUT_MS),
      });
      const body = await readProbeBody(response);
      const evaluation = input.evaluate({ response, body });
      outcome = {
        evaluation,
        transient: !evaluation.healthy && TRANSIENT_PUBLIC_PROBE_STATUSES.has(response.status),
      };
    } catch (error) {
      outcome = {
        evaluation: { healthy: false, detail: requestFailure(input.url, error) },
        transient: true,
      };
    }
    const detail = boundedDetail(outcome.evaluation.detail);
    if (outcome.evaluation.healthy) {
      return {
        key: input.key,
        group: "availability",
        severity: input.severity,
        healthy: true,
        summary: input.summary,
        detail: boundedDetail(
          attemptFailures.length === 0
            ? detail
            : `${detail} Recovered on attempt ${attempt} after: ${attemptFailures[0]}`,
        ),
        attempts: attempt,
        attemptFailures,
      };
    }
    const retryDelay = PUBLIC_PROBE_RETRY_DELAYS_MS[attempt - 1];
    if (!outcome.transient || retryDelay === undefined) {
      return {
        key: input.key,
        group: "availability",
        severity: input.severity,
        healthy: false,
        summary: input.summary,
        detail: boundedDetail(
          attemptFailures.length === 0
            ? detail
            : `${detail} Failed ${attempt} attempts; first: ${attemptFailures[0]}`,
        ),
        attempts: attempt,
        attemptFailures,
      };
    }
    attemptFailures.push(detail);
    await sleep(retryDelay);
  }
  throw new Error("probe retry loop exited without a result");
}

/**
 * Reads a bounded body so the connection returns to the pool and semantic
 * probes can inspect content. A body that cannot be read is not a failure
 * on its own; the evaluator decides from the status and headers.
 */
async function readProbeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, PUBLIC_PROBE_BODY_LIMIT);
  } catch {
    return "";
  }
}

function evaluateDependencies(url: URL, attempt: ProbeAttempt): ProbeEvaluation {
  let healthy = attempt.response.ok;
  try {
    const parsed = JSON.parse(attempt.body.slice(0, 4_096)) as { ok?: unknown; database?: unknown };
    healthy = healthy && parsed.ok === true && parsed.database === "up";
  } catch {
    healthy = false;
  }
  return {
    healthy,
    detail: `${url.toString()} returned HTTP ${attempt.response.status} with ${healthy ? "healthy" : "invalid"} readiness data.`,
  };
}

function evaluateRobots(origin: URL, url: URL, attempt: ProbeAttempt): ProbeEvaluation {
  const body = attempt.body;
  const healthy =
    attempt.response.ok &&
    !/^Disallow:/m.test(body) &&
    /^User-Agent: \*$/m.test(body) &&
    /^Allow: \/$/m.test(body) &&
    body.includes(`Sitemap: ${new URL("/sitemap.xml", origin).toString()}`);
  return {
    healthy,
    detail: `${url.toString()} returned HTTP ${attempt.response.status} with ${healthy ? "expected" : "unexpected"} directives.`,
  };
}

function evaluateRedirect(url: URL, expected: URL, attempt: ProbeAttempt): ProbeEvaluation {
  const location = attempt.response.headers.get("location");
  const actual = location ? new URL(location, url).toString() : "missing";
  return {
    healthy: attempt.response.status === 308 && actual === expected.toString(),
    detail: `${url.toString()} returned HTTP ${attempt.response.status} to ${actual}; expected ${expected.toString()}.`,
  };
}

function evaluateNoIndex(url: URL, attempt: ProbeAttempt): ProbeEvaluation {
  const value = attempt.response.headers.get("x-robots-tag")?.toLowerCase() ?? "missing";
  return {
    healthy: attempt.response.ok && value === "noindex, nofollow",
    detail: `${url.toString()} returned HTTP ${attempt.response.status} with X-Robots-Tag ${value}.`,
  };
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestFailure(url: URL, error: unknown): string {
  return boundedDetail(`${url.toString()} request failed: ${redactSecrets(error)}`);
}

function validateCheckSet(checks: readonly PrivateMonitoringCheck[]): void {
  if (checks.length === 0 || checks.length > 100) {
    throw new Error("private monitoring pass must contain 1..100 checks");
  }
  const keys = new Set<string>();
  for (const check of checks) {
    if (!SAFE_COMPONENT.test(check.key) || keys.has(check.key)) {
      throw new Error("private monitoring check keys must be unique safe labels");
    }
    keys.add(check.key);
    if (!check.summary.trim() || check.summary.length > 200) {
      throw new Error("private monitoring check summary is malformed");
    }
    if (!check.detail.trim() || check.detail.length > MAX_DETAIL_CHARS) {
      throw new Error("private monitoring check detail is malformed");
    }
    const attemptFailures = check.attemptFailures ?? [];
    const attempts = check.attempts ?? attemptFailures.length + 1;
    if (
      !Number.isSafeInteger(attempts) ||
      attempts < 1 ||
      attempts > 10 ||
      attemptFailures.length >= attempts ||
      attemptFailures.some((detail) => !detail.trim() || detail.length > MAX_DETAIL_CHARS)
    ) {
      throw new Error("private monitoring check attempts are malformed");
    }
  }
}

function incidentNotificationKey(
  key: string,
  kind: PrivateMonitoringNotification["kind"],
  at: Date,
): string {
  return `postil-monitor-${createHash("sha256")
    .update(`${key}\0${kind}\0${at.toISOString()}`)
    .digest("hex")}`;
}

function boundedDetail(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, MAX_DETAIL_CHARS);
}

function numeric(value: string | null | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`private monitoring metric ${name} is invalid`);
  }
  return parsed;
}
