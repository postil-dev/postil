import { describe, expect, test } from "bun:test";

import type { Envelope, Finding } from "@/lib/envelope";
import { priorReviewsWarrantPreventionHint } from "@/lib/review-prevention";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-a",
    path: "src/app.ts",
    line: 12,
    severity: "warn",
    kind: "risk",
    confidence: 0.8,
    title: "Retry loses state",
    body: "The retry starts from an empty state.",
    ...overrides,
  };
}

function envelope(findings: Finding[], silent = findings.length === 0): Envelope {
  return {
    version: 1,
    summary: "",
    silent,
    findings,
    resolved: [],
    counts: { info: 0, warn: findings.length, error: 0, suppressed: 0, ungrounded: 0 },
    confidenceBuckets: [0, 0, 0, findings.length, 0],
    gate: { failOn: "error", failing: false, blockOnKinds: [] },
    modelUsed: "test/model",
    usage: { promptTokens: 1, completionTokens: 1 },
    durationMs: 1,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    sinceSha: null,
  };
}

describe("repeat-review prevention guidance", () => {
  test("starts after the first actionable finding-bearing review", () => {
    expect(priorReviewsWarrantPreventionHint(envelope([finding()]), null)).toBe(true);
  });

  test("excludes silent and provider-only reviews", () => {
    expect(priorReviewsWarrantPreventionHint(envelope([]), null)).toBe(false);
    expect(
      priorReviewsWarrantPreventionHint(
        envelope([finding({ path: ".postil/provider" })]),
        null,
      ),
    ).toBe(false);
  });

  test("does not rearm after consecutive prior reviews carry the same findings", () => {
    const prior = envelope([finding({ id: "head-a:finding", line: 30 })]);
    expect(
      priorReviewsWarrantPreventionHint(
        envelope([finding({ id: "head-b:finding", line: 34 })]),
        prior,
      ),
    ).toBe(false);
    expect(
      priorReviewsWarrantPreventionHint(
        envelope([
          finding(),
          finding({ id: "finding-b", line: 30, title: "Timeout leaks reservation" }),
        ]),
        prior,
      ),
    ).toBe(true);
  });
});
