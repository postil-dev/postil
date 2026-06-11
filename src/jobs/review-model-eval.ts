import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { env } from "@/lib/env";
import type { ReviewFinding } from "./review-types";
import {
  scoreReviewFindings,
  type ReviewFindingExpectation,
} from "@/lib/review-scoring";

type ExpectedFinding = {
  path: string;
  line: number;
  severity: ReviewFinding["severity"];
  bodyIncludes?: string;
};

type ModelOutput = {
  summary: string;
  findings: ReviewFinding[];
  provenance?: EvalProvenance;
};

type EvalInput = {
  title: string;
  diff: string;
};

type EvalProvenance = {
  source: string;
  createdAt: string;
  notes: string;
};

type OutputProvenance = EvalProvenance & {
  caseId: string;
  model: string;
  inputDigest: string;
  outputDigest: string;
};

export type ReviewModelEvalCase = {
  id: string;
  provenance: EvalProvenance;
  input: EvalInput;
  expectedFindings: ExpectedFinding[];
  modelOutputs: Record<string, ModelOutput>;
};

export type ReviewModelEvalSuite = {
  schemaVersion: number;
  models: string[];
  cases: ReviewModelEvalCase[];
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
  fileLineMatches: number;
  commentUsefulness: number;
  actionableRate: number;
  outputProvenances: OutputProvenance[];
};

export type ReviewModelEvalReport = {
  configuredDefaultModel: string;
  candidates: string[];
  recommendedFixturePrimary: string | null;
  results: ReviewModelEvalResult[];
};

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function evalCandidates(suite: ReviewModelEvalSuite, configuredDefaultModel: string): string[] {
  return [configuredDefaultModel, ...suite.models].filter((model, index, models) => {
    return model.trim() !== "" && models.indexOf(model) === index;
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function evaluateReviewModelFixtures(
  suite: ReviewModelEvalSuite,
  configuredDefaultModel = env.REVIEW_MODEL,
): ReviewModelEvalReport {
  const candidates = evalCandidates(suite, configuredDefaultModel);
  const results = candidates.map((model) => {
    let expectedActionableFindings = 0;
    let actionableFindings = 0;
    let missedActionableFindings = 0;
    let falsePositiveFindings = 0;
    let cleanCaseNoiseFindings = 0;
    let severityMismatches = 0;
    let fileLineMatches = 0;
    let commentUsefulness = 0;
    const outputProvenances: OutputProvenance[] = [];

    for (const evalCase of suite.cases) {
      const expectedFindings = evalCase.expectedFindings;
      const output = evalCase.modelOutputs[model];
      if (!output) {
        missedActionableFindings += expectedFindings.length;
        expectedActionableFindings += expectedFindings.length;
        continue;
      }

      expectedActionableFindings += expectedFindings.length;
      const metrics = scoreReviewFindings(
        expectedFindings as ReviewFindingExpectation[],
        output.findings,
      );

      actionableFindings += metrics.truePositives;
      missedActionableFindings += metrics.falseNegatives;
      falsePositiveFindings += metrics.falsePositives;
      fileLineMatches += metrics.fileLineMatches;
      commentUsefulness += metrics.commentUsefulness;
      severityMismatches += metrics.truePositives - metrics.severityMatches;
      if (expectedFindings.length === 0) cleanCaseNoiseFindings += metrics.falsePositives;

      const inputDigest = digest(evalCase.input);
      const outputDigest = digest({
        summary: output.summary,
        findings: output.findings,
      });
      outputProvenances.push({
        ...((output.provenance ?? evalCase.provenance) as EvalProvenance),
        caseId: evalCase.id,
        model,
        inputDigest,
        outputDigest,
      });
    }

    const actionableRate =
      expectedActionableFindings === 0 ? 1 : actionableFindings / expectedActionableFindings;

    return {
      model,
      cases: suite.cases.length,
      expectedActionableFindings,
      actionableFindings,
      missedActionableFindings,
      falsePositiveFindings,
      cleanCaseNoiseFindings,
      severityMismatches,
      fileLineMatches,
      commentUsefulness,
      actionableRate: roundRate(actionableRate),
      outputProvenances,
    };
  });

  const candidateOrder = new Map(candidates.map((model, index) => [model, index]));
  const recommendedFixturePrimary =
    [...results].sort((a, b) => {
      if (b.actionableRate !== a.actionableRate) return b.actionableRate - a.actionableRate;
      if (a.falsePositiveFindings !== b.falsePositiveFindings) {
        return a.falsePositiveFindings - b.falsePositiveFindings;
      }
      if (a.severityMismatches !== b.severityMismatches) {
        return a.severityMismatches - b.severityMismatches;
      }
      if (a.commentUsefulness !== b.commentUsefulness) {
        return b.commentUsefulness - a.commentUsefulness;
      }
      return (candidateOrder.get(a.model) ?? 0) - (candidateOrder.get(b.model) ?? 0);
    })[0]?.model ?? null;

  return {
    configuredDefaultModel,
    candidates,
    recommendedFixturePrimary,
    results,
  };
}

function loadSuite(path: string): ReviewModelEvalSuite {
  return JSON.parse(readFileSync(path, "utf8")) as ReviewModelEvalSuite;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixturePath = process.argv[2] ?? "tests/fixtures/review-model-eval/cases.json";
  const report = evaluateReviewModelFixtures(loadSuite(fixturePath));
  console.log(JSON.stringify(report, null, 2));
}
