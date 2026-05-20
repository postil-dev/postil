import { readFileSync } from "node:fs";
import type { Finding } from "./run-review";
import { REVIEW_MODEL_RESEARCH_CANDIDATES } from "./review-models";

type ExpectedFinding = {
  path: string;
  line: number;
  severity: Finding["severity"];
  bodyIncludes?: string;
};

type ModelOutput = {
  summary: string;
  findings: Finding[];
};

export type ReviewModelEvalCase = {
  id: string;
  expectedFindings: ExpectedFinding[];
  modelOutputs: Record<string, ModelOutput>;
};

export type ReviewModelEvalResult = {
  model: string;
  cases: number;
  expectedActionableFindings: number;
  actionableFindings: number;
  missedActionableFindings: number;
  falsePositiveFindings: number;
  cleanCaseNoiseFindings: number;
  severityMismatches: number;
  actionableRate: number;
};

export type ReviewModelEvalReport = {
  candidates: string[];
  recommendedFixturePrimary: string | null;
  results: ReviewModelEvalResult[];
};

function matchesExpected(finding: Finding, expected: ExpectedFinding): boolean {
  const bodyMatches = expected.bodyIncludes
    ? finding.body.toLowerCase().includes(expected.bodyIncludes.toLowerCase())
    : true;
  return finding.path === expected.path && finding.line === expected.line && bodyMatches;
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function evaluateReviewModelFixtures(cases: ReviewModelEvalCase[]): ReviewModelEvalReport {
  const results = REVIEW_MODEL_RESEARCH_CANDIDATES.map((model) => {
    let expectedActionableFindings = 0;
    let actionableFindings = 0;
    let missedActionableFindings = 0;
    let falsePositiveFindings = 0;
    let cleanCaseNoiseFindings = 0;
    let severityMismatches = 0;

    for (const evalCase of cases) {
      const expectedFindings = evalCase.expectedFindings;
      const output = evalCase.modelOutputs[model];
      if (!output) {
        missedActionableFindings += expectedFindings.length;
        expectedActionableFindings += expectedFindings.length;
        continue;
      }

      expectedActionableFindings += expectedFindings.length;
      const matchedActualIndexes = new Set<number>();

      for (const expected of expectedFindings) {
        const actualIndex = output.findings.findIndex((finding, index) => {
          return !matchedActualIndexes.has(index) && matchesExpected(finding, expected);
        });

        if (actualIndex === -1) {
          missedActionableFindings++;
          continue;
        }

        matchedActualIndexes.add(actualIndex);
        actionableFindings++;
        if (output.findings[actualIndex]?.severity !== expected.severity) severityMismatches++;
      }

      const falsePositives = output.findings.length - matchedActualIndexes.size;
      falsePositiveFindings += falsePositives;
      if (expectedFindings.length === 0) cleanCaseNoiseFindings += falsePositives;
    }

    const actionableRate =
      expectedActionableFindings === 0 ? 1 : actionableFindings / expectedActionableFindings;

    return {
      model,
      cases: cases.length,
      expectedActionableFindings,
      actionableFindings,
      missedActionableFindings,
      falsePositiveFindings,
      cleanCaseNoiseFindings,
      severityMismatches,
      actionableRate: roundRate(actionableRate),
    };
  });

  const candidateOrder = new Map(
    REVIEW_MODEL_RESEARCH_CANDIDATES.map((model, index) => [model, index]),
  );
  const recommendedFixturePrimary =
    [...results].sort((a, b) => {
      if (b.actionableRate !== a.actionableRate) return b.actionableRate - a.actionableRate;
      if (a.falsePositiveFindings !== b.falsePositiveFindings) {
        return a.falsePositiveFindings - b.falsePositiveFindings;
      }
      if (a.severityMismatches !== b.severityMismatches) {
        return a.severityMismatches - b.severityMismatches;
      }
      return (candidateOrder.get(a.model) ?? 0) - (candidateOrder.get(b.model) ?? 0);
    })[0]?.model ?? null;

  return {
    candidates: [...REVIEW_MODEL_RESEARCH_CANDIDATES],
    recommendedFixturePrimary,
    results,
  };
}

function loadCases(path: string): ReviewModelEvalCase[] {
  return JSON.parse(readFileSync(path, "utf8")) as ReviewModelEvalCase[];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixturePath = process.argv[2] ?? "tests/fixtures/review-model-eval/cases.json";
  const report = evaluateReviewModelFixtures(loadCases(fixturePath));
  console.log(JSON.stringify(report, null, 2));
}
