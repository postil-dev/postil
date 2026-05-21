import { eq } from "drizzle-orm";
import { auth, logger, task } from "@trigger.dev/sdk/v3";
import { getDb, schema } from "@/db";
import { recordReviewCompleted, recordTokenUsage } from "@/lib/usage";
import { captureException, hashInstallationId, track } from "@/lib/posthog";
import { env } from "@/lib/env";
import {
  resolveReviewModelUsed,
  selectedReviewModel,
} from "./review-models";
import { reviewPayload, runReview } from "./run-review";

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

    track("system", "review_started", {
      repoFullName: payload.repoFullName,
      pullNumber: payload.pullNumber,
      headSha: payload.headSha,
      modelUsed: reviewModelUsed,
      installationHash: await hashInstallationId(payload.installationId),
    });

    try {
      const result = await runReview(payload);

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
      captureException(err, {
        properties: {
          op: "review",
          repoFullName: payload.repoFullName,
          pullNumber: payload.pullNumber,
          headSha: payload.headSha,
        },
      });

      if (payload.reviewId) {
        try {
          const db = getDb();
          await db
            .update(schema.reviews)
            .set({
              status: "failed",
              errorMessage: String(
                err instanceof Error ? err.message : err,
              ),
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
        error: String(err instanceof Error ? err.message : err),
        errorClass: err instanceof Error ? err.name : "unknown",
        modelUsed: resolveReviewModelUsed(err, reviewModelUsed),
        installationHash: await hashInstallationId(payload.installationId),
      });

      // runReview already attempts to mark the check-run as failed before
      // re-throwing; rethrow here so Trigger.dev retries fire if configured.
      throw err;
    }
  },
});

export async function enqueueReviewPullRequest(
  payload: import("./run-review").ReviewPayload,
  idempotencyKey: string,
) {
  ensureTriggerConfigured();
  return reviewPullRequest.trigger(payload, { idempotencyKey });
}
