import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { Pool } from "pg";

import { createEphemeralDatabase, type EphemeralDatabase } from "./ephemeral-database";
import type {
  OperatorNotification,
  OperatorNotificationTransport,
} from "@/lib/operator-notifications";
import { runOpenRouterCapMonitoringChecks } from "@/lib/openrouter-cap-monitoring";
import { NON_OPERATIONAL_REVIEW_FAILURE_MESSAGES } from "@/lib/review-outcome";
import {
  acquirePrivateMonitorLease,
  claimPrivateMonitoringNotifications,
  deliverPrivateMonitoringNotification,
  finishPrivateMonitoringPass,
  getPrivateMonitoringDashboard,
  markMonitorPassAlertSent,
  monitorPassAlertBucket,
  recordMonitorPassFailure,
  recordMonitorPassSuccess,
  recordServiceHeartbeat,
  runDatabaseMonitoringChecks,
  runPublicMonitoringChecks,
  sendMonitorPassFailureNotification,
  startPrivateMonitoringPass,
  type MonitorPassFailureState,
  type PrivateMonitoringCheck,
} from "@/lib/private-monitoring";

const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;
const NOW = new Date("2026-07-19T12:00:00.000Z");
const BUCKET = new Date("2026-07-19T12:00:00.000Z");

describe("private monitoring public probes", () => {
  test("alerts once in every six-hour database-outage bucket", () => {
    let state: MonitorPassFailureState = {
      bucket: null,
      failuresInBucket: 0,
      lastAlertBucket: null,
    };
    let failure = recordMonitorPassFailure(state, NOW);
    expect(failure.shouldAlert).toBe(false);
    failure = recordMonitorPassFailure(failure.state, new Date(NOW.getTime() + 1_000));
    expect(failure.shouldAlert).toBe(true);
    state = markMonitorPassAlertSent(failure.state);

    failure = recordMonitorPassFailure(state, new Date(NOW.getTime() + 2_000));
    expect(failure.shouldAlert).toBe(false);
    state = recordMonitorPassSuccess(failure.state);
    failure = recordMonitorPassFailure(state, new Date(NOW.getTime() + 3_000));
    failure = recordMonitorPassFailure(failure.state, new Date(NOW.getTime() + 4_000));
    expect(failure.shouldAlert).toBe(false);

    const nextBucket = new Date(NOW.getTime() + 6 * 60 * 60 * 1_000);
    failure = recordMonitorPassFailure(failure.state, nextBucket);
    expect(failure.shouldAlert).toBe(false);
    failure = recordMonitorPassFailure(
      failure.state,
      new Date(nextBucket.getTime() + 1_000),
    );
    expect(failure.shouldAlert).toBe(true);
  });

  test("sends monitor-pass alerts without the database outbox", async () => {
    const sent: OperatorNotification[] = [];
    const bucket = monitorPassAlertBucket(NOW);
    await sendMonitorPassFailureNotification({
      recipient: "operator@example.test",
      publicOrigin: "https://postil.dev",
      bucket,
      failureCount: 2,
      observedAt: NOW,
      transport: {
        async send(notification) {
          sent.push(notification);
          return { messageId: "monitor-alert" };
        },
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.idempotencyKey).toContain(bucket.toISOString());
    expect(sent[0]?.content.title).toBe("Monitoring pass failed");
    expect(sent[0]?.content.details).toContainEqual({
      label: "Evidence",
      value: "2 consecutive monitor passes did not complete.",
    });
    expect(sent[0]?.content.details).toContainEqual({
      label: "Affected capability",
      value: "Private production monitoring",
    });
    expect(sent[0]?.content.summary).not.toContain("GitHub");

    expect(
      monitorPassAlertBucket(new Date(bucket.getTime() + 1_000)).getTime(),
    ).toBe(bucket.getTime());
    expect(
      monitorPassAlertBucket(
        new Date(bucket.getTime() + 6 * 60 * 60 * 1_000),
      ).getTime(),
    ).not.toBe(bucket.getTime());
  });

  test("keeps operational probe results inside the service", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.hostname === "www.postil.dev") {
        return new Response(null, {
          status: 308,
          headers: { location: `https://postil.dev${url.pathname}${url.search}` },
        });
      }
      if (url.pathname === "/about") {
        return new Response(null, {
          status: 308,
          headers: { location: "/why-postil" },
        });
      }
      if (url.pathname === "/robots.txt") {
        return new Response(
          "User-Agent: *\nAllow: /\nSitemap: https://postil.dev/sitemap.xml\n",
        );
      }
      if (url.pathname === "/api/health/dependencies") {
        return Response.json({ ok: true, database: "up" });
      }
      const headers = ["/login", "/api/health"].includes(url.pathname)
        ? { "x-robots-tag": "noindex, nofollow" }
        : undefined;
      return new Response("ok", { status: 200, headers });
    };

    const checks = await runPublicMonitoringChecks("https://postil.dev", fetchImpl);
    expect(checks).toHaveLength(10);
    expect(checks.every((check) => check.healthy)).toBe(true);
    expect(calls).toContain("https://postil.dev/api/health/dependencies");
    expect(calls).toContain("https://www.postil.dev/docs?utm_source=monitor");
  });

  test("turns a failed request into a bounded private incident input", async () => {
    const checks = await runPublicMonitoringChecks(
      "https://example.test",
      async (input) => {
        if (String(input).endsWith("/api/health/dependencies")) {
          throw new Error("simulated dependency failure");
        }
        if (String(input).endsWith("/about")) {
          return new Response(null, {
            status: 308,
            headers: { location: "https://example.test/why-postil" },
          });
        }
        if (String(input).endsWith("/robots.txt")) {
          return new Response(
            "User-Agent: *\nAllow: /\nSitemap: https://example.test/sitemap.xml\n",
          );
        }
        return new Response("ok", {
          headers: { "x-robots-tag": "noindex, nofollow" },
        });
      },
    );
    const failed = checks.find((check) => check.key === "public-dependencies");
    expect(failed).toMatchObject({ healthy: false, severity: "critical" });
    expect(failed?.detail.length).toBeLessThanOrEqual(1_000);
  });
});

