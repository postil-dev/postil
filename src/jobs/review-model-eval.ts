import { readFileSync } from "node:fs";
import { env } from "@/lib/env";
import {
  parseEnvelope,
  SYSTEM_PROMPT,
  type Finding,
  type TokenUsage,
} from "./run-review";
import { REVIEW_MODEL_RESEARCH_CANDIDATES } from "./review-models";

type ExpectedFinding = {
  path: string;
  line: number;
  severity: Finding["severity"];
  bodyIncludes?: string;
};

type CaseModelOutput = {
  summary: string;
  findings: Finding[];
};

type CaseRunOutput = CaseModelOutput & {
  rawContent: string;
  modelUsed: string;
  usage: TokenUsage;
};

export type ReviewModelEvalCase = {
  id: string;
  prompt: string;
  expectedFindings: ExpectedFinding[];
  modelOutputs?: Record<string, CaseModelOutput>;
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

export type ReviewModelEvalCaseRun = {
  id: string;
  prompt: string;
  expectedFindings: ExpectedFinding[];
  outputs: Record<string, CaseRunOutput>;
};

export type ReviewModelEvalReport = {
  candidates: string[];
  recommendedFixturePrimary: string | null;
  results: ReviewModelEvalResult[];
  caseRuns: ReviewModelEvalCaseRun[];
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

function scoreCaseRuns(caseRuns: ReviewModelEvalCaseRun[]): ReviewModelEvalReport {
  const candidateOrder = new Map(
    REVIEW_MODEL_RESEARCH_CANDIDATES.map((model, index) => [model, index]),
  );
  const results = REVIEW_MODEL_RESEARCH_CANDIDATES.map((model) => {
    let expectedActionableFindings = 0;
    let actionableFindings = 0;
    let missedActionableFindings = 0;
    let falsePositiveFindings = 0;
    let cleanCaseNoiseFindings = 0;
    let severityMismatches = 0;

    for (const evalCase of caseRuns) {
      const expectedFindings = evalCase.expectedFindings;
      const output = evalCase.outputs[model];
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
      cases: caseRuns.length,
      expectedActionableFindings,
      actionableFindings,
      missedActionableFindings,
      falsePositiveFindings,
      cleanCaseNoiseFindings,
      severityMismatches,
      actionableRate: roundRate(actionableRate),
    };
  });

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
    caseRuns,
  };
}

function loadCases(path: string): ReviewModelEvalCase[] {
  return JSON.parse(readFileSync(path, "utf8")) as ReviewModelEvalCase[];
}

async function callOpenRouter(model: string, userContent: string): Promise<CaseRunOutput> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      signal: controller.signal,
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "http-referer": "https://postil.dev",
        "x-title": "Postil",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 2500,
        response_format: { type: "json_object" },
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const rawContent = data.choices?.[0]?.message?.content ?? "";
    const orUsage = data.usage;
    const usage: TokenUsage = {
      promptTokens: orUsage?.prompt_tokens ?? 0,
      completionTokens: orUsage?.completion_tokens ?? 0,
      totalTokens: orUsage?.total_tokens ?? 0,
    };
    const parsed = parseEnvelope(rawContent, usage, model);

    return {
      rawContent,
      summary: parsed.summary,
      findings: parsed.findings,
      modelUsed: parsed.modelUsed ?? model,
      usage,
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

export async function runReviewModelEvaluation(
  cases: ReviewModelEvalCase[],
): Promise<ReviewModelEvalReport> {
  const caseRuns: ReviewModelEvalCaseRun[] = [];

  for (const evalCase of cases) {
    const outputs: Record<string, CaseRunOutput> = {};
    for (const model of REVIEW_MODEL_RESEARCH_CANDIDATES) {
      outputs[model] = await callOpenRouter(model, evalCase.prompt);
    }

    caseRuns.push({
      id: evalCase.id,
      prompt: evalCase.prompt,
      expectedFindings: evalCase.expectedFindings,
      outputs,
    });
  }

  return scoreCaseRuns(caseRuns);
}

async function main(): Promise<void> {
  const fixturePath = process.argv[2] ?? "tests/fixtures/review-model-eval/cases.json";
  const report = await runReviewModelEvaluation(loadCases(fixturePath));
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
