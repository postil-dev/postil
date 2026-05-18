import { eq } from "drizzle-orm";
import { logger, task } from "@trigger.dev/sdk";
import { getDb, schema } from "@/db";
import { captureException, track } from "@/lib/posthog";
import { reviewPayload, runReview } from "./run-review";

// Trigger.dev-flavoured wrapper around runReview. Identical business logic;
// this path is used once a Trigger.dev worker is deployed. The webhook
// currently invokes runReview inline via Next.js `after()`.
export const reviewPullRequest = task({
  id: "review-pull-request",
  maxDuration: 10 * 60,
  run: async (raw: unknown) => {
    const payload = reviewPayload.parse(raw);
    logger.info("starting review", { payload });
    const started = Date.now();

    try {
      const result = await runReview(payload);

      if (payload.reviewId) {
        const db = getDb();
        await db
          .update(schema.reviews)
          .set({
            status: "completed",
            result,
            completedAt: new Date(),
          })
          .where(eq(schema.reviews.id, payload.reviewId));
      }

      track("system", "review_completed", {
        repoFullName: payload.repoFullName,
        pullNumber: payload.pullNumber,
        findings: result.findings.length,
        durationMs: Date.now() - started,
      });

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
      }

      // runReview already attempts to mark the check-run as failed before
      // re-throwing; rethrow here so Trigger.dev retries fire if configured.
      throw err;
    }
  },
});
