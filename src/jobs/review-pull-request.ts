import { logger, task } from "@trigger.dev/sdk";
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
    const result = await runReview(payload);
    return { ok: true, findings: result.findings.length };
  },
});
