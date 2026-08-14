import { describe, expect, test } from "bun:test";

import {
  normalizeReviewTriggerContext,
  reviewRequiresFullDiff,
} from "@/lib/review-trigger";

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
        webhookDeliveryId: "   ",
        webhookEvent: "issue_comment",
      }),
    ).toEqual({ source: "unknown" });
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
    expect(
      normalizeReviewTriggerContext({
        source: "requested_review",
        webhookDeliveryId: "delivery-4",
        webhookEvent: "issue_comment",
        sourceUrl: " https://github.com/octo/repo/issues/1 ",
      }),
    ).toEqual({
      source: "requested_review",
      webhookDeliveryId: "delivery-4",
      webhookEvent: "issue_comment",
    });
  });

  test("keeps exact finding reconciliation provenance", () => {
    expect(
      normalizeReviewTriggerContext({
        source: "finding_reconciliation",
        webhookDeliveryId: "delivery-reconcile-1",
        webhookEvent: "pull_request_review_thread",
        webhookAction: "resolved",
        sourceCommentId: 8800,
        sourceUrl: "https://github.com/octo/repo/pull/9#discussion_r8800",
        requestedByGithubId: 501,
        requestedByLogin: "maintainer",
      }),
    ).toEqual({
      source: "finding_reconciliation",
      webhookDeliveryId: "delivery-reconcile-1",
      webhookEvent: "pull_request_review_thread",
      webhookAction: "resolved",
      sourceCommentId: 8800,
      sourceUrl: "https://github.com/octo/repo/pull/9#discussion_r8800",
      requestedByGithubId: 501,
      requestedByLogin: "maintainer",
    });
    expect(
      normalizeReviewTriggerContext({
        source: "finding_reconciliation",
        webhookDeliveryId: "delivery-reconcile-2",
        webhookEvent: "issue_comment",
      }),
    ).toEqual({ source: "unknown" });
  });
});

describe("review diff selection", () => {
  test("uses a full diff for explicit intent or a changed base", () => {
    expect(
      reviewRequiresFullDiff({
        requested: true,
        baselineBaseSha: "base",
        currentBaseSha: "base",
      }),
    ).toBe(true);
    expect(
      reviewRequiresFullDiff({
        requested: false,
        baselineBaseSha: "old-base",
        currentBaseSha: "new-base",
      }),
    ).toBe(true);
    expect(
      reviewRequiresFullDiff({
        requested: false,
        baselineBaseSha: "base",
        currentBaseSha: "base",
      }),
    ).toBe(false);
  });
});
