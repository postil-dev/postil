import { describe, expect, test } from "bun:test";

import {
  HOSTED_REVIEW_UNAVAILABLE_MESSAGE,
  isHostedReviewUnavailable,
  reviewDisplayStatus,
} from "@/lib/review-outcome";

describe("review display outcome", () => {
  test("labels only the managed-review pause as unavailable", () => {
    expect(
      reviewDisplayStatus("failed", HOSTED_REVIEW_UNAVAILABLE_MESSAGE),
    ).toBe("unavailable");
    expect(isHostedReviewUnavailable("failed", HOSTED_REVIEW_UNAVAILABLE_MESSAGE)).toBe(
      true,
    );
  });

  test("keeps genuine and unrelated failures visible", () => {
    expect(reviewDisplayStatus("failed", "provider request timed out")).toBe("failed");
    expect(reviewDisplayStatus("completed", HOSTED_REVIEW_UNAVAILABLE_MESSAGE)).toBe(
      "completed",
    );
  });
});
