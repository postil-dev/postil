import { hostname } from "node:os";

import { getDb, getPool } from "@/lib/db";
import { optionalEnv, readPositiveIntEnv, requireEnv } from "@/lib/env";
import {
  recordCustomerNotificationEmailFailure,
  runCustomerNotificationEmailJob,
  type CustomerNotificationEmailJobPayload,
} from "@/lib/customer-notification-email";
import type { GateStateSyncJobPayload } from "@/lib/finding-approvals";
import {
  claimJob,
  continueClaimedJob,
  completeWebhookDelivery,
  completeJob,
  externalSideEffectLeaseActive,
  failJob,
  isBoundedJobRetryError,
  isPermanentJobError,
  loadWebhookDelivery,
  requeueJobsOwnedBy,
  retryJobIndefinitely,
  type CheckRunCleanupJobPayload,
  type ClaimedJob,
  type GateEnforcementSweepJobPayload,
  type GithubReactionJobPayload,
  HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
  type HostedProviderKeyLifecycleJobPayload,
  type RespondDeliveryJobPayload,
  type RespondFailureCommentJobPayload,
  type RespondJobPayload,
  type ReviewJobPayload,
  type WebhookCommentJobPayload,
  WebhookDeliveryStateError,
  type WebhookDispatchJobPayload,
} from "@/lib/queue";
import { redactSecrets } from "@/lib/redact";
import { reconcileFindingFeedbackReactions } from "@/lib/finding-feedback";
import {
  deferHostedProviderKeyLifecycleForRelease,
  deferHostedReviewForRelease,
  HostedInferenceReleaseDarkError,
  PublicationLifecycleReleaseDarkError,
  withPublicationLifecycleReleaseActive,
} from "@/lib/release-job-rollout";
import {
  reportOperationalFailure,
  reportOperationalWarning,
  type ObservabilityProcessGroup,
} from "@/lib/server-observability";
import { WorkerInterruptionRehearsalError } from "@/lib/private-worker-rehearsal";
import {
  ensureOperatorAlertDelivery,
  normalizeLegacyOperatorAlertPayload,
  recordOperatorAlertDelivered,
  recordOperatorAlertFailure,
} from "@/lib/operator-alerts";
import {
  runBillingSettlement,
  type BillingSettlementJobPayload,
} from "@/lib/paddle-billing";
import {
  runBillingContactVerificationJob,
  type BillingContactVerificationJobPayload,
} from "./billing-contact-verification";
import { isForgeTargetGoneError, isPermanentFailure } from "./failure-classifier";
import { runGithubReactionJob } from "./github-reaction";
import { runHostedProviderKeyLifecycleJob } from "./hosted-provider-key-lifecycle";
import { runGateStateSyncJob } from "./gate-state-sync";
import { runGateEnforcementSweepJob } from "./gate-enforcement-sweep";
import {
  runOperatorAlertJob,
  type OperatorAlertJobPayload,
  validateOperatorAlertPayload,
} from "./operator-alert";
import {
  runRespondDeliveryJob,
  runRespondFailureCommentJob,
  runRespondJob,
  runWebhookCommentJob,
} from "./respond";
import {
  runCheckRunCleanupJob,
  runReviewJob,
  ReviewPublicationReconciliationError,
  validateCheckRunCleanupPayload,
  WorkerShutdownError,
} from "./review";
import { watchdogPass } from "./watchdog";

const DEFAULT_DRAIN_MAX_JOBS = readPositiveIntEnv(
  "POSTIL_QUEUE_DRAIN_MAX_JOBS",
  1,
);
const DEFAULT_DRAIN_DEADLINE_MS = readPositiveIntEnv(
  "POSTIL_QUEUE_DRAIN_DEADLINE_MS",
  12 * 60 * 1000,
);

let backgroundDrain: Promise<void> | undefined;
let backgroundDrainRequested = false;

export const WEB_PROCESSABLE_JOB_KINDS = [
  "webhook-dispatch",
  "review",
  "respond",
  "respond-delivery",
  "billing-contact-verification",
  "billing-settlement",
  "operator-alert",
  "customer-notification-email",
  "gate-state-sync",
  "check-run-cleanup",
  "respond-failure-comment",
  "webhook-comment",
  "github-reaction",
  "finding-feedback-reconciliation",
] as const;

export const PROCESSABLE_JOB_KINDS = [
  ...WEB_PROCESSABLE_JOB_KINDS,
  "gate-enforcement-sweep",
  HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND,
] as const;

