import { describe, expect, it } from "vitest";
import fixtureSuite from "../../tests/fixtures/review-model-eval/cases.json";
import { evaluateReviewModelFixtures, type ReviewModelEvalSuite } from "./review-model-eval";

describe("evaluateReviewModelFixtures", () => {
  it("reports actionable and noise signals for the default and candidate models", () => {
    const report = evaluateReviewModelFixtures(fixtureSuite as ReviewModelEvalSuite);

    expect(report.configuredDefaultModel).toBe("moonshotai/kimi-k2.6");
    expect(report.recommendedFixturePrimary).toBe("moonshotai/kimi-k2.6");
    expect(report.results).toEqual([
      {
        model: "moonshotai/kimi-k2.6",
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

  it("keeps eval inputs reusable with provenance and diff text", () => {
    const suite = fixtureSuite as ReviewModelEvalSuite;

    expect(suite.cases).toHaveLength(3);
    for (const evalCase of suite.cases) {
      expect(evalCase.provenance.source).toBeTruthy();
      expect(evalCase.provenance.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(evalCase.input.diff).toContain("diff --git");
    }
  });
});
