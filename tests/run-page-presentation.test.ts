import { expect, test } from "bun:test";

import { partitionRunFindingsForPresentation } from "@/app/orgs/[slug]/runs/[publicId]/run-presentation";
import type { Envelope, Finding } from "@/lib/envelope";

function finding(path: string): Finding {
  return {
    path,
    line: 1,
    severity: "error",
    kind: "uncertainty",
    confidence: 1,
    title: "Finding",
    body: "Finding body.",
  };
}

test("run page presents an all-sentinel envelope as operational diagnostics only", () => {
  const result = partitionRunFindingsForPresentation({
    findings: [finding(".postil/provider"), finding(".postil/model-output")],
  } as Pick<Envelope, "findings">);

  expect(result.noReviewerVerdict).toBe(true);
  expect(result.reviewerFindings).toEqual([]);
  expect(result.operationalDiagnostics.map((entry) => entry.path)).toEqual([
    ".postil/model-output",
    ".postil/provider",
  ]);
});

test("run page retains mixed envelopes in reviewer finding presentation", () => {
  const result = partitionRunFindingsForPresentation({
    findings: [finding(".postil/provider"), finding("src/review.ts")],
  } as Pick<Envelope, "findings">);

  expect(result.noReviewerVerdict).toBe(false);
  expect(result.operationalDiagnostics).toEqual([]);
  expect(result.reviewerFindings.map((entry) => entry.path)).toEqual([
    ".postil/provider",
    "src/review.ts",
  ]);
});