describeDb("private monitoring durability", () => {
  let db: EphemeralDatabase;
  let pool: Pool;

  beforeAll(
    async () => {
      db = await createEphemeralDatabase("private_monitoring");
      pool = db.pool;
    },
    30_000,
  );

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE private_monitor_incidents, private_monitor_runs, private_monitor_state, service_heartbeats RESTART IDENTITY",
    );
    await pool.query(
      "TRUNCATE customer_notification_events, organizations RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  test("allows one monitor owner and one pass per schedule bucket", async () => {
    const acquired = await Promise.all([
      acquirePrivateMonitorLease(pool, "monitor-a", NOW),
      acquirePrivateMonitorLease(pool, "monitor-b", NOW),
    ]);
    expect(acquired.filter(Boolean)).toHaveLength(1);

    const [first, duplicate] = await Promise.all([
      startPrivateMonitoringPass(pool, "monitor-a", BUCKET, NOW),
      startPrivateMonitoringPass(pool, "monitor-b", BUCKET, NOW),
    ]);
    expect([first, duplicate].filter(Boolean)).toHaveLength(1);
  });

  test("retains a key-cap incident and sends it only through private operator delivery", async () => {
    const keyNames = {
      development: "development-fixture",
      production: "production-fixture",
      emergency: "emergency-fixture",
    };
    const metadata = (name: string, remaining = 20) => ({
      name,
      disabled: false,
      limit: 30,
      limit_remaining: remaining,
      limit_reset: "daily",
      usage: name === keyNames.emergency ? 0 : 10,
      usage_daily: name === keyNames.emergency ? 0 : 10,
      usage_weekly: name === keyNames.emergency ? 0 : 10,
      usage_monthly: name === keyNames.emergency ? 0 : 10,
      byok_usage: 0,
      byok_usage_daily: 0,
      byok_usage_weekly: 0,
      byok_usage_monthly: 0,
      hash: "must-not-be-retained",
    });
    const checks = await runOpenRouterCapMonitoringChecks({
      managementKey: "must-not-be-retained",
      keyNames,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        return url.pathname === "/api/v1/keys"
          ? Response.json({
              data: [
                metadata(keyNames.development, 0.5),
                metadata(keyNames.production),
                metadata(keyNames.emergency),
              ],
            })
          : Response.json({ data: { total_credits: 100, total_usage: 10 } });
      },
    });
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", NOW)).toBe(true);
    const pass = await startPrivateMonitoringPass(pool, "monitor-a", BUCKET, NOW);
    await finishPrivateMonitoringPass(pool, pass!, checks, NOW);

    const notifications = await claimPrivateMonitoringNotifications(
      pool,
      "monitor-a",
      NOW,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      incidentKey: "openrouter-development-daily-cap",
      capability: "provider",
      severity: "critical",
      kind: "opened",
    });
    const sent: OperatorNotification[] = [];
    await deliverPrivateMonitoringNotification(pool, notifications[0]!, {
      recipient: "operator@example.test",
      publicOrigin: "https://postil.dev",
      transport: {
        async send(notification) {
          sent.push(notification);
          return { messageId: "private-openrouter-alert" };
        },
      },
      now: NOW,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content.action?.url).toBe(
      "https://postil.dev/operator#monitoring",
    );
    expect(JSON.stringify(sent)).not.toContain("must-not-be-retained");

    const dashboard = await getPrivateMonitoringDashboard(pool);
    expect(dashboard.incidents).toContainEqual(
      expect.objectContaining({
        key: "openrouter-development-daily-cap",
        state: "open",
        notificationAttempts: 0,
      }),
    );
  });

  test("retains one private auth incident when OpenRouter rejects configured monitoring", async () => {
    const checks = await runOpenRouterCapMonitoringChecks({
      managementKey: "rejected-management-fixture",
      keyNames: {
        development: "development-fixture",
        production: "production-fixture",
        emergency: "emergency-fixture",
      },
      fetchImpl: async () =>
        new Response("untrusted-provider-body", { status: 401 }),
    });
    expect(checks).toHaveLength(1);
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", NOW)).toBe(true);
    const pass = await startPrivateMonitoringPass(pool, "monitor-a", BUCKET, NOW);
    await finishPrivateMonitoringPass(pool, pass!, checks, NOW);

    const notifications = await claimPrivateMonitoringNotifications(
      pool,
      "monitor-a",
      NOW,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      incidentKey: "openrouter-monitoring-configuration",
      kind: "opened",
      capability: "provider",
    });
    const dashboard = await getPrivateMonitoringDashboard(pool);
    expect(dashboard.incidents).toContainEqual(
      expect.objectContaining({
        key: "openrouter-monitoring-configuration",
        state: "open",
        detail: "OpenRouter management credential was rejected with HTTP 401.",
      }),
    );
    expect(JSON.stringify(dashboard)).not.toContain("rejected-management-fixture");
    expect(JSON.stringify(dashboard)).not.toContain("untrusted-provider-body");
  });

  test("terminalizes stale passes and prunes completed run history", async () => {
    await pool.query(
      `INSERT INTO private_monitor_runs
         (scheduled_for, owner, status, check_count, failure_count, started_at, finished_at)
       VALUES
         ($1, 'stale-owner', 'running', 0, 0, $1, NULL),
         ($2, 'old-owner', 'completed', 1, 0, $2, $2)`,
      [
        new Date(NOW.getTime() - 31 * 60_000),
        new Date(NOW.getTime() - 31 * 24 * 60 * 60_000),
      ],
    );
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", NOW)).toBe(true);
    const pass = await startPrivateMonitoringPass(pool, "monitor-a", BUCKET, NOW);
    expect(pass).not.toBeNull();

    const rows = await pool.query<{
      owner: string;
      status: string;
      check_count: number;
      failure_count: number;
      error: string | null;
    }>(
      `SELECT owner, status, check_count, failure_count, error
         FROM private_monitor_runs ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      owner: "stale-owner",
      status: "failed",
      check_count: 1,
      failure_count: 1,
      error: "Monitor process stopped before pass completion.",
    });
    expect(rows.rows[1]).toMatchObject({ owner: "monitor-a", status: "running" });
  });

  test("rejects results from a monitor that lost its lease", async () => {
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", NOW, 30_000)).toBe(
      true,
    );
    const pass = await startPrivateMonitoringPass(pool, "monitor-a", BUCKET, NOW);
    expect(pass).not.toBeNull();
    const takeoverAt = new Date(NOW.getTime() + 31_000);
    expect(await acquirePrivateMonitorLease(pool, "monitor-b", takeoverAt)).toBe(true);

    await expect(
      finishPrivateMonitoringPass(
        pool,
        pass!,
        [
          {
            key: "worker-heartbeat",
            group: "fleet",
            severity: "critical",
            healthy: true,
            summary: "Review worker heartbeat is fresh",
            detail: "Worker heartbeat is fresh.",
          },
        ],
        takeoverAt,
      ),
    ).rejects.toThrow("private monitor lease was lost");
    const incidents = await pool.query("SELECT key FROM private_monitor_incidents");
    expect(incidents.rows).toHaveLength(0);
  });

  test("deduplicates incident delivery and records resolution", async () => {
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ('monitor-customer', 'Monitor Customer')
       RETURNING id`,
    );
    const orgId = Number(organization.rows[0]!.id);
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", NOW)).toBe(true);
    const firstPass = await startPrivateMonitoringPass(pool, "monitor-a", BUCKET, NOW);
    expect(firstPass).not.toBeNull();
    const failure: PrivateMonitoringCheck = {
      key: "worker-heartbeat",
      group: "fleet",
      severity: "critical",
      healthy: false,
      summary: "Review worker heartbeat is fresh",
      detail: "No worker heartbeat has been recorded.",
    };
    await finishPrivateMonitoringPass(pool, firstPass!, [failure], NOW);
    expect((await customerServiceNotifications(pool, orgId)).map((row) => row.idempotency_key))
      .toEqual([
        "service-disruption:worker-heartbeat:2026-07-19T12:00:00.000Z",
      ]);

    const [firstClaim, duplicateClaim] = await Promise.all([
      claimPrivateMonitoringNotifications(pool, "monitor-a", NOW),
      claimPrivateMonitoringNotifications(pool, "monitor-b", NOW),
    ]);
    expect([...firstClaim, ...duplicateClaim]).toHaveLength(1);
    const notification = [...firstClaim, ...duplicateClaim][0]!;
    const sent: OperatorNotification[] = [];
    const transport: OperatorNotificationTransport = {
      async send(message) {
        sent.push(message);
        return { messageId: "private-message-1" };
      },
    };
    await deliverPrivateMonitoringNotification(pool, notification, {
      recipient: "operator@example.test",
      publicOrigin: "https://postil.dev",
      transport,
      now: NOW,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content.action?.url).toBe(
      "https://postil.dev/operator#monitoring",
    );
    expect(sent[0]?.content.title).toBe("Review worker heartbeat is stale");
    expect(sent[0]?.content.details).toContainEqual({
      label: "Affected capability",
      value: "Review worker fleet",
    });
    expect(sent[0]?.content.details).toContainEqual({
      label: "First observed",
      value: "2026-07-19 12:00:00 UTC",
    });
    expect(sent[0]?.content.details).toContainEqual({
      label: "Recommended action",
      value: "Inspect the worker process and heartbeat before restarting or replacing a machine.",
    });

    const resolvedAt = new Date(NOW.getTime() + 5 * 60_000);
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", resolvedAt)).toBe(true);
    const secondPass = await startPrivateMonitoringPass(
      pool,
      "monitor-a",
      new Date(BUCKET.getTime() + 5 * 60_000),
      resolvedAt,
    );
    await finishPrivateMonitoringPass(
      pool,
      secondPass!,
      [{ ...failure, healthy: true, detail: "12 seconds since the worker heartbeat; threshold 180." }],
      resolvedAt,
    );
    expect((await customerServiceNotifications(pool, orgId)).map((row) => row.idempotency_key))
      .toEqual([
        "service-disruption:worker-heartbeat:2026-07-19T12:00:00.000Z",
        "service-recovery:worker-heartbeat:2026-07-19T12:00:00.000Z",
      ]);
    const resolution = await claimPrivateMonitoringNotifications(
      pool,
      "monitor-a",
      resolvedAt,
    );
    expect(resolution).toHaveLength(1);
    expect(resolution[0]?.kind).toBe("resolved");
    expect(resolution[0]?.summary).toBe("Review worker fleet recovered");
    await deliverPrivateMonitoringNotification(pool, resolution[0]!, {
      recipient: "operator@example.test",
      publicOrigin: "https://postil.dev",
      transport,
      now: resolvedAt,
    });
    expect(sent[1]?.subject).toBe(
      "[critical] Postil monitor: Review worker fleet recovered",
    );
    expect(sent[1]?.content.title).toBe("Review worker fleet recovered");
    expect(sent[1]?.content.preheader).toBe(
      "Review worker fleet recovered. The incident is resolved.",
    );
    expect(sent[1]?.content.details).toContainEqual({
      label: "Recommended action",
      value: "No action is required. Open private monitoring for retained evidence.",
    });

    const dashboard = await getPrivateMonitoringDashboard(pool);
    expect(dashboard.incidents[0]).toMatchObject({
      key: "worker-heartbeat",
      summary: "Review worker heartbeat is stale",
      state: "resolved",
      occurrenceCount: 1,
    });
    expect(dashboard.runs).toHaveLength(2);

    const reopenedAt = new Date(resolvedAt.getTime() + 5 * 60_000);
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", reopenedAt)).toBe(true);
    const thirdPass = await startPrivateMonitoringPass(
      pool,
      "monitor-a",
      new Date(BUCKET.getTime() + 10 * 60_000),
      reopenedAt,
    );
    await finishPrivateMonitoringPass(pool, thirdPass!, [failure], reopenedAt);
    expect(await customerServiceNotifications(pool, orgId)).toEqual([
      {
        idempotency_key: "service-disruption:worker-heartbeat:2026-07-19T12:00:00.000Z",
        category: "service",
        visibility: "members",
      },
      {
        idempotency_key: "service-recovery:worker-heartbeat:2026-07-19T12:00:00.000Z",
        category: "service",
        visibility: "members",
      },
      {
        idempotency_key: "service-disruption:worker-heartbeat:2026-07-19T12:10:00.000Z",
        category: "service",
        visibility: "members",
      },
    ]);
    const reopened = await pool.query<{
      state: string;
      pending_notification_kind: string | null;
      last_notified_at: Date | null;
    }>(
      `SELECT state, pending_notification_kind, last_notified_at
         FROM private_monitor_incidents
        WHERE key = 'worker-heartbeat'`,
    );
    expect(reopened.rows[0]).toMatchObject({
      state: "open",
      pending_notification_kind: "opened",
      last_notified_at: null,
    });
  });

  test("does not resolve an incident while its opening notification is in flight", async () => {
    const failure: PrivateMonitoringCheck = {
      key: "public-site",
      group: "availability",
      severity: "critical",
      healthy: false,
      summary: "Public site responds",
      detail: "The public probe failed.",
    };
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", NOW)).toBe(true);
    const openingPass = await startPrivateMonitoringPass(pool, "monitor-a", BUCKET, NOW);
    await finishPrivateMonitoringPass(pool, openingPass!, [failure], NOW);
    const [opening] = await claimPrivateMonitoringNotifications(
      pool,
      "monitor-a",
      NOW,
    );
    expect(opening).toBeDefined();

    const overlapAt = new Date(NOW.getTime() + 30_000);
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", overlapAt)).toBe(true);
    const overlapPass = await startPrivateMonitoringPass(
      pool,
      "monitor-a",
      new Date(BUCKET.getTime() + 1_000),
      overlapAt,
    );
    await finishPrivateMonitoringPass(
      pool,
      overlapPass!,
      [{ ...failure, healthy: true, detail: "The public probe succeeded." }],
      overlapAt,
    );
    const duringDelivery = await pool.query<{ state: string }>(
      "SELECT state FROM private_monitor_incidents WHERE key = 'public-site'",
    );
    expect(duringDelivery.rows[0]?.state).toBe("open");

    await deliverPrivateMonitoringNotification(pool, opening!, {
      recipient: "operator@example.test",
      publicOrigin: "https://postil.dev",
      transport: {
        async send() {
          return { messageId: "opened-in-flight" };
        },
      },
      now: overlapAt,
    });
    const resolvedAt = new Date(NOW.getTime() + 5 * 60_000);
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", resolvedAt)).toBe(true);
    const resolutionPass = await startPrivateMonitoringPass(
      pool,
      "monitor-a",
      new Date(BUCKET.getTime() + 5 * 60_000),
      resolvedAt,
    );
    await finishPrivateMonitoringPass(
      pool,
      resolutionPass!,
      [{ ...failure, healthy: true, detail: "The public probe succeeded." }],
      resolvedAt,
    );
    const resolution = await claimPrivateMonitoringNotifications(
      pool,
      "monitor-a",
      resolvedAt,
    );
    expect(resolution[0]?.kind).toBe("resolved");
  });

  test("queues resolution when an opening delivery succeeds after its lease expires", async () => {
    const failure: PrivateMonitoringCheck = {
      key: "public-site",
      group: "availability",
      severity: "critical",
      healthy: false,
      summary: "Public site responds",
      detail: "The public probe failed.",
    };
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", NOW)).toBe(true);
    const openingPass = await startPrivateMonitoringPass(pool, "monitor-a", BUCKET, NOW);
    await finishPrivateMonitoringPass(pool, openingPass!, [failure], NOW);
    const [opening] = await claimPrivateMonitoringNotifications(
      pool,
      "monitor-a",
      NOW,
    );
    expect(opening).toBeDefined();

    const afterNotificationLease = new Date(NOW.getTime() + 61_000);
    expect(
      await acquirePrivateMonitorLease(pool, "monitor-a", afterNotificationLease),
    ).toBe(true);
    const healthyPass = await startPrivateMonitoringPass(
      pool,
      "monitor-a",
      new Date(BUCKET.getTime() + 1_000),
      afterNotificationLease,
    );
    await finishPrivateMonitoringPass(
      pool,
      healthyPass!,
      [{ ...failure, healthy: true, detail: "The public probe succeeded." }],
      afterNotificationLease,
    );

    const lateDeliveryAt = new Date(afterNotificationLease.getTime() + 1_000);
    await deliverPrivateMonitoringNotification(pool, opening!, {
      recipient: "operator@example.test",
      publicOrigin: "https://postil.dev",
      transport: {
        async send() {
          return { messageId: "late-opening" };
        },
      },
      now: lateDeliveryAt,
    });
    const resolution = await claimPrivateMonitoringNotifications(
      pool,
      "monitor-a",
      lateDeliveryAt,
    );
    expect(resolution[0]?.kind).toBe("resolved");
  });

  test("bounds each notification retry epoch and rearms after cooldown", async () => {
    expect(await acquirePrivateMonitorLease(pool, "monitor-a", NOW)).toBe(true);
    const pass = await startPrivateMonitoringPass(pool, "monitor-a", BUCKET, NOW);
    await finishPrivateMonitoringPass(
      pool,
      pass!,
      [
        {
          key: "public-site",
          group: "availability",
          severity: "critical",
          healthy: false,
          summary: "Public site responds",
          detail: "The public probe failed.",
        },
      ],
      NOW,
    );
    const transport: OperatorNotificationTransport = {
      async send() {
        throw new Error("simulated transport failure");
      },
    };
    let availableAt = NOW;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = await claimPrivateMonitoringNotifications(
        pool,
        `monitor-${attempt}`,
        availableAt,
      );
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.attempt).toBe(attempt);
      await expect(
        deliverPrivateMonitoringNotification(pool, claimed[0]!, {
          recipient: "operator@example.test",
          publicOrigin: "https://postil.dev",
          transport,
          now: availableAt,
        }),
      ).rejects.toThrow("simulated transport failure");
      const row = await pool.query<{
        notification_attempts: number;
        notification_available_at: Date;
        notification_lease_owner: string | null;
      }>(
        `SELECT notification_attempts, notification_available_at,
                notification_lease_owner
           FROM private_monitor_incidents
          WHERE key = 'public-site'`,
      );
      expect(row.rows[0]?.notification_attempts).toBe(attempt);
      expect(row.rows[0]?.notification_lease_owner).toBeNull();
      availableAt = row.rows[0]!.notification_available_at;
    }
    expect(
      await claimPrivateMonitoringNotifications(
        pool,
        "monitor-before-cooldown",
        new Date(availableAt.getTime() - 1),
      ),
    ).toHaveLength(0);
    const rearmed = await claimPrivateMonitoringNotifications(
      pool,
      "monitor-next-epoch",
      availableAt,
    );
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]?.attempt).toBe(1);
  });

  test("ignores old terminal jobs while keeping unresolved records open", async () => {
    await pool.query(
      `INSERT INTO jobs (kind, payload, status, run_after)
       VALUES ('check-run-cleanup', '{}'::jsonb, 'failed', now() - interval '31 minutes')`,
    );
    await pool.query(
      `INSERT INTO operator_alert_deliveries
         (event_key, event, status, created_at, updated_at)
       VALUES ('monitor-test-alert', 'trial_started', 'failed',
               now() - interval '31 minutes', now() - interval '31 minutes')`,
    );
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ('monitor-test', 'Monitor Test') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO billing_author_settlements
         (org_id, provider_subscription_id, period_starts_at, period_ends_at,
          active_author_count, unit_amount_cents, total_amount_cents, status,
          created_at, updated_at)
       VALUES ($1, 'sub_monitor_test', now() - interval '2 months',
               now() - interval '1 month', 1, 600, 600, 'failed',
               now() - interval '31 minutes', now() - interval '31 minutes')`,
      [organization.rows[0]!.id],
    );

    const operationalChecks = (await runDatabaseMonitoringChecks(pool)).filter(
      (check) =>
        [
          "check-run-cleanup",
          "operator-email-failures",
          "billing-settlement-failures",
        ].includes(check.key),
    );
    expect(
      operationalChecks.find((check) => check.key === "check-run-cleanup")
        ?.healthy,
    ).toBe(true);
    expect(
      operationalChecks
        .filter((check) => check.key !== "check-run-cleanup")
        .every((check) => !check.healthy),
    ).toBe(true);

    await pool.query(
      `UPDATE jobs SET status = 'done'
        WHERE kind = 'check-run-cleanup' AND status = 'failed'`,
    );
    await pool.query(
      `UPDATE operator_alert_deliveries SET status = 'delivered', updated_at = now()
        WHERE event_key = 'monitor-test-alert'`,
    );
    await pool.query(
      `UPDATE billing_author_settlements SET status = 'no_charge', updated_at = now()
        WHERE provider_subscription_id = 'sub_monitor_test'`,
    );
    const repairedChecks = (await runDatabaseMonitoringChecks(pool)).filter(
      (check) => operationalChecks.some((candidate) => candidate.key === check.key),
    );
    expect(repairedChecks.every((check) => check.healthy)).toBe(true);
  });

  test("measures queued work from its due time and ignores future jobs", async () => {
    const future = await pool.query<{ id: number }>(
      `INSERT INTO jobs (kind, payload, status, created_at, run_after)
       VALUES ('check-run-cleanup', '{}'::jsonb, 'queued',
               now() - interval '2 hours', now() + interval '1 hour')
       RETURNING id`,
    );
    try {
      const futureCheck = (await runDatabaseMonitoringChecks(pool)).find(
        (check) => check.key === "queued-job-age",
      );
      expect(futureCheck).toMatchObject({ healthy: true });
      expect(futureCheck?.detail).toStartWith("0 seconds observed");

      await pool.query(
        `UPDATE jobs SET run_after = now() - interval '31 minutes'
          WHERE id = $1`,
        [future.rows[0]!.id],
      );
      const overdueCheck = (await runDatabaseMonitoringChecks(pool)).find(
        (check) => check.key === "queued-job-age",
      );
      expect(overdueCheck).toMatchObject({ healthy: false });
      expect(overdueCheck?.detail).not.toContain("7,200");
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [future.rows[0]!.id]);
    }
  });

  test("reports recent terminal job failures", async () => {
    const job = await pool.query<{ id: number }>(
      `INSERT INTO jobs (kind, payload, status, run_after)
       VALUES ('check-run-cleanup', '{}'::jsonb, 'failed', now())
       RETURNING id`,
    );
    try {
      const checks = await runDatabaseMonitoringChecks(pool);
      expect(checks.find((check) => check.key === "check-run-cleanup")).toMatchObject({
        healthy: false,
      });
      expect(checks.find((check) => check.key === "failed-jobs")).toMatchObject({
        healthy: false,
      });
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [job.rows[0]!.id]);
    }
  });

  test("bounds terminal webhook and billing history to recent events", async () => {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (github_id, login)
       VALUES (990001, 'monitor-history-user') RETURNING id`,
    );
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name)
       VALUES ('monitor-history', 'Monitor History') RETURNING id`,
    );
    const userId = user.rows[0]!.id;
    const orgId = organization.rows[0]!.id;
    try {
      await pool.query(
        `INSERT INTO billing_provider_events
           (event_id, event_type, occurred_at, outcome)
         VALUES
           ('monitor-old-unmatched', 'transaction.completed',
            now() - interval '25 hours', 'unmatched'),
           ('monitor-recent-unmatched', 'transaction.completed',
            now(), 'unmatched')`,
      );
      await pool.query(
        `INSERT INTO billing_checkout_transactions
           (org_id, requested_by_user_id, status, expires_at, created_at, updated_at)
         VALUES
           ($1, $2, 'failed', now() - interval '25 hours',
            now() - interval '25 hours', now() - interval '25 hours'),
           ($1, $2, 'failed', now() + interval '1 hour', now(), now())`,
        [orgId, userId],
      );
      await pool.query(
        `INSERT INTO github_webhook_delivery_recoveries
           (delivery_id, delivery_guid, delivered_at, event, redelivery,
            outcome, request_state, updated_at)
         VALUES
           ('monitor-old-terminal', 'monitor-old-guid',
            now() - interval '31 minutes', 'pull_request', false,
            'failure', 'terminal', now() - interval '31 minutes'),
           ('monitor-recent-terminal', 'monitor-recent-guid', now(),
            'pull_request', false, 'failure', 'terminal', now())`,
      );

      const recentChecks = await runDatabaseMonitoringChecks(pool);
      for (const key of [
        "billing-unmatched-events",
        "billing-checkout-failures",
        "webhook-recovery-terminal",
      ]) {
        expect(recentChecks.find((check) => check.key === key)).toMatchObject({
          healthy: false,
        });
      }

      await pool.query(
        `DELETE FROM billing_provider_events
          WHERE event_id = 'monitor-recent-unmatched'`,
      );
      await pool.query(
        `DELETE FROM billing_checkout_transactions
          WHERE updated_at >= now() - interval '1 hour'`,
      );
      await pool.query(
        `DELETE FROM github_webhook_delivery_recoveries
          WHERE delivery_id = 'monitor-recent-terminal'`,
      );
      const oldChecks = await runDatabaseMonitoringChecks(pool);
      for (const key of [
        "billing-unmatched-events",
        "billing-checkout-failures",
        "webhook-recovery-terminal",
      ]) {
        expect(oldChecks.find((check) => check.key === key)).toMatchObject({
          healthy: true,
        });
      }
    } finally {
      await pool.query(
        `DELETE FROM github_webhook_delivery_recoveries
          WHERE delivery_id LIKE 'monitor-%'`,
      );
      await pool.query(
        `DELETE FROM billing_provider_events
          WHERE event_id LIKE 'monitor-%'`,
      );
      await pool.query(
        "DELETE FROM billing_checkout_transactions WHERE org_id = $1",
        [orgId],
      );
      await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    }
  });

  test("requires a delivered operator alert for every trial grant", async () => {
    const githubActorId = 998877;
    const githubOrgId = 556677;
    const otherGithubOrgId = 112233;
    const wrongOrgEventKey = `trial-started:${githubOrgId}`;
    const targetEventKey = "monitor-trial-started-target";
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, github_org_id)
       VALUES ('monitor-trial-alert', 'Monitor Trial Alert', $1) RETURNING id`,
      [githubOrgId],
    );
    const orgId = organization.rows[0]!.id;
    const otherOrganization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, github_org_id)
       VALUES ('monitor-other-trial-alert', 'Monitor Other Trial Alert', $1)
       RETURNING id`,
      [otherGithubOrgId],
    );
    const otherOrgId = otherOrganization.rows[0]!.id;
    try {
      await pool.query(
        `INSERT INTO organization_entitlements
           (org_id, subscription_mode, status, trial_ends_at, updated_by)
         VALUES ($1, 'byok', 'trialing', now() + interval '30 days', 'test')`,
        [orgId],
      );
      await pool.query(
        `INSERT INTO self_service_trial_grants
           (org_id, initiated_by_github_id, requested_mode, granted_mode)
         VALUES ($1, $2, 'byok', 'byok')`,
        [orgId, githubActorId],
      );
      await pool.query(
        `INSERT INTO operator_alert_deliveries
           (event_key, event, org_id, status, created_at, updated_at)
         VALUES ($1, 'trial_started', $2, 'delivered',
                 now() - interval '2 days', now() - interval '2 days'),
                ($3, 'trial_started', $4, 'failed',
                 now() - interval '2 days', now() - interval '2 days')`,
        [wrongOrgEventKey, otherOrgId, targetEventKey, orgId],
      );

      const failed = (await runDatabaseMonitoringChecks(pool)).find(
        (check) => check.key === "trial-alert-gaps",
      );
      expect(failed?.healthy).toBe(false);
      expect(failed?.detail).toContain("1");

      await pool.query(
        `UPDATE operator_alert_deliveries
            SET status = 'delivered', delivered_at = now(), updated_at = now()
          WHERE event_key = $1`,
        [targetEventKey],
      );
      const delivered = (await runDatabaseMonitoringChecks(pool)).find(
        (check) => check.key === "trial-alert-gaps",
      );
      expect(delivered?.healthy).toBe(true);
    } finally {
      await pool.query(
        "DELETE FROM operator_alert_deliveries WHERE event_key = ANY($1::text[])",
        [[wrongOrgEventKey, targetEventKey]],
      );
      await pool.query(
        "DELETE FROM self_service_trial_grants WHERE org_id = $1",
        [orgId],
      );
      await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
      await pool.query("DELETE FROM organizations WHERE id = $1", [otherOrgId]);
    }
  });

  test("uses the configured heartbeat threshold", async () => {
    await recordServiceHeartbeat(pool, "worker", "worker-threshold");
    await pool.query(
      `UPDATE service_heartbeats
          SET observed_at = now() - interval '5 minutes'
        WHERE component = 'worker'`,
    );
    const defaultCheck = (await runDatabaseMonitoringChecks(pool)).find(
      (check) => check.key === "worker-heartbeat",
    );
    const relaxedCheck = (
      await runDatabaseMonitoringChecks(pool, {
        workerHeartbeatMaxAgeSeconds: 600,
      })
    ).find((check) => check.key === "worker-heartbeat");
    expect(defaultCheck?.healthy).toBe(false);
    expect(relaxedCheck?.healthy).toBe(true);
  });

  test("reports healthy queue and signup state from a fresh database", async () => {
    await recordServiceHeartbeat(pool, "worker", "worker-a", new Date());
    const checks = await runDatabaseMonitoringChecks(pool);
    const heartbeat = checks.find((check) => check.key === "worker-heartbeat");
    expect(heartbeat?.healthy).toBe(true);
    expect(
      checks
        .filter((check) => check.key !== "webhook-recovery-scan")
        .every((check) => check.healthy),
    ).toBe(true);
  });

  test("reports a missing webhook recovery cursor without aborting the pass", async () => {
    await pool.query(
      `INSERT INTO installations
         (github_installation_id, account_login, account_type, suspended)
       VALUES (900034, 'monitor-test', 'Organization', false)`,
    );
    try {
      const checks = await runDatabaseMonitoringChecks(pool);
      expect(checks.find((check) => check.key === "webhook-recovery-scan")).toMatchObject({
        healthy: false,
        severity: "warning",
      });
    } finally {
      await pool.query(
        "DELETE FROM installations WHERE github_installation_id = 900034",
      );
    }
  });

  test("reports bounded webhook recovery failure evidence", async () => {
    await pool.query(
      `INSERT INTO installations
         (github_installation_id, account_login, account_type, suspended)
       VALUES (900035, 'monitor-evidence', 'Organization', false)`,
    );
    await pool.query(
      `INSERT INTO github_webhook_redelivery_state
         (id, last_page_at, last_error_category)
       VALUES (1, now() - interval '3 hours', 'invalid_response')`,
    );
    try {
      const check = (await runDatabaseMonitoringChecks(pool)).find(
        (candidate) => candidate.key === "webhook-recovery-scan",
      );
      expect(check).toMatchObject({ healthy: false, severity: "warning" });
      expect(check?.detail).toContain(
        "Last scanner result: GitHub response did not match the recovery contract.",
      );
    } finally {
      await pool.query(
        "DELETE FROM installations WHERE github_installation_id = 900035",
      );
    }
  });

  test("counts a review failure only when the service is at fault", async () => {
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, account_login, account_type, suspended)
       VALUES (900036, 'monitor-outcome', 'Organization', false) RETURNING id`,
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name, enabled)
       VALUES ($1, 900036001, 'monitor-outcome/service', true) RETURNING id`,
      [installation.rows[0]!.id],
    );
    const repositoryId = repository.rows[0]!.id;
    const insertFailure = async (prNumber: number, message: string) => {
      await pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, status, trigger_source,
            error_message, queued_at, finished_at)
         VALUES ($1, $2, $3, $4, 'failed', 'unknown', $5,
                 now() - interval '5 minutes', now() - interval '5 minutes')`,
        [repositoryId, prNumber, "a".repeat(40), "b".repeat(40), message],
      );
    };
    const operationalCheck = async () =>
      (await runDatabaseMonitoringChecks(pool)).find(
        (check) => check.key === "review-operational-failures",
      );
    // Spelled out rather than mapped over the exported list: a fixture derived
    // from the value under test passes whatever that value becomes.
    const benign = [
      "Hosted inference allowance is unavailable or fully reserved.",
      "Hosted review service is temporarily unavailable.",
      "pull request is no longer eligible for publication",
    ];
    try {
      expect([...NON_OPERATIONAL_REVIEW_FAILURE_MESSAGES] as string[]).toEqual(benign);
      for (const [index, message] of benign.entries()) {
        await insertFailure(700 + index, message);
      }
      expect(await operationalCheck()).toMatchObject({ healthy: true });

      // An unattributed failure is exactly the kind worth waking someone for.
      await insertFailure(799, "");
      expect(await operationalCheck()).toMatchObject({ healthy: false });
    } finally {
      await pool.query(
        "DELETE FROM installations WHERE github_installation_id = 900036",
      );
    }
  });

  test("pages for invalid model output only when the run could not recover", async () => {
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, account_login, account_type, suspended)
       VALUES (900037, 'monitor-incident', 'Organization', false) RETURNING id`,
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name, enabled)
       VALUES ($1, 900037001, 'monitor-incident/service', true) RETURNING id`,
      [installation.rows[0]!.id],
    );
    const insertCompleted = async (prNumber: number, incident: unknown) => {
      await pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, status, trigger_source,
            envelope, queued_at, finished_at)
         VALUES ($1, $2, $3, $4, 'completed', 'unknown', $5,
                 now() - interval '5 minutes', now() - interval '5 minutes')`,
        [
          repository.rows[0]!.id,
          prNumber,
          "c".repeat(40),
          "d".repeat(40),
          JSON.stringify({ modelIncidents: [incident] }),
        ],
      );
    };
    const invalidOutputCheck = async () =>
      (await runDatabaseMonitoringChecks(pool)).find(
        (check) => check.key === "invalid-model-output",
      );
    try {
      await insertCompleted(800, {
        phase: "review",
        category: "invalidOutput",
        recovered: true,
        recovery: "repair",
      });
      expect(await invalidOutputCheck()).toMatchObject({ healthy: true });

      await insertCompleted(801, {
        phase: "review",
        category: "invalidOutput",
        recovered: false,
      });
      expect(await invalidOutputCheck()).toMatchObject({ healthy: false });
    } finally {
      await pool.query(
        "DELETE FROM installations WHERE github_installation_id = 900037",
      );
    }
  });

  test("assigns one actionable alert to each classified review failure", async () => {
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, account_login, account_type, suspended)
       VALUES (900038, 'monitor-classification', 'Organization', false) RETURNING id`,
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories (installation_id, github_repo_id, full_name, enabled)
       VALUES ($1, 900038001, 'monitor-classification/service', true) RETURNING id`,
      [installation.rows[0]!.id],
    );
    const repositoryId = repository.rows[0]!.id;
    const insertCompleted = async (prNumber: number, envelope: unknown) => {
      await pool.query(
        `INSERT INTO reviews
           (repository_id, pr_number, head_sha, base_sha, status, trigger_source,
            envelope, queued_at, finished_at)
         VALUES ($1, $2, $3, $4, 'completed', 'unknown', $5,
                 now() - interval '5 minutes', now() - interval '5 minutes')`,
        [
          repositoryId,
          prNumber,
          "e".repeat(40),
          "f".repeat(40),
          JSON.stringify(envelope),
        ],
      );
    };
    const classifiedChecks = async () => {
      const checks = await runDatabaseMonitoringChecks(pool);
      return Object.fromEntries(
        checks
          .filter((check) =>
            [
              "review-operational-failures",
              "scorer-failures",
              "invalid-model-output",
            ].includes(check.key),
          )
          .map((check) => [check.key, check.healthy]),
      );
    };
    const clearReviews = () =>
      pool.query("DELETE FROM reviews WHERE repository_id = $1", [repositoryId]);

    try {
      await insertCompleted(900, {
        findings: [{ path: ".postil/provider" }],
        modelIncidents: [
          { phase: "scorer", category: "providerError", recovered: false },
        ],
      });
      expect(await classifiedChecks()).toEqual({
        "review-operational-failures": true,
        "scorer-failures": false,
        "invalid-model-output": true,
      });

      await clearReviews();
      await insertCompleted(901, {
        findings: [{ path: ".postil/model-output" }],
        scorerError: "invalid scorer output",
        modelIncidents: [
          { phase: "scorer", category: "invalidOutput", recovered: false },
        ],
      });
      expect(await classifiedChecks()).toEqual({
        "review-operational-failures": true,
        "scorer-failures": true,
        "invalid-model-output": false,
      });

      await clearReviews();
      await insertCompleted(902, {
        findings: [{ path: ".postil/operational" }],
        modelIncidents: [],
      });
      expect(await classifiedChecks()).toEqual({
        "review-operational-failures": false,
        "scorer-failures": true,
        "invalid-model-output": true,
      });

      await clearReviews();
      await insertCompleted(903, {
        findings: [{ path: ".postil/operational" }],
        modelIncidents: [
          { phase: "scorer", category: "providerError", recovered: false },
        ],
      });
      expect(await classifiedChecks()).toEqual({
        "review-operational-failures": false,
        "scorer-failures": false,
        "invalid-model-output": true,
      });

      await clearReviews();
      await insertCompleted(904, {
        findings: [{ path: ".postil/provider" }],
        modelIncidents: [
          { phase: "scorer", category: "timeout", recovered: false },
        ],
      });
      expect(await classifiedChecks()).toEqual({
        "review-operational-failures": false,
        "scorer-failures": false,
        "invalid-model-output": true,
      });

      await clearReviews();
      await insertCompleted(905, {
        findings: [
          { path: ".postil/provider" },
          { path: ".postil/model-output" },
        ],
        modelIncidents: [
          { phase: "scorer", category: "providerError", recovered: false },
          { phase: "review", category: "invalidOutput", recovered: false },
        ],
      });
      expect(await classifiedChecks()).toEqual({
        "review-operational-failures": true,
        "scorer-failures": false,
        "invalid-model-output": false,
      });

      await clearReviews();
      await insertCompleted(906, {
        findings: [{ path: ".postil/provider" }],
        modelIncidents: [
          { phase: "scorer", category: "invalidOutput", recovered: false },
        ],
      });
      expect(await classifiedChecks()).toEqual({
        "review-operational-failures": false,
        "scorer-failures": true,
        "invalid-model-output": false,
      });

      await clearReviews();
      await insertCompleted(907, {
        findings: [{ path: ".postil/operational" }],
        scorerError: "invalid scorer output",
        modelIncidents: [
          { phase: "scorer", category: "invalidOutput", recovered: false },
        ],
      });
      expect(await classifiedChecks()).toEqual({
        "review-operational-failures": true,
        "scorer-failures": true,
        "invalid-model-output": false,
      });

      await clearReviews();
      await insertCompleted(908, {
        findings: [
          { path: ".postil/operational" },
          { path: ".postil/operational" },
        ],
        scorerError: "invalid scorer output",
        modelIncidents: [
          { phase: "scorer", category: "invalidOutput", recovered: false },
        ],
      });
      expect(await classifiedChecks()).toEqual({
        "review-operational-failures": false,
        "scorer-failures": true,
        "invalid-model-output": false,
      });

      await clearReviews();
      await insertCompleted(909, {
        findings: [{ path: ".postil/operational" }],
        modelIncidents: [
          {
            phase: "review",
            category: "invalidOutput",
            recovered: true,
            recovery: "repair",
          },
        ],
      });
      expect(await classifiedChecks()).toEqual({
        "review-operational-failures": false,
        "scorer-failures": true,
        "invalid-model-output": true,
      });
    } finally {
      await pool.query(
        "DELETE FROM installations WHERE github_installation_id = 900038",
      );
    }
  });
});

async function customerServiceNotifications(pool: Pool, orgId: number): Promise<Array<{
  idempotency_key: string;
  category: string;
  visibility: string;
}>> {
  return (
    await pool.query<{
      idempotency_key: string;
      category: string;
      visibility: string;
    }>(
      `SELECT idempotency_key, category, visibility
         FROM customer_notification_events
        WHERE org_id = $1
        ORDER BY id`,
      [orgId],
    )
  ).rows;
}
