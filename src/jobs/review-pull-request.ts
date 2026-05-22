import { auth, logger, task } from "@trigger.dev/sdk/v3";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { env } from "@/lib/env";
import { installationOctokit } from "@/lib/github";
import { captureException, hashInstallationId, track } from "@/lib/posthog";
import { recordReviewCompleted, recordTokenUsage } from "@/lib/usage";
import { resolveReviewModelUsed, selectedReviewModel } from "./review-models";
import {
  isOpenRouterCascadeError,
  publicReviewErrorMessage,
  type ReviewClients,
  type ReviewPayload,
  reviewPayload,
  runReview,
} from "./run-review";

let triggerConfigured = false;

function ensureTriggerConfigured(): void {
  if (triggerConfigured) return;
  if (!env.TRIGGER_API_KEY) {
    throw new Error("TRIGGER_API_KEY must be set to dispatch review tasks");
  }

  auth.configure({
    baseURL: env.TRIGGER_API_URL,
    accessToken: env.TRIGGER_API_KEY,
  });
  triggerConfigured = true;
}

type InstallationClient = NonNullable<ReviewClients["installation"]>;

const CHECK_RUN_REMEDIATION = "Restore GitHub App authentication and rerun the review.";
const CHECK_RUN_UNAVAILABLE_MESSAGE = `Review setup failed before a GitHub check client was available; the existing review check cannot be completed automatically. ${CHECK_RUN_REMEDIATION}`;
const SANITIZED_SETUP_FAILURE_MESSAGE = "Review setup failed before execution could start.";

function classifySetupFailure(err: unknown): { error: Error; errorClass: string } {
  const errorClass = err instanceof Error ? err.name : typeof err;
  const error = new Error(SANITIZED_SETUP_FAILURE_MESSAGE);
  error.name = "ReviewSetupError";
  error.stack = undefined;
  return { error, errorClass };
}

async function createInstallationClient(
  payload: ReviewPayload,
): Promise<InstallationClient | null> {
  if (!payload.checkRunId) return null;
  return installationOctokit(payload.installationId);
}

