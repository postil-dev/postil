import { describe, expect, it } from "vitest";
import fixtureCases from "../../tests/fixtures/review-model-eval/cases.json";
import { evaluateReviewModelFixtures, type ReviewModelEvalCase } from "./review-model-eval";

describe("evaluateReviewModelFixtures", () => {
  it("reports actionable and noise signals for the research candidates", () => {
    const report = evaluateReviewModelFixtures(fixtureCases as ReviewModelEvalCase[]);

    expect(report.recommendedFixturePrimary).toBe("deepseek/deepseek-v4-flash");
    expect(report.results).toEqual([
      {
        model: "deepseek/deepseek-v4-flash",
        cases: 3,
        expectedActionableFindings: 2,
        actionableFindings: 2,
        missedActionableFindings: 0,
        falsePositiveFindings: 0,
        cleanCaseNoiseFindings: 0,
        severityMismatches: 0,
        actionableRate: 1,
      },
      {
        model: "qwen/qwen3-coder-30b-a3b-instruct",
        cases: 3,
        expectedActionableFindings: 2,
        actionableFindings: 2,
        missedActionableFindings: 0,
        falsePositiveFindings: 3,
        cleanCaseNoiseFindings: 1,
        severityMismatches: 0,
        actionableRate: 1,
      },
      {
        model: "google/gemini-2.5-flash-lite",
        cases: 3,
        expectedActionableFindings: 2,
        actionableFindings: 0,
        missedActionableFindings: 2,
        falsePositiveFindings: 1,
        cleanCaseNoiseFindings: 0,
        severityMismatches: 0,
        actionableRate: 0,
      },
      {
        model: "anthropic/claude-sonnet-4.5",
        cases: 3,
        expectedActionableFindings: 2,
        actionableFindings: 2,
        missedActionableFindings: 0,
        falsePositiveFindings: 0,
        cleanCaseNoiseFindings: 0,
        severityMismatches: 0,
        actionableRate: 1,
      },
    ]);
  });
});
