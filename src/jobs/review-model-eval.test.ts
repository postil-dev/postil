import { beforeEach, describe, expect, it, vi } from "vitest";
import fixtureCases from "../../tests/fixtures/review-model-eval/cases.json";
import {
  runReviewModelEvaluation,
  type ReviewModelEvalCase,
} from "./review-model-eval";

const envMock = vi.hoisted(() => ({
  OPENROUTER_API_KEY: "test-openrouter-key",
}));

vi.mock("@/lib/env", () => ({
  env: envMock,
}));

const fetchSpy = vi.spyOn(globalThis, "fetch");

describe("runReviewModelEvaluation", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (!urlStr?.includes("openrouter")) {
        return new Response("not found", { status: 404 });
      }

      const body = init ? JSON.parse(init.body as string) : null;
      const model = String(body?.model ?? "");
      const prompt = String(body?.messages?.find((message: { role?: string }) => message.role === "user")?.content ?? "");
      const evalCase = (fixtureCases as ReviewModelEvalCase[]).find((item) => item.prompt === prompt);
      const output = evalCase?.modelOutputs?.[model];

      if (!output) {
        return new Response("not found", { status: 404 });
      }

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(output) } }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }),
        { status: 200 },
      );
    });
  });

  it("runs the candidate models and preserves prompt and raw output provenance", async () => {
    const report = await runReviewModelEvaluation(fixtureCases as ReviewModelEvalCase[]);

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

    expect(report.caseRuns).toHaveLength(3);
    expect(report.caseRuns[1]).toMatchObject({
      id: "missing-null-guard",
      prompt: (fixtureCases as ReviewModelEvalCase[])[1].prompt,
    });
    expect(report.caseRuns[1].outputs["deepseek/deepseek-v4-flash"]).toMatchObject({
      rawContent: JSON.stringify(
        (fixtureCases as ReviewModelEvalCase[])[1].modelOutputs?.["deepseek/deepseek-v4-flash"],
      ),
      summary: "The diff can throw when the user lookup is absent.",
      findings: [
        {
          path: "src/user.ts",
          line: 42,
          severity: "warn",
          body: "Missing null guard before reading profile.",
        },
      ],
      modelUsed: "deepseek/deepseek-v4-flash",
    });
  });
});