interface JobContinuation {
  payload: Record<string, unknown>;
  runAfter?: Date;
}

async function handleJob(
  job: ClaimedJob,
  processGroup: ObservabilityProcessGroup,
  signal?: AbortSignal,
  onReviewPublicationStarted?: () => void,
): Promise<JobContinuation | void> {
  switch (job.kind) {
    case "webhook-dispatch": {
      const payload = job.payload as WebhookDispatchJobPayload;
      if (typeof payload.deliveryId !== "string" || !payload.deliveryId) {
        throw new Error("webhook dispatch job payload is malformed");
      }
      const delivery = await loadWebhookDelivery(getPool(), payload.deliveryId);
      if (!delivery) break;
      const { dispatchWebhookDelivery } =
        await import("@/lib/github/webhook-handler");
      try {
        await dispatchWebhookDelivery(delivery.event, delivery.payload, {
          deliveryId: delivery.deliveryId,
          triggerFollowupDrain: processGroup === "web",
          attempt: job.attempts,
        });
      } catch (error) {
        // A single 404 can be an installation-token propagation blip right
        // after install, so the first attempt always retries; a repeat 404
        // after backoff means the webhook's subject no longer exists on the
        // forge (or access to it was revoked), and no retry or GitHub
        // redelivery can ever dispatch it. Reaching a terminal state keeps
        // the pending-age monitor scoped to deliveries that can complete.
        if (!isForgeTargetGoneError(error) || job.attempts <= 1) throw error;
        console.warn(
          `[worker] webhook delivery ${delivery.deliveryId} target is gone; completing without dispatch: ${redactSecrets(error)}`,
        );
      }
      await completeWebhookDelivery(getPool(), delivery.deliveryId);
      break;
    }
    case "review":
      await runReviewJob(
        job.payload as ReviewJobPayload,
        {
          queuedAt: job.createdAt,
          startedAt: job.lockedAt,
          lease: job,
        },
        processGroup,
        signal,
        onReviewPublicationStarted,
      );
      break;
    case "respond":
      await runRespondJob(job.payload as RespondJobPayload, job);
      break;
    case "respond-delivery":
      await runRespondDeliveryJob(job.payload as RespondDeliveryJobPayload, job);
      break;
    case "billing-contact-verification":
      await runBillingContactVerificationJob(
        job.payload as BillingContactVerificationJobPayload,
      );
      break;
    case "billing-settlement":
      await runBillingSettlement(
        getDb(),
        job.payload as unknown as BillingSettlementJobPayload,
      );
      break;
    case "operator-alert": {
      const payload = normalizeLegacyOperatorAlertPayload(job.payload);
      if (!payload) throw new Error("operator alert job payload is malformed");
      validateOperatorAlertPayload(payload);
      await ensureOperatorAlertDelivery(getDb(), payload, job.createdAt);
      const result = await runOperatorAlertJob(payload);
      await recordOperatorAlertDelivered(getDb(), payload, result.messageId);
      break;
    }
    case "customer-notification-email":
      await runCustomerNotificationEmailJob(
        getDb(),
        job.payload as CustomerNotificationEmailJobPayload,
        {
          publicOrigin: requireEnv("POSTIL_PUBLIC_URL"),
          apiKey: requireEnv("BREVO_API_KEY"),
        },
      );
      break;
    case "gate-state-sync":
      await withPublicationLifecycleReleaseActive(
        getPool(),
        async (db, client) => {
          if (!(await externalSideEffectLeaseActive(client, job))) return;
          await runGateStateSyncJob(job.payload as GateStateSyncJobPayload, {
            db,
          });
        },
      );
      break;
    case "gate-enforcement-sweep":
      return runGateEnforcementSweepJob(
        job.payload as GateEnforcementSweepJobPayload,
      );
    case "check-run-cleanup":
      validateCheckRunCleanupPayload(
        job.payload as CheckRunCleanupJobPayload,
      );
      await runCheckRunCleanupJob(job.payload as CheckRunCleanupJobPayload);
      break;
    case "respond-failure-comment":
      await runRespondFailureCommentJob(
        job.payload as RespondFailureCommentJobPayload,
        job,
      );
      break;
    case "webhook-comment":
      await runWebhookCommentJob(
        job.payload as WebhookCommentJobPayload,
        job,
      );
      break;
    case "github-reaction":
      await runGithubReactionJob(
        job.payload as GithubReactionJobPayload,
        job,
      );
      break;
    case "finding-feedback-reconciliation": {
      const findingPublicationId = job.payload.findingPublicationId;
      if (
        typeof findingPublicationId !== "number" ||
        !Number.isSafeInteger(findingPublicationId) ||
        findingPublicationId <= 0
      ) {
        throw new Error("finding feedback reconciliation job payload is malformed");
      }
      await reconcileFindingFeedbackReactions(getDb(), findingPublicationId);
      break;
    }
    case HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND:
      return runHostedProviderKeyLifecycleJob(
        job.payload as HostedProviderKeyLifecycleJobPayload,
      );
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
    const continuation = await handleJob(
      job,
      processGroup,
      signal,
      onReviewPublicationStarted,
    );
    if (continuation) {
      await continueClaimedJob(getPool(), job, continuation.payload, {
        runAfter: continuation.runAfter,
      });
      console.log(`[${label}] job ${job.id} continued in ${Date.now() - started}ms`);
      return;
    }
    await completeJob(getPool(), job);
    console.log(`[${label}] job ${job.id} done in ${Date.now() - started}ms`);
  } catch (err) {
    if (err instanceof WorkerInterruptionRehearsalError) throw err;
    const message = redactSecrets(err);
    if (err instanceof WorkerShutdownError && job.kind === "review") {
      const requeued = await requeueJobsOwnedBy(
        getPool(),
        job.lockedBy,
        "worker shutdown interrupted the claim",
        ["review"],
        [job.id],
      );
      console.warn(
        `[${label}] job ${job.id} requeued after worker shutdown (${requeued})`,
      );
      return;
    }
    if (err instanceof HostedInferenceReleaseDarkError && job.kind === "review") {
      const outcome = await deferHostedReviewForRelease(
        getPool(),
        job,
        err.releaseSha,
      );
      console.warn(
        `[${label}] review job ${job.id} ${outcome} across managed release activation`,
      );
      return;
    }
    if (
      err instanceof HostedInferenceReleaseDarkError &&
      job.kind === HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND
    ) {
      const outcome = await deferHostedProviderKeyLifecycleForRelease(
        getPool(),
        job,
        err.releaseSha,
      );
      console.warn(
        `[${label}] hosted provider key lifecycle job ${job.id} ${outcome} across managed release activation`,
      );
      return;
    }
    const malformedGateSync =
      job.kind === "gate-state-sync" &&
      message.includes("gate state sync job payload is malformed");
    const malformedGateEnforcement =
      job.kind === "gate-enforcement-sweep" &&
      message.includes("gate enforcement sweep job payload is malformed");
    const malformedWebhookDispatch =
      job.kind === "webhook-dispatch" &&
      message.includes("webhook dispatch job payload is malformed");
    const invalidWebhookDelivery = err instanceof WebhookDeliveryStateError;
    const boundedWebhookRetry =
      job.kind === "webhook-dispatch" && isBoundedJobRetryError(err);
    const malformedWebhookComment =
      job.kind === "webhook-comment" &&
      message.includes("webhook comment job payload malformed");
    const malformedGithubReaction =
      job.kind === "github-reaction" &&
      message.includes("github reaction job payload is malformed");
    const malformedFindingFeedbackReconciliation =
      job.kind === "finding-feedback-reconciliation" &&
      message.includes("finding feedback reconciliation job payload is malformed");
    const malformedCheckRunCleanup =
      job.kind === "check-run-cleanup" &&
      message.includes("check-run cleanup job payload is malformed");
    const malformedHostedProviderKeyLifecycle =
      job.kind === HOSTED_PROVIDER_KEY_LIFECYCLE_JOB_KIND &&
      message.includes(
        "hosted provider key lifecycle job payload is malformed",
      );
    const permanent =
      isPermanentJobError(err) ||
      malformedGateSync ||
      malformedGateEnforcement ||
      malformedWebhookDispatch ||
      invalidWebhookDelivery ||
      malformedWebhookComment ||
      malformedGithubReaction ||
      malformedFindingFeedbackReconciliation ||
      malformedCheckRunCleanup ||
      malformedHostedProviderKeyLifecycle ||
      (job.kind !== "gate-state-sync" &&
        job.kind !== "gate-enforcement-sweep" &&
        job.kind !== "webhook-dispatch" &&
        job.kind !== "webhook-comment" &&
        job.kind !== "github-reaction" &&
        isPermanentFailure(message));
    const reconcileIndefinitely =
      (job.kind === "gate-state-sync" && !malformedGateSync) ||
      (job.kind === "webhook-dispatch" &&
        !malformedWebhookDispatch &&
        !invalidWebhookDelivery &&
        !boundedWebhookRetry) ||
      (job.kind === "webhook-comment" && !malformedWebhookComment) ||
      (job.kind === "github-reaction" && !malformedGithubReaction) ||
      err instanceof ReviewPublicationReconciliationError ||
      err instanceof PublicationLifecycleReleaseDarkError;
    const outcome = reconcileIndefinitely
      ? await retryJobIndefinitely(
          getPool(),
          job,
          message,
          err instanceof ReviewPublicationReconciliationError
            ? { startedAt: err.reconciliationStartedAt }
            : err instanceof PublicationLifecycleReleaseDarkError
              ? { startedAt: job.lockedAt }
              : undefined,
        )
      : await failJob(getPool(), job, message, {
          permanent,
          ...(job.kind === "respond"
            ? {
                failureFollowup: {
                  kind: "respond-failure-comment" as const,
                  payload: { ...job.payload, respondJobId: job.id },
                  maxAttempts: 5,
                },
              }
            : {}),
        });
    if (job.kind === "operator-alert") {
      const payload = normalizeLegacyOperatorAlertPayload(job.payload);
      if (payload) {
        await recordOperatorAlertFailure(
          getDb(),
          payload,
          message,
          outcome === "failed",
        ).catch((auditError) => {
          console.error(
            `[${label}] operator alert audit update failed: ${redactSecrets(auditError)}`,
          );
        });
      }
    }
    if (job.kind === "customer-notification-email") {
      await recordCustomerNotificationEmailFailure(
        getDb(),
        job.payload,
        message,
        outcome === "failed",
      ).catch((auditError) => {
        console.error(
          `[${label}] customer notification email audit update failed: ${redactSecrets(auditError)}`,
        );
      });
    }
    console.error(
      `[${label}] job ${job.id} ${outcome}${permanent ? " (permanent)" : ""}: ${message}`,
    );
    if (outcome === "failed" || outcome === "exhausted") {
      reportOperationalFailure(processGroup, "job_permanently_failed", err);
    } else if (outcome === "retried") {
      reportOperationalWarning(processGroup, "job_retrying");
    }
  }
}

