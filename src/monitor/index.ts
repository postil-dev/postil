import { hostname } from "node:os";

import { closeDb, getPool } from "@/lib/db";
import { normalizeVerificationEmail } from "@/lib/email-verification";
import {
  configuredWorkerHeartbeatIntervalMs,
  optionalEnv,
  validateEnv,
} from "@/lib/env";
import {
  acquirePrivateMonitorLease,
  claimPrivateMonitoringNotifications,
  deliverPrivateMonitoringNotification,
  failPrivateMonitoringPass,
  finishPrivateMonitoringPass,
  markMonitorPassAlertSent,
  recordMonitorPassFailure,
  recordMonitorPassSuccess,
  recordServiceHeartbeat,
  runDatabaseMonitoringChecks,
  runPublicMonitoringChecks,
  sendMonitorPassFailureNotification,
  startPrivateMonitoringPass,
  type PrivateMonitoringPass,
  type MonitorPassFailureState,
} from "@/lib/private-monitoring";
import { redactSecrets } from "@/lib/redact";
import {
  reportOperationalFailure,
  reportOperationalState,
  shutdownServerObservability,
} from "@/lib/server-observability";

const INTERVAL_MS = positiveIntEnv(
  "POSTIL_MONITOR_INTERVAL_MS",
  5 * 60 * 1_000,
);
const BYPASS_ALERT_AFTER_FAILURES = 2;
const owner = `${hostname()}-${process.pid}`;
let shuttingDown = false;
let wakeSleep: (() => void) | undefined;
let monitorFailureState: MonitorPassFailureState = {
  bucket: null,
  failuresInBucket: 0,
  lastAlertBucket: null,
};

async function main(): Promise<void> {
  validateEnv("monitor");
  const workerHeartbeatIntervalMs = configuredWorkerHeartbeatIntervalMs();
  if (workerHeartbeatIntervalMs === null) {
    throw new Error(
      "WORKER_HEARTBEAT_INTERVAL_MS is required for the private monitor",
    );
  }
  const workerHeartbeatMaxAgeSeconds = Math.max(
    180,
    Math.ceil((workerHeartbeatIntervalMs * 3) / 1_000),
  );
  const publicOrigin = required("POSTIL_PUBLIC_URL");
  const recipient = normalizeVerificationEmail(
    required("POSTIL_OPERATOR_ALERT_EMAIL"),
    "POSTIL_OPERATOR_ALERT_EMAIL must be a valid email address.",
  );
  if (!recipient) throw new Error("POSTIL_OPERATOR_ALERT_EMAIL is required");

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  reportOperationalState("monitor", "monitor_started");

  while (!shuttingDown) {
    const startedAt = new Date();
    let pass: PrivateMonitoringPass | null = null;
    try {
      const pool = getPool();
      if (!(await acquirePrivateMonitorLease(pool, owner, startedAt))) {
        await sleepUntilNextPass(INTERVAL_MS);
        continue;
      }
      await recordServiceHeartbeat(pool, "monitor", owner, startedAt);
      pass = await startPrivateMonitoringPass(
        pool,
        owner,
        monitoringBucket(startedAt, INTERVAL_MS),
        startedAt,
      );
      if (!pass) {
        await sleepUntilNextPass(INTERVAL_MS);
        continue;
      }

      const [publicChecks, databaseChecks] = await Promise.all([
        runPublicMonitoringChecks(publicOrigin),
        runDatabaseMonitoringChecks(pool, {
          workerHeartbeatMaxAgeSeconds,
        }),
      ]);
      await finishPrivateMonitoringPass(
        pool,
        pass,
        [...publicChecks, ...databaseChecks],
        new Date(),
      );
      await recordServiceHeartbeat(pool, "monitor", owner, new Date());
      monitorFailureState = recordMonitorPassSuccess(monitorFailureState);

      const notifications = await claimPrivateMonitoringNotifications(
        pool,
        owner,
      );
      for (const notification of notifications) {
        try {
          await deliverPrivateMonitoringNotification(pool, notification, {
            recipient,
            publicOrigin,
          });
        } catch (error) {
          reportOperationalFailure(
            "monitor",
            "monitor_notification_failed",
            error,
          );
          console.error(
            `[monitor] notification ${notification.incidentKey} failed: ${redactSecrets(error)}`,
          );
        }
      }
      console.log(
        `[monitor] pass ${pass.runId} completed with ${publicChecks.length + databaseChecks.length} checks and ${notifications.length} notification claim(s)`,
      );
    } catch (error) {
      const failure = recordMonitorPassFailure(
        monitorFailureState,
        startedAt,
        BYPASS_ALERT_AFTER_FAILURES,
      );
      monitorFailureState = failure.state;
      reportOperationalFailure("monitor", "monitor_pass_failed", error);
      console.error(`[monitor] pass failed: ${redactSecrets(error)}`);
      if (pass) {
        await failPrivateMonitoringPass(getPool(), pass, error).catch(
          (recordError) => {
            console.error(
              `[monitor] failed to record pass failure: ${redactSecrets(recordError)}`,
            );
          },
        );
      }
      if (
        failure.shouldAlert &&
        monitorFailureState.bucket
      ) {
        await sendMonitorPassFailureNotification({
          recipient,
          publicOrigin,
          bucket: monitorFailureState.bucket,
        })
          .then(() => {
            monitorFailureState = markMonitorPassAlertSent(
              monitorFailureState,
            );
          })
          .catch((notificationError) => {
            console.error(
              `[monitor] bypass alert failed: ${redactSecrets(notificationError)}`,
            );
          });
      }
    }
    if (!shuttingDown) {
      const elapsed = Date.now() - startedAt.getTime();
      await sleepUntilNextPass(Math.max(1_000, INTERVAL_MS - elapsed));
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  wakeSleep?.();
  console.log(`[monitor] received ${signal}; stopping`);
  await Promise.allSettled([closeDb(), shutdownServerObservability("monitor")]);
}

function sleepUntilNextPass(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (wakeSleep === finish) wakeSleep = undefined;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakeSleep = finish;
  });
}

function monitoringBucket(now: Date, intervalMs: number): Date {
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

function required(name: string): string {
  const value = optionalEnv(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 30_000 ||
    value > 60 * 60 * 1_000
  ) {
    throw new Error(`${name} must be between 30000 and 3600000 milliseconds`);
  }
  return value;
}

main().catch(async (error) => {
  reportOperationalFailure("monitor", "monitor_boot_failed", error);
  console.error(redactSecrets(error));
  await shutdownServerObservability("monitor");
  process.exit(1);
});
