import { execFile as execFileCb } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type PrReviewBenchmarkCase,
  resolvePrReviewBenchmarkCommand,
  runPrReviewBenchmark,
} from "./pr-review-harness";

const execFile = promisify(execFileCb);

const PAYLOAD = {
  installationId: 1,
  repoFullName: "owner/repo",
  pullNumber: 12,
  headSha: "abc123def456",
  checkRunId: 99,
};

describe("PR review benchmark harness", () => {
  let rootDir: string;
  let fakeCliPath: string;
  let capturePath: string;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `postil-pr-benchmark-test-${crypto.randomUUID()}`);
    await mkdir(rootDir, { recursive: true });
    fakeCliPath = join(rootDir, "fake-reviewer.mjs");
    capturePath = join(rootDir, "capture.json");
    await writeFile(
      fakeCliPath,
      `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const configPath = process.argv[process.argv.indexOf("--config") + 1];
const outputPath = process.argv[process.argv.indexOf("--output-json") + 1];
const config = JSON.parse(await readFile(configPath, "utf8"));
await writeFile("${capturePath}", JSON.stringify({
  cwd: process.cwd(),
  home: process.env.HOME,
  tmpdir: process.env.TMPDIR,
  hasGithubToken: Object.hasOwn(config, "githubToken"),
  hasOpenrouterApiKey: Object.hasOwn(config, "openrouterApiKey"),
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  githubApiUrl: config.githubApiUrl,
  openrouterApiUrl: config.openrouterApiUrl,
  repo: config.repo,
  pr: config.pr,
  sha: config.sha,
  outputDir: dirname(outputPath)
}));
await writeFile(outputPath, JSON.stringify({
  summary: "found a blocking issue",
  findings: [{ path: "src/payments.ts", line: 42, severity: "error", body: "Charge is applied twice." }],
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  modelUsed: "benchmark/test"
}));
`,
      { mode: 0o700 },
    );
  });

  it("runs a case in an isolated directory with private runtime paths", async () => {
    const report = await runPrReviewBenchmark([caseWithFinding()], {
      command: process.execPath,
      commandArgs: [fakeCliPath],
      openrouterApiKey: "test-openrouter-key",
      rootDir,
      keepRuns: true,
    });

    expect(report.ok).toBe(true);
    expect(report.passed).toBe(1);
    expect(report.metrics).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      severityMatches: 1,
      fileLineMatches: 1,
      commentUsefulness: 1,
    });
    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    expect(capture.cwd.startsWith(rootDir)).toBe(true);
    expect(capture.home.startsWith(capture.cwd)).toBe(true);
    expect(capture.tmpdir.startsWith(capture.cwd)).toBe(true);
    expect(capture.outputDir).toBe(capture.cwd);
    expect(capture.hasGithubToken).toBe(false);
    expect(capture.hasOpenrouterApiKey).toBe(false);
    expect(capture.openrouterApiKey).toBe("test-openrouter-key");
    expect(capture.githubApiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(capture.openrouterApiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(capture.repo).toBe("owner/repo");
    expect(capture.pr).toBe(12);
    expect(capture.sha).toBe("abc123def456");
  });

  it("resolves the default command to the pinned package wrapper", () => {
    expect(resolvePrReviewBenchmarkCommand({}, {})).toEqual({
      command: "bun",
      args: ["run", "--cwd", process.cwd(), "postil", "review"],
    });
  });

  it("serves mock GitHub contents and captures mock model requests", async () => {
    await writeFile(
      fakeCliPath,
      `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const configPath = process.argv[process.argv.indexOf("--config") + 1];
const outputPath = process.argv[process.argv.indexOf("--output-json") + 1];
const config = JSON.parse(await readFile(configPath, "utf8"));
const diff = await fetch(
  config.githubApiUrl + "/repos/" + config.repo + "/pulls/" + config.pr,
  { headers: { accept: "application/vnd.github.v3.diff" } }
).then((response) => response.text());
const allowedFile = await fetch(
  config.githubApiUrl + "/repos/" + config.repo + "/contents/src/payments.ts?ref=" + config.sha,
  { headers: { accept: "application/vnd.github.v3.raw" } }
).then((response) => response.text());
const completion = await fetch(config.openrouterApiUrl + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "benchmark/test",
    messages: [{ role: "user", content: diff + "\\n\\nAllowed file:\\n" + allowedFile }]
  })
}).then((response) => response.json());
const modelContent = JSON.parse(completion.choices[0].message.content);
await writeFile(outputPath, JSON.stringify({
  summary: modelContent.summary,
  findings: modelContent.findings,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  modelUsed: "benchmark/test"
}));
`,
      { mode: 0o700 },
    );

    const report = await runPrReviewBenchmark([caseWithFinding()], {
      command: process.execPath,
      commandArgs: [fakeCliPath],
      rootDir,
      keepRuns: true,
    });

    expect(report.ok).toBe(true);
    const request = JSON.parse(
      await readFile(
        join(report.results[0].runDir, "artifacts", "openrouter-request.json"),
        "utf8",
      ),
    );
    const requestText = JSON.stringify(request);
    expect(requestText).toContain("amount + amount");
    expect(requestText).toContain("export function charge()");
  });

  it("uses recorded model output instead of deriving it from ground truth", async () => {
    await writeFile(
      fakeCliPath,
      `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const configPath = process.argv[process.argv.indexOf("--config") + 1];
const outputPath = process.argv[process.argv.indexOf("--output-json") + 1];
const config = JSON.parse(await readFile(configPath, "utf8"));
const diff = await fetch(
  config.githubApiUrl + "/repos/" + config.repo + "/pulls/" + config.pr,
  { headers: { accept: "application/vnd.github.v3.diff" } }
).then((response) => response.text());
const allowedFile = await fetch(
  config.githubApiUrl + "/repos/" + config.repo + "/contents/src/payments.ts?ref=" + config.sha,
  { headers: { accept: "application/vnd.github.v3.raw" } }
).then((response) => response.text());
const completion = await fetch(config.openrouterApiUrl + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "benchmark/test",
    messages: [{ role: "user", content: diff + "\\n\\nAllowed file:\\n" + allowedFile }]
  })
}).then((response) => response.json());
const modelContent = JSON.parse(completion.choices[0].message.content);
await writeFile(outputPath, JSON.stringify({
  summary: modelContent.summary,
  findings: modelContent.findings,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  modelUsed: "benchmark/test"
}));
`,
      { mode: 0o700 },
    );

    const report = await runPrReviewBenchmark(
      [
        {
          ...caseWithFinding(),
          modelOutput: {
            summary: "Recorded model response.",
            findings: [
              {
                path: "src/payments.ts",
                line: 42,
                severity: "error",
                body: "Recorded model response.",
              },
            ],
          },
          expectations: {
            minFindings: 1,
            maxFindings: 1,
            requiredFindings: [{ path: "src/payments.ts", line: 42, severity: "error" }],
          },
        },
      ],
      {
        command: process.execPath,
        commandArgs: [fakeCliPath],
        rootDir,
        keepRuns: true,
      },
    );

    expect(report.ok).toBe(true);
    expect(report.results[0].result?.findings[0].body).toBe("Recorded model response.");
    expect(report.results[0].metrics.commentUsefulness).toBe(0);
  });

  it("fails the report when expected findings are missing", async () => {
    const report = await runPrReviewBenchmark(
      [
        {
          ...caseWithFinding(),
          expectations: {
            minFindings: 1,
            requiredFindings: [{ path: "src/other.ts", severity: "error" }],
          },
        },
      ],
      {
        command: process.execPath,
        commandArgs: [fakeCliPath],
        rootDir,
        keepRuns: true,
      },
    );

    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.results[0].failures).toEqual(["missing required finding in src/other.ts"]);
  });

  it("fails before execution when consumed diff leaks forbidden fixture metadata", async () => {
    const report = await runPrReviewBenchmark(
      [
        {
          ...caseWithFinding(),
          diff: `${caseWithFinding().diff}+SECRET_RESOLUTION_DO_NOT_SHOW\n`,
          disallowedSources: ["SECRET_RESOLUTION_DO_NOT_SHOW"],
        },
      ],
      {
        command: process.execPath,
        commandArgs: [fakeCliPath],
        rootDir,
        keepRuns: true,
      },
    );

    expect(report.ok).toBe(false);
    expect(report.results[0].failures).toEqual([
      expect.stringContaining("guardrail blocked leaked fixture metadata"),
    ]);
    const config = await readFile(join(report.results[0].runDir, "config.json"), "utf8");
    expect(config).not.toContain("test-openrouter-key");
  });

  it("does not fail just because unused fixture metadata contains forbidden context", async () => {
    const report = await runPrReviewBenchmark(
      [
        {
          ...caseWithFinding(),
          allowedContext: {
            files: [{ path: "src/payments.ts", content: "SECRET_RESOLUTION_DO_NOT_SHOW" }],
            docs: [],
          },
          disallowedSources: ["SECRET_RESOLUTION_DO_NOT_SHOW"],
        },
      ],
      {
        command: process.execPath,
        commandArgs: [fakeCliPath],
        rootDir,
        keepRuns: true,
      },
    );

    expect(report.ok).toBe(true);
  });

  it("fails when reviewer output leaks forbidden fixture metadata", async () => {
    await writeFile(
      fakeCliPath,
      `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const outputPath = process.argv[process.argv.indexOf("--output-json") + 1];
await writeFile(outputPath, JSON.stringify({
  summary: "SECRET_RESOLUTION_DO_NOT_SHOW",
  findings: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  modelUsed: "benchmark/test"
}));
`,
      { mode: 0o700 },
    );

    const report = await runPrReviewBenchmark(
      [
        {
          ...caseWithFinding(),
          disallowedSources: ["SECRET_RESOLUTION_DO_NOT_SHOW"],
        },
      ],
      {
        command: process.execPath,
        commandArgs: [fakeCliPath],
        rootDir,
        keepRuns: true,
      },
    );

    expect(report.ok).toBe(false);
    expect(report.results[0].failures).toEqual([
      expect.stringContaining("guardrail blocked leaked fixture metadata"),
    ]);
  });

  it("keeps colliding sanitized ids isolated and rejects duplicate ids", async () => {
    const caseA = { ...caseWithFinding(), id: "a/b" };
    const caseB = { ...caseWithFinding(), id: "a-b" };

    const report = await runPrReviewBenchmark([caseA, caseB], {
      command: process.execPath,
      commandArgs: [fakeCliPath],
      rootDir,
      keepRuns: true,
    });

    expect(report.ok).toBe(true);
    expect(report.results[0].runDir).not.toBe(report.results[1].runDir);
    expect(report.results[0].runDir.startsWith(rootDir)).toBe(true);
    expect(report.results[1].runDir.startsWith(rootDir)).toBe(true);

    await expect(
      runPrReviewBenchmark([caseA, caseA], {
        command: process.execPath,
        commandArgs: [fakeCliPath],
        rootDir,
        keepRuns: true,
      }),
    ).rejects.toThrow("duplicate benchmark case id");
  });

  it("runs through the published package script path", async () => {
    const manifestPath = join(rootDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ cases: [caseWithFinding()] }));

    const { stdout } = await execFile(
      "bun",
      ["run", "benchmark:pr-review", manifestPath, "--json"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          POSTIL_BENCHMARK_CLI: fakeCliPath,
          OPENROUTER_API_KEY: "script-smoke-key",
        },
        maxBuffer: 1024 * 1024,
      },
    );

    const report = JSON.parse(stdout);
    expect(report.ok).toBe(true);
    expect(report.metrics.truePositives).toBe(1);
    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    expect(capture.openrouterApiKey).toBe("benchmark-openrouter-key");
  });
});

