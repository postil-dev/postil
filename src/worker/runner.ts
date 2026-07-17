import { hostname } from "node:os";

import { getPool } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import type { GateStateSyncJobPayload } from "@/lib/finding-approvals";
import {
  claimJob,
  completeWebhookDelivery,
  completeJob,
  failJob,
  loadWebhookDelivery,
  requeueJobsOwnedBy,
  retryJobIndefinitely,
  type CheckRunCleanupJobPayload,
  type ClaimedJob,
  type RespondDeliveryJobPayload,
  type RespondFailureCommentJobPayload,
  type RespondJobPayload,
  type ReviewJobPayload,
  type WebhookCommentJobPayload,
  WebhookDeliveryStateError,
  type WebhookDispatchJobPayload,
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
  runWebhookCommentJob,
} from "./respond";
import { runCheckRunCleanupJob, runReviewJob, WorkerShutdownError } from "./review";
import { watchdogPass } from "./watchdog";

const DEFAULT_DRAIN_MAX_JOBS = readPositiveIntEnv("POSTIL_QUEUE_DRAIN_MAX_JOBS", 1);
const DEFAULT_DRAIN_DEADLINE_MS = readPositiveIntEnv(
  "POSTIL_QUEUE_DRAIN_DEADLINE_MS",
  12 * 60 * 1000,
);

let backgroundDrain: Promise<void> | undefined;

export const PROCESSABLE_JOB_KINDS = [
  "webhook-dispatch",
  "review",
  "respond",
  "respond-delivery",
  "billing-contact-verification",
  "gate-state-sync",
  "check-run-cleanup",
  "respond-failure-comment",
  "webhook-comment",
] as const;

async function handleJob(
  job: ClaimedJob,
  processGroup: ObservabilityProcessGroup,
  signal?: AbortSignal,
  onReviewPublicationStarted?: () => void,
): Promise<void> {
  switch (job.kind) {
    case "webhook-dispatch": {
      const payload = job.payload as WebhookDispatchJobPayload;
      if (typeof payload.deliveryId !== "string" || !payload.deliveryId) {
        throw new Error("webhook dispatch job payload is malformed");
      }
      const delivery = await loadWebhookDelivery(getPool(), payload.deliveryId);
      if (!delivery) break;
      const { dispatchWebhookDelivery } = await import("@/lib/github/webhook-handler");
      await dispatchWebhookDelivery(delivery.event, delivery.payload, {
        deliveryId: delivery.deliveryId,
        triggerFollowupDrain: processGroup === "web",
      });
      await completeWebhookDelivery(getPool(), delivery.deliveryId);
      break;
    }
    case "review":
      await runReviewJob(
        job.payload as ReviewJobPayload,
        {
          queuedAt: job.createdAt,
          startedAt: job.lockedAt,
        },
        processGroup,
        signal,
        onReviewPublicationStarted,
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
      await runRespondFailureCommentJob(job.payload as RespondFailureCommentJobPayload);
      break;
    case "webhook-comment":
      await runWebhookCommentJob(job.payload as WebhookCommentJobPayload, job.id);
      break;
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}

export async function runClaimedJob(
  job: ClaimedJob,
  label: string,
  processGroup: ObservabilityProcessGroup = "worker",
  signal?: AbortSignal,
  onReviewPublicationStarted?: () => void,
): Promise<void> {
  const started = Date.now();
  console.log(`[${label}] job ${job.id} (${job.kind}) attempt ${job.attempts}`);
  try {
    await handleJob(job, processGroup, signal, onReviewPublicationStarted);
    await completeJob(getPool(), job);
    console.log(`[${label}] job ${job.id} done in ${Date.now() - started}ms`);
  } catch (err) {
    const message = redactSecrets(err);
    if (err instanceof WorkerShutdownError && job.kind === "review") {
      const requeued = await requeueJobsOwnedBy(
        getPool(),
        job.lockedBy,
        "worker shutdown interrupted the claim",
        ["review"],
        [job.id],
      );
      console.warn(`[${label}] job ${job.id} requeued after worker shutdown (${requeued})`);
      return;
    }
    const malformedGateSync =
      job.kind === "gate-state-sync" &&
      message.includes("gate state sync job payload is malformed");
    const malformedWebhookDispatch =
      job.kind === "webhook-dispatch" &&
      message.includes("webhook dispatch job payload is malformed");
    const invalidWebhookDelivery = err instanceof WebhookDeliveryStateError;
    const malformedWebhookComment =
      job.kind === "webhook-comment" &&
      message.includes("webhook comment job payload malformed");
    const permanent =
      malformedGateSync ||
      malformedWebhookDispatch ||
      invalidWebhookDelivery ||
      malformedWebhookComment ||
      (job.kind !== "gate-state-sync" &&
        job.kind !== "webhook-dispatch" &&
        job.kind !== "webhook-comment" &&
        isPermanentFailure(message));
    const reconcileIndefinitely =
      (job.kind === "gate-state-sync" && !malformedGateSync) ||
      (job.kind === "webhook-dispatch" && !malformedWebhookDispatch && !invalidWebhookDelivery) ||
      (job.kind === "webhook-comment" && !malformedWebhookComment);
    const outcome =
      reconcileIndefinitely
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
        job.id,
        undefined,
        undefined,
        false,
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

/** Process the exact durable inbox job accepted by one webhook request. */
export async function drainWebhookDispatch(
  deliveryId: string,
  label = "webhook-dispatch",
): Promise<boolean> {
  const workerId = `${label}-${hostname()}-${process.pid}`;
  const job = await claimJob(getPool(), workerId, ["webhook-dispatch"], {
    webhookDeliveryId: deliveryId,
  });
  if (!job) return false;
  await runClaimedJob(job, label, "web");
  return true;
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
