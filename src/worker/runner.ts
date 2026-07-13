import { hostname } from "node:os";

import { getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import type { GateStateSyncJobPayload } from "@/lib/finding-approvals";
import {
  claimJob,
  completeJob,
  failJob,
  retryJobIndefinitely,
  type CheckRunCleanupJobPayload,
  type ClaimedJob,
  type RespondDeliveryJobPayload,
  type RespondJobPayload,
  type ReviewJobPayload,
} from "@/lib/queue";
import { redactSecrets } from "@/lib/redact";
import {
  reportOperationalFailure,
  reportOperationalWarning,
  type ObservabilityProcessGroup,
} from "@/lib/server-observability";
import {
  runBillingContactVerificationJob,
  type BillingContactVerificationJobPayload,
} from "./billing-contact-verification";
import { isPermanentFailure } from "./failure-classifier";
import { runGateStateSyncJob } from "./gate-state-sync";
import {
  postRespondFailureComment,
  runRespondDeliveryJob,
  runRespondFailureCommentJob,
  runRespondJob,
} from "./respond";
import { runCheckRunCleanupJob, runReviewJob } from "./review";
import { watchdogPass } from "./watchdog";

const DEFAULT_DRAIN_MAX_JOBS = readPositiveIntEnv("POSTIL_QUEUE_DRAIN_MAX_JOBS", 1);
const DEFAULT_DRAIN_DEADLINE_MS = readPositiveIntEnv(
  "POSTIL_QUEUE_DRAIN_DEADLINE_MS",
  12 * 60 * 1000,
);

let backgroundDrain: Promise<void> | undefined;

export const PROCESSABLE_JOB_KINDS = [
  "review",
  "respond",
  "respond-delivery",
  "billing-contact-verification",
  "gate-state-sync",
  "check-run-cleanup",
  "respond-failure-comment",
] as const;

async function handleJob(
  job: ClaimedJob,
  processGroup: ObservabilityProcessGroup,
): Promise<void> {
  switch (job.kind) {
    case "review":
      await runReviewJob(
        job.payload as ReviewJobPayload,
        {
          queuedAt: job.createdAt,
          startedAt: job.lockedAt,
        },
        processGroup,
      );
      break;
    case "respond":
      await runRespondJob(job.payload as RespondJobPayload, job.id);
      break;
    case "respond-delivery":
      await runRespondDeliveryJob(job.payload as RespondDeliveryJobPayload);
      break;
    case "billing-contact-verification":
      await runBillingContactVerificationJob(
        job.payload as BillingContactVerificationJobPayload,
      );
      break;
    case "gate-state-sync":
      await runGateStateSyncJob(job.payload as GateStateSyncJobPayload);
      break;
    case "check-run-cleanup":
      await runCheckRunCleanupJob(job.payload as CheckRunCleanupJobPayload);
      break;
    case "respond-failure-comment":
      await runRespondFailureCommentJob(job.payload as RespondJobPayload);
      break;
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}

export async function runClaimedJob(
  job: ClaimedJob,
  label: string,
  processGroup: ObservabilityProcessGroup = "worker",
): Promise<void> {
  const started = Date.now();
  console.log(`[${label}] job ${job.id} (${job.kind}) attempt ${job.attempts}`);
  try {
    await handleJob(job, processGroup);
    await completeJob(getPool(), job);
    console.log(`[${label}] job ${job.id} done in ${Date.now() - started}ms`);
  } catch (err) {
    const message = redactSecrets(err);
    const malformedGateSync =
      job.kind === "gate-state-sync" &&
      message.includes("gate state sync job payload is malformed");
    const permanent =
      malformedGateSync ||
      (job.kind !== "gate-state-sync" && isPermanentFailure(message));
    const outcome =
      job.kind === "gate-state-sync" && !malformedGateSync
        ? await retryJobIndefinitely(getPool(), job, message)
        : await failJob(getPool(), job, message, { permanent });
    console.error(
      `[${label}] job ${job.id} ${outcome}${permanent ? " (permanent)" : ""}: ${message}`,
    );
    if (outcome === "failed") {
      reportOperationalFailure(processGroup, "job_permanently_failed", err);
    } else if (outcome === "retried") {
      reportOperationalWarning(processGroup, "job_retrying");
    }
    if (outcome === "failed" && job.kind === "respond") {
      await postRespondFailureComment(
        job.payload as RespondJobPayload,
        undefined,
        undefined,
        false,
        job.id,
      );
    }
  }
}

export async function drainQueueOnce(
  label: string,
  opts: { maxJobs?: number; deadlineMs?: number } = {},
): Promise<number> {
  const maxJobs = Math.max(1, opts.maxJobs ?? DEFAULT_DRAIN_MAX_JOBS);
  const deadlineAt = Date.now() + Math.max(1_000, opts.deadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS);
  const workerId = `${label}-${hostname()}-${process.pid}`;
  let drained = 0;

  await watchdogPass().catch((err) => {
    console.error(`[${label}] watchdog pass failed before drain: ${redactSecrets(err)}`);
  });

  while (drained < maxJobs && Date.now() < deadlineAt) {
    const job = await claimJob(getPool(), workerId, PROCESSABLE_JOB_KINDS);
    if (!job) break;
    await runClaimedJob(job, label, "web");
    drained += 1;
  }

  return drained;
}

export function triggerQueueDrain(reason: string): void {
  if (optionalEnv("POSTIL_WEBHOOK_DRAIN_ENABLED", "0") !== "1") return;
  if (backgroundDrain) return;
  const label = `web-drain:${reason.replace(/[^a-z0-9_-]/gi, "_")}`;
  backgroundDrain = drainQueueOnce(label)
    .then((count) => {
      if (count > 0) console.log(`[${label}] drained ${count} job(s)`);
    })
    .catch((err) => {
      console.error(`[${label}] drain failed: ${redactSecrets(err)}`);
    })
    .finally(() => {
      backgroundDrain = undefined;
    });
}

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`${name} must be a positive integer; using ${fallback}`);
    return fallback;
  }
  return parsed;
}