export async function drainQueueOnce(
  label: string,
  opts: { maxJobs?: number; deadlineMs?: number } = {},
): Promise<number> {
  const maxJobs = Math.max(1, opts.maxJobs ?? DEFAULT_DRAIN_MAX_JOBS);
  const deadlineAt =
    Date.now() + Math.max(1_000, opts.deadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS);
  const workerId = `${label}-${hostname()}-${process.pid}`;
  let drained = 0;

  await watchdogPass().catch((err) => {
    console.error(
      `[${label}] watchdog pass failed before drain: ${redactSecrets(err)}`,
    );
  });

  while (drained < maxJobs && Date.now() < deadlineAt) {
    const job = await claimJob(getPool(), workerId, WEB_PROCESSABLE_JOB_KINDS, {
      excludePrivateWorkerRehearsals: true,
    });
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
    exactWebhookDispatchDeliveryId: deliveryId,
  });
  if (!job) return false;
  await runClaimedJob(job, label, "web");
  return true;
}

export function triggerQueueDrain(reason: string): void {
  if (optionalEnv("POSTIL_WEBHOOK_DRAIN_ENABLED", "0") !== "1") return;
  backgroundDrainRequested = true;
  if (backgroundDrain) return;
  const label = `web-drain:${reason.replace(/[^a-z0-9_-]/gi, "_")}`;
  backgroundDrain = runCoalescedQueueDrains(label);
}

async function runCoalescedQueueDrains(label: string): Promise<void> {
  let pass = 0;
  try {
    while (true) {
      backgroundDrainRequested = false;
      pass += 1;
      const passLabel = `${label}:${pass}`;
      try {
        const count = await drainQueueOnce(passLabel);
        if (count > 0) console.log(`[${passLabel}] drained ${count} job(s)`);
      } catch (err) {
        console.error(`[${passLabel}] drain failed: ${redactSecrets(err)}`);
      }
      if (backgroundDrainRequested) continue;
      return;
    }
  } finally {
    const followUpRequested = backgroundDrainRequested;
    backgroundDrain = undefined;
    if (followUpRequested) triggerQueueDrain(`${label}:settlement`);
  }
}

// Re-exported so existing importers (`@/worker/runner`, `./runner`) keep
// working; `@/lib/queue` also needs this helper for its own env-overridable
// budget and cannot import it from here without a static import cycle.
export { readPositiveIntEnv };