// Trigger.dev-flavoured wrapper around runReview. The webhook enqueues this
// task so the review work runs through the CLI runner.
export const reviewPullRequest = task({
  id: "review-pull-request",
  maxDuration: 10 * 60,
  run: async (raw: unknown) => {
    const payload = reviewPayload.parse(raw);
    logger.info("starting review", { payload });
    const started = Date.now();
    const reviewModelUsed = selectedReviewModel(env.REVIEW_MODEL_CASCADE, env.REVIEW_MODEL);
    let runReviewStarted = false;
    let setupFailureInstallationClient: InstallationClient | null = null;
    let installationHash: string | undefined;

    try {
      setupFailureInstallationClient = await createInstallationClient(payload);
      installationHash = await hashInstallationId(payload.installationId);
      track("system", "review_started", {
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
        headSha: payload.headSha,
        modelUsed: reviewModelUsed,
        installationHash,
      });

      runReviewStarted = true;
      const result = await runReview(payload, {
        installation: setupFailureInstallationClient ?? undefined,
      });

      if (payload.reviewId) {
        try {
          const db = getDb();
          await db
            .update(schema.reviews)
            .set({
              status: "completed",
              result,
              completedAt: new Date(),
            })
            .where(eq(schema.reviews.id, payload.reviewId));
        } catch (dbErr) {
          captureException(dbErr, {
            properties: {
              op: "update_review_completed",
              repoFullName: payload.repoFullName,
              pullNumber: payload.pullNumber,
            },
          });
        }
      }

      track("system", "review_completed", {
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
        findings: result.findings.length,
        durationMs: Date.now() - started,
        modelUsed: resolveReviewModelUsed(result, reviewModelUsed),
        installationHash: await hashInstallationId(payload.installationId),
      });

      try {
        if (payload.reviewId) {
          await recordReviewCompleted(payload.installationId, payload.reviewId);
          await recordTokenUsage(payload.installationId, payload.reviewId, result.usage);
        }
      } catch (usageErr) {
        captureException(usageErr, {
          properties: {
            op: "record_usage",
            repoFullName: payload.repoFullName,
            pullNumber: payload.pullNumber,
          },
        });
      }

      return { ok: true, findings: result.findings.length };
    } catch (err) {
      if (!runReviewStarted) {
        if (setupFailureInstallationClient) {
          await completeCheckRunAfterTaskSetupFailure(payload, err, setupFailureInstallationClient);
        } else {
          reportUnavailableCheckRunCompletion(payload, err);
        }
      }

      const setupFailure = runReviewStarted ? null : classifySetupFailure(err);
      const reportedError = setupFailure ? setupFailure.error : err;
      captureException(reportedError, {
        properties: {
          op: "review",
          repoFullName: payload.repoFullName,
          pullNumber: payload.pullNumber,
          headSha: payload.headSha,
          errorClass: setupFailure?.errorClass,
          modelUsed: resolveReviewModelUsed(err, reviewModelUsed),
          attemptedModels: isOpenRouterCascadeError(err) ? err.attemptedModels : undefined,
          providerFailures: isOpenRouterCascadeError(err) ? err.providerFailures : undefined,
        },
      });

      if (payload.reviewId) {
        try {
          const db = getDb();
          await db
            .update(schema.reviews)
            .set({
              status: "failed",
              errorMessage: publicReviewErrorMessage(reportedError),
              completedAt: new Date(),
            })
            .where(eq(schema.reviews.id, payload.reviewId));
        } catch (dbErr) {
          captureException(dbErr, {
            properties: {
              op: "update_review_failed",
              repoFullName: payload.repoFullName,
              pullNumber: payload.pullNumber,
            },
          });
        }
      }

      track("system", "review_failed", {
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
        headSha: payload.headSha,
        error: publicReviewErrorMessage(err),
        errorClass: err instanceof Error ? err.name : "unknown",
        modelUsed: resolveReviewModelUsed(err, reviewModelUsed),
        attemptedModels: isOpenRouterCascadeError(err) ? err.attemptedModels : undefined,
        providerFailures: isOpenRouterCascadeError(err) ? err.providerFailures : undefined,
        installationHash,
      });

      // runReview owns check-run completion once it starts. The fallback above
      // only covers setup failures before the review runner is entered.
      throw reportedError;
    }
  },
});

function reportUnavailableCheckRunCompletion(payload: ReviewPayload, err: unknown): void {
  if (!payload.checkRunId) return;

  const setupFailure = classifySetupFailure(err);
  console.error("[check-run]", CHECK_RUN_UNAVAILABLE_MESSAGE, {
    errorClass: setupFailure.errorClass,
  });
  captureException(setupFailure.error, {
    properties: {
      op: "review_check_completion_unavailable",
      repoFullName: payload.repoFullName,
      pullNumber: payload.pullNumber,
      headSha: payload.headSha,
      checkRunId: payload.checkRunId,
      errorClass: setupFailure.errorClass,
      requiredAction: CHECK_RUN_REMEDIATION,
    },
  });
}

async function completeCheckRunAfterTaskSetupFailure(
  payload: ReviewPayload,
  err: unknown,
  checkRunClient: InstallationClient | null,
): Promise<void> {
  if (!payload.checkRunId || !checkRunClient) return;

  try {
    const [owner, repo] = payload.repoFullName.split("/");
    await checkRunClient.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner,
      repo,
      check_run_id: payload.checkRunId,
      status: "completed",
      conclusion: "failure",
      completed_at: new Date().toISOString(),
      output: {
        title: "Postil Review",
        summary: publicReviewErrorMessage(err),
        text: publicReviewErrorMessage(err),
      },
    });
  } catch (patchErr) {
    captureException(patchErr, {
      properties: {
        op: "complete_check_run_after_task_failure",
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
      },
    });
  }
}

export async function enqueueReviewPullRequest(
  payload: import("./run-review").ReviewPayload,
  idempotencyKey: string,
) {
  ensureTriggerConfigured();
  return reviewPullRequest.trigger(payload, { idempotencyKey });
}
