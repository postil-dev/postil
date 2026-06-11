import type { ReviewFinding } from "@/jobs/review-types";

export type ReviewFindingExpectation = {
  path: string;
  line?: number;
  severity?: ReviewFinding["severity"];
  bodyIncludes?: string;
};

export type ReviewScoringMetrics = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  severityMatches: number;
  fileLineMatches: number;
  commentUsefulness: number;
};

export function scoreReviewFindings(
  expected: ReviewFindingExpectation[],
  actual: ReviewFinding[],
): ReviewScoringMetrics {
  const matchedActual = new Set<number>();
  let truePositives = 0;
  let severityMatches = 0;
  let fileLineMatches = 0;
  let commentUsefulness = 0;

  for (const expectedFinding of expected) {
    const matchIndex = actual.findIndex(
      (finding, index) =>
        !matchedActual.has(index) &&
        finding.path === expectedFinding.path &&
        (expectedFinding.line === undefined || finding.line === expectedFinding.line),
    );
    if (matchIndex === -1) continue;

    matchedActual.add(matchIndex);
    truePositives += 1;
    const finding = actual[matchIndex];
    if (expectedFinding.severity === undefined || finding.severity === expectedFinding.severity) {
      severityMatches += 1;
    }
    if (expectedFinding.line !== undefined && finding.line === expectedFinding.line) {
      fileLineMatches += 1;
    }
    if (
      expectedFinding.bodyIncludes === undefined ||
      finding.body.includes(expectedFinding.bodyIncludes)
    ) {
      commentUsefulness += 1;
    }
  }

  return {
    truePositives,
    falsePositives: actual.length - matchedActual.size,
    falseNegatives: expected.length - truePositives,
    severityMatches,
    fileLineMatches,
    commentUsefulness,
  };
}

export function emptyReviewScoringMetrics(): ReviewScoringMetrics {
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    severityMatches: 0,
    fileLineMatches: 0,
    commentUsefulness: 0,
  };
}