function caseWithFinding(): PrReviewBenchmarkCase {
  return {
    id: "double-charge",
    name: "Double charge",
    payload: PAYLOAD,
    diff: [
      "diff --git a/src/payments.ts b/src/payments.ts",
      "index 1111111..2222222 100644",
      "--- a/src/payments.ts",
      "+++ b/src/payments.ts",
      "@@ -39,7 +39,7 @@ export function charge(amount: number) {",
      "-  return amount;",
      "+  return amount + amount;",
      " }",
      "",
    ].join("\n"),
    allowedContext: {
      files: [
        {
          path: "src/payments.ts",
          content: "export function charge() { return amount + amount; }",
        },
      ],
      docs: [{ path: "review-policy.md", content: "Flag duplicated charges as blocking." }],
    },
    disallowedSources: ["fixed by changing charge() to return amount"],
    scoringLabels: ["billing", "blocker", "duplicate-side-effect"],
    guardrails: {
      forbiddenPromptSubstrings: [],
    },
    modelOutput: {
      summary: "Recorded model response.",
      findings: [
        {
          path: "src/payments.ts",
          line: 42,
          severity: "error",
          body: "Recorded review: the charge is applied twice.",
        },
      ],
    },
    groundTruth: {
      findings: [
        {
          path: "src/payments.ts",
          line: 42,
          severity: "error",
          bodyIncludes: "applied twice",
        },
      ],
    },
    expectations: {
      minFindings: 1,
      maxFindings: 1,
      requiredFindings: [
        {
          path: "src/payments.ts",
          line: 42,
          severity: "error",
          bodyIncludes: "applied twice",
        },
      ],
    },
  };
}
