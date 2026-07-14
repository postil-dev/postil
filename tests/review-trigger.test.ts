import { describe, expect, test } from "bun:test";

import { normalizeReviewTriggerContext } from "@/lib/review-trigger";

describe("review trigger context", () => {
  test("keeps auditable fields from a valid requested review", () => {
    expect(
      normalizeReviewTriggerContext({
        source: "requested_review",
        webhookDeliveryId: "delivery-1",
        webhookEvent: "issue_comment",
        webhookAction: "created",
        sourceCommentId: 123,
        sourceUrl: "https://github.com/octo/repo/pull/1#issuecomment-123",
        requestedByGithubId: 456,
        requestedByLogin: "octocat",
      }),
    ).toEqual({
      source: "requested_review",
      webhookDeliveryId: "delivery-1",
      webhookEvent: "issue_comment",
      webhookAction: "created",
      sourceCommentId: 123,
      sourceUrl: "https://github.com/octo/repo/pull/1#issuecomment-123",
      requestedByGithubId: 456,
      requestedByLogin: "octocat",
    });
  });

  test("fails closed when source evidence is absent or inconsistent", () => {
    expect(normalizeReviewTriggerContext({ source: "requested_review" })).toEqual({
      source: "unknown",
    });
    expect(
      normalizeReviewTriggerContext({
        source: "requested_review",
        webhookDeliveryId: "delivery-2",
        webhookEvent: "check_run",
      }),
    ).toEqual({ source: "unknown" });
  });

  test("drops unsafe source links and unrelated payload fields", () => {
    expect(
      normalizeReviewTriggerContext({
        source: "requested_review",
        webhookDeliveryId: "delivery-3",
        webhookEvent: "pull_request_review_comment",
        sourceUrl: "javascript:alert(1)",
        commentBody: "not part of provenance",
      }),
    ).toEqual({
      source: "requested_review",
      webhookDeliveryId: "delivery-3",
      webhookEvent: "pull_request_review_comment",
    });
  });
});
