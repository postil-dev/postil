import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GateBadge, ReviewStatusBadge } from "@/components/review-status";
import {
  HOSTED_REVIEW_UNAVAILABLE_MESSAGE,
  isHostedReviewUnavailable,
  reviewDisplayStatus,
  storedEnvelopeOperationallyUnavailable,
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

const OPERATIONAL_ENVELOPE = {
  findings: [
    {
      path: ".postil/model-output",
      severity: "error",
      kind: "uncertainty",
      title: "Model output could not be validated",
    },
  ],
};
const CLEAN_ENVELOPE = { findings: [] };
const ADVISORY_ENVELOPE = {
  findings: [
    {
      path: "src/index.ts",
      severity: "warn",
      kind: "correctness",
      title: "Unused import",
    },
  ],
};

describe("reviews that never reached a verdict", () => {
  test("does not report an operational failure as a completed review", () => {
    expect(reviewDisplayStatus("completed", null, OPERATIONAL_ENVELOPE)).toBe("failed");
  });

  test("recognizes every operational sentinel path", () => {
    for (const path of [".postil/model-output", ".postil/provider", ".postil/operational"]) {
      expect(storedEnvelopeOperationallyUnavailable({ findings: [{ path }] })).toBe(true);
      expect(reviewDisplayStatus("completed", null, { findings: [{ path }] })).toBe(
        "failed",
      );
    }
  });

  test("leaves a clean review and ordinary advisory findings reported as completed", () => {
    expect(reviewDisplayStatus("completed", null, CLEAN_ENVELOPE)).toBe("completed");
    expect(reviewDisplayStatus("completed", null, ADVISORY_ENVELOPE)).toBe("completed");
    expect(storedEnvelopeOperationallyUnavailable(ADVISORY_ENVELOPE)).toBe(false);
  });

  test("tolerates a missing or unrecognizable stored envelope", () => {
    expect(storedEnvelopeOperationallyUnavailable(null)).toBe(false);
    expect(storedEnvelopeOperationallyUnavailable("not an envelope")).toBe(false);
    expect(storedEnvelopeOperationallyUnavailable({ findings: "wrong" })).toBe(false);
    expect(storedEnvelopeOperationallyUnavailable({ findings: [{}, null] })).toBe(false);
    expect(reviewDisplayStatus("completed", null)).toBe("completed");
  });

  test("renders an operational failure without a passing review or gate", () => {
    const status = reviewDisplayStatus("completed", null, OPERATIONAL_ENVELOPE);
    const review = renderToStaticMarkup(
      ReviewStatusBadge({ status, gateFailing: false }),
    );
    const gate = renderToStaticMarkup(GateBadge({ gateFailing: false, status }));

    expect(review).toContain("failed");
    expect(review).not.toContain("completed");
    // The gate is reported separately and did not fail; it must not read as a
    // pass for a review that produced no verdict.
    expect(gate).not.toContain("passing");
    expect(gate).not.toContain("failing");
  });

  test("still renders a genuinely clean review as completed and passing", () => {
    const status = reviewDisplayStatus("completed", null, CLEAN_ENVELOPE);
    const review = renderToStaticMarkup(
      ReviewStatusBadge({ status, gateFailing: false }),
    );
    const gate = renderToStaticMarkup(GateBadge({ gateFailing: false, status }));

    expect(review).toContain("completed");
    expect(gate).toContain("passing");
  });

  test("leaves an advisory run with a passing gate unchanged", () => {
    const status = reviewDisplayStatus("completed", null, ADVISORY_ENVELOPE);
    const gate = renderToStaticMarkup(GateBadge({ gateFailing: false, status }));

    expect(status).toBe("completed");
    expect(gate).toContain("passing");
  });
});
