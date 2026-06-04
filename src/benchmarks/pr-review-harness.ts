import { execFile as execFileCb } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  type ReviewEnvelope,
  type ReviewFinding,
  reviewEnvelope,
  reviewPayload,
} from "@/jobs/review-types";

const execFile = promisify(execFileCb);

const expectedFinding = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  severity: z.enum(["info", "warn", "error"]).optional(),
  bodyIncludes: z.string().optional(),
});

const fixtureFile = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const allowedContext = z.object({
  files: z.array(fixtureFile).default([]),
  docs: z.array(fixtureFile).default([]),
});

const groundTruth = z.object({
  findings: z.array(expectedFinding).default([]),
});

const guardrails = z.object({
  forbiddenPromptSubstrings: z.array(z.string().min(1)).default([]),
});

const benchmarkExpectations = z.object({
  minFindings: z.number().int().nonnegative().default(0),
  maxFindings: z.number().int().nonnegative().optional(),
  requiredFindings: z.array(expectedFinding).default([]),
});

export const prReviewBenchmarkCase = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  payload: reviewPayload,
  diff: z.string().min(1),
  allowedContext: allowedContext.default({ files: [], docs: [] }),
  disallowedSources: z.array(z.string().min(1)).default([]),
  scoringLabels: z.array(z.string().min(1)).default([]),
  groundTruth: groundTruth.default({ findings: [] }),
  guardrails: guardrails.default({ forbiddenPromptSubstrings: [] }),
  modelOutput: reviewEnvelope.optional(),
  expectations: benchmarkExpectations.default({ minFindings: 0, requiredFindings: [] }),
});

export const prReviewBenchmarkManifest = z.object({
  cases: z.array(prReviewBenchmarkCase).min(1),
});

export type PrReviewBenchmarkCase = z.infer<typeof prReviewBenchmarkCase>;

export interface PrReviewBenchmarkOptions {
  command?: string;
  commandArgs?: string[];
  openrouterApiKey?: string;
  reviewModel?: string;
  reviewModelCascade?: string;
  keepRuns?: boolean;
  rootDir?: string;
  timeoutMs?: number;
}

export interface PrReviewBenchmarkCaseResult {
  id: string;
  name: string;
  ok: boolean;
  runDir: string;
  findings: number;
  scoringLabels: string[];
  metrics: PrReviewBenchmarkMetrics;
  failures: string[];
  result?: ReviewEnvelope;
  error?: string;
}

export interface PrReviewBenchmarkMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  severityMatches: number;
  fileLineMatches: number;
  commentUsefulness: number;
}

export interface PrReviewBenchmarkReport {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  metrics: PrReviewBenchmarkMetrics;
  results: PrReviewBenchmarkCaseResult[];
}

export interface PrReviewBenchmarkCommand {
  command: string;
  args: string[];
}

export async function loadPrReviewBenchmarkManifest(path: string) {
  return prReviewBenchmarkManifest.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function runPrReviewBenchmark(
  cases: PrReviewBenchmarkCase[],
  options: PrReviewBenchmarkOptions = {},
): Promise<PrReviewBenchmarkReport> {
  validateUniqueCaseIds(cases);
  const rootDir =
    options.rootDir ?? (await mkdtemp(join(tmpdir(), `postil-pr-benchmark-${randomUUID()}-`)));
  const results: PrReviewBenchmarkCaseResult[] = [];
  let removeRoot = !options.rootDir && !options.keepRuns;

  try {
    for (const [index, benchmarkCase] of cases.entries()) {
      const result = await runPrReviewBenchmarkCase(benchmarkCase, index, rootDir, options);
      results.push(result);
    }
    removeRoot = removeRoot && results.every((result) => result.ok);
  } finally {
    if (removeRoot) {
      await rm(rootDir, { recursive: true, force: true });
    }
  }

  const passed = results.filter((result) => result.ok).length;
  return {
    ok: passed === results.length,
    total: results.length,
    passed,
    failed: results.length - passed,
    metrics: sumMetrics(results.map((result) => result.metrics)),
    results,
  };
}

async function runPrReviewBenchmarkCase(
  benchmarkCase: PrReviewBenchmarkCase,
  index: number,
  rootDir: string,
  options: PrReviewBenchmarkOptions,
): Promise<PrReviewBenchmarkCaseResult> {
  const runDir = join(rootDir, caseRunDirName(index, benchmarkCase.id));
  await rm(runDir, { recursive: true, force: true });
  const homeDir = join(runDir, "home");
  const tmpDir = join(runDir, "tmp");
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });

  const configPath = join(runDir, "config.json");
  const diffPath = join(runDir, "pull.diff");
  const outputPath = join(runDir, "review.json");
  await materializeAllowedContext(benchmarkCase, runDir);
  await writeFile(diffPath, benchmarkCase.diff, { mode: 0o600 });
  const allowedContextFailures = validateAllowedContext(benchmarkCase);
  if (allowedContextFailures.length > 0) {
    return failedCaseResult(benchmarkCase, runDir, allowedContextFailures);
  }

  const github = await startMockGithubServer(benchmarkCase);
  const openrouter = await startMockOpenRouterServer(benchmarkCase, runDir);
  await writeFile(
    configPath,
    JSON.stringify(
      {
        githubApiUrl: github.baseUrl,
        openrouterApiUrl: openrouter.baseUrl,
        repo: benchmarkCase.payload.repoFullName,
        pr: benchmarkCase.payload.pullNumber,
        sha: benchmarkCase.payload.headSha,
        checkRunId: benchmarkCase.payload.checkRunId,
        reviewModel: options.reviewModel ?? process.env.REVIEW_MODEL,
        reviewModelCascade: options.reviewModelCascade ?? process.env.REVIEW_MODEL_CASCADE,
        review: {
          enabled: true,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const guardrailFailures = await findGuardrailFailures(benchmarkCase, [configPath, diffPath]);
  if (guardrailFailures.length > 0) {
    await github.close();
    await openrouter.close();
    return failedCaseResult(benchmarkCase, runDir, guardrailFailures);
  }

  const resolvedCommand = resolvePrReviewBenchmarkCommand(options);
  let commandError: unknown;
  try {
    await execFile(
      resolvedCommand.command,
      [...resolvedCommand.args, "--config", configPath, "--output-json", outputPath],
      {
        cwd: runDir,
        env: isolatedEnv(homeDir, tmpDir, options),
        timeout: options.timeoutMs ?? 10 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (err) {
    commandError = err;
  } finally {
    await github.close();
    await openrouter.close();
  }

  const result = await readReviewOutput(outputPath);
  if (!result) {
    return failedCaseResult(benchmarkCase, runDir, [
      `reviewer did not write a valid result${formatCommandError(commandError)}`,
    ]);
  }

  const promptGuardrailFailures = await findGuardrailFailures(benchmarkCase, [
    openrouter.requestPath,
    outputPath,
  ]);
  if (promptGuardrailFailures.length > 0) {
    return failedCaseResult(benchmarkCase, runDir, promptGuardrailFailures, result);
  }

  const metrics = scoreFindings(benchmarkCase.groundTruth.findings, result.findings);
  if (commandError && !(isExpectedFindingsExit(commandError) && result.findings.length > 0)) {
    return failedCaseResult(
      benchmarkCase,
      runDir,
      [`reviewer exited unexpectedly${formatCommandError(commandError)}`],
      result,
    );
  }

  const failures = evaluateExpectations(benchmarkCase, result, metrics);
  return {
    id: benchmarkCase.id,
    name: benchmarkCase.name,
    ok: failures.length === 0,
    runDir,
    findings: result.findings.length,
    scoringLabels: benchmarkCase.scoringLabels,
    metrics,
    failures,
    result,
  };
}

async function readReviewOutput(outputPath: string): Promise<ReviewEnvelope | undefined> {
  try {
    return reviewEnvelope.parse(JSON.parse(await readFile(outputPath, "utf8")));
  } catch {
    return undefined;
  }
}

function failedCaseResult(
  benchmarkCase: PrReviewBenchmarkCase,
  runDir: string,
  failures: string[],
  result?: ReviewEnvelope,
): PrReviewBenchmarkCaseResult {
  return {
    id: benchmarkCase.id,
    name: benchmarkCase.name,
    ok: false,
    runDir,
    findings: result?.findings.length ?? 0,
    scoringLabels: benchmarkCase.scoringLabels,
    metrics: result
      ? scoreFindings(benchmarkCase.groundTruth.findings, result.findings)
      : emptyMetrics(),
    failures,
    result,
    error: failures.join("; "),
  };
}

function isExpectedFindingsExit(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === 1;
}

function formatCommandError(err: unknown): string {
  if (!(err instanceof Error)) return "";
  const stderr =
    typeof err === "object" && err !== null && "stderr" in err && typeof err.stderr === "string"
      ? err.stderr
      : "";
  const detail = stderr.trim() || err.message;
  const line =
    detail.split("\n").find((item) => item.trim() && !item.trimStart().startsWith("$ ")) ?? detail;
  return `: ${line}`;
}

export function resolvePrReviewBenchmarkCommand(
  options: Pick<PrReviewBenchmarkOptions, "command" | "commandArgs"> = {},
  env: Partial<NodeJS.ProcessEnv> = process.env,
): PrReviewBenchmarkCommand {
  const command = options.command ?? env.POSTIL_BENCHMARK_CLI ?? "bun";
  const args =
    options.commandArgs ??
    (options.command || env.POSTIL_BENCHMARK_CLI
      ? ["review"]
      : ["run", "--cwd", process.cwd(), "postil", "review"]);
  return { command, args };
}

async function startMockGithubServer(benchmarkCase: PrReviewBenchmarkCase) {
  const [owner, repo] = benchmarkCase.payload.repoFullName.split("/");
  const pullPath = `/repos/${owner}/${repo}/pulls/${benchmarkCase.payload.pullNumber}`;
  const allowedContent = allowedContextByPath(benchmarkCase);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === pullPath) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(benchmarkCase.diff);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith(`/repos/${owner}/${repo}/contents/`)) {
      const requestedPath = decodeURIComponent(
        url.pathname.slice(`/repos/${owner}/${repo}/contents/`.length),
      );
      const content = allowedContent.get(requestedPath);
      if (content !== undefined) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(content);
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }

    if (req.method === "POST" || req.method === "PATCH") {
      await readRequestBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  });

  await listen(server);
  return {
    baseUrl: serverBaseUrl(server),
    close: () => closeServer(server),
  };
}

async function startMockOpenRouterServer(benchmarkCase: PrReviewBenchmarkCase, runDir: string) {
  const requestPath = join(runDir, "artifacts", "openrouter-request.json");
  await mkdir(dirname(requestPath), { recursive: true, mode: 0o700 });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/chat/completions") {
      const body = await readRequestBody(req);
      await writeFile(requestPath, body, { mode: 0o600 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(modelResponse(benchmarkCase)) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await listen(server);
  return {
    baseUrl: serverBaseUrl(server),
    requestPath,
    close: () => closeServer(server),
  };
}

function modelResponse(benchmarkCase: PrReviewBenchmarkCase) {
  if (benchmarkCase.modelOutput) {
    return {
      summary: benchmarkCase.modelOutput.summary,
      findings: benchmarkCase.modelOutput.findings,
    };
  }

  return {
    summary:
      benchmarkCase.groundTruth.findings.length > 0
        ? "Synthetic benchmark finding."
        : "Synthetic benchmark clean result.",
    findings: benchmarkCase.groundTruth.findings.map((finding) => ({
      path: finding.path,
      line: finding.line ?? 1,
      severity: finding.severity ?? "warn",
      body: finding.bodyIncludes ?? "Synthetic benchmark finding.",
    })),
  };
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function serverBaseUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isolatedEnv(
  homeDir: string,
  tmpDir: string,
  options: PrReviewBenchmarkOptions,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    CI: "true",
    NODE_ENV: "test",
    NO_COLOR: "1",
    HOME: homeDir,
    TMPDIR: tmpDir,
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GITHUB_TOKEN: "benchmark-github-token",
    OPENROUTER_API_KEY: options.openrouterApiKey ?? "benchmark-openrouter-key",
  };
}

function evaluateExpectations(
  benchmarkCase: PrReviewBenchmarkCase,
  result: ReviewEnvelope,
  metrics: PrReviewBenchmarkMetrics,
): string[] {
  const failures: string[] = [];
  const { expectations } = benchmarkCase;
  if (result.findings.length < expectations.minFindings) {
    failures.push(
      `expected at least ${expectations.minFindings} finding(s), got ${result.findings.length}`,
    );
  }
  if (expectations.maxFindings !== undefined && result.findings.length > expectations.maxFindings) {
    failures.push(
      `expected at most ${expectations.maxFindings} finding(s), got ${result.findings.length}`,
    );
  }

  for (const required of expectations.requiredFindings) {
    const match = result.findings.some((finding) => {
      if (finding.path !== required.path) return false;
      if (required.line !== undefined && finding.line !== required.line) return false;
      if (required.severity !== undefined && finding.severity !== required.severity) return false;
      if (required.bodyIncludes !== undefined && !finding.body.includes(required.bodyIncludes)) {
        return false;
      }
      return true;
    });
    if (!match) {
      failures.push(`missing required finding in ${required.path}`);
    }
  }
  if (metrics.falseNegatives > 0) {
    failures.push(`missed ${metrics.falseNegatives} ground truth finding(s)`);
  }

  return failures;
}

async function materializeAllowedContext(benchmarkCase: PrReviewBenchmarkCase, runDir: string) {
  const repo = join(runDir, "context", "repo");
  const docs = join(runDir, "context", "docs");
  await mkdir(repo, { recursive: true, mode: 0o700 });
  await mkdir(docs, { recursive: true, mode: 0o700 });

  for (const file of benchmarkCase.allowedContext.files) {
    await writeFixtureFile(repo, file);
  }
  for (const doc of benchmarkCase.allowedContext.docs) {
    await writeFixtureFile(docs, doc);
  }

  return { repo, docs };
}

function allowedContextByPath(benchmarkCase: PrReviewBenchmarkCase): Map<string, string> {
  const context = new Map<string, string>();
  for (const file of benchmarkCase.allowedContext.files) {
    context.set(file.path, file.content);
  }
  for (const doc of benchmarkCase.allowedContext.docs) {
    context.set(doc.path, doc.content);
  }
  return context;
}

function validateAllowedContext(benchmarkCase: PrReviewBenchmarkCase): string[] {
  const allowedFiles = new Set(benchmarkCase.allowedContext.files.map((file) => file.path));
  if (allowedFiles.size === 0) return [];

  const diffPaths = new Set<string>();
  for (const line of benchmarkCase.diff.split("\n")) {
    const match = /^(?:diff --git a\/(.+) b\/(.+)|--- a\/(.+)|\+\+\+ b\/(.+))$/.exec(line);
    if (!match) continue;
    for (const path of match.slice(1).filter(Boolean)) {
      if (path !== "/dev/null") diffPaths.add(path);
    }
  }

  return [...diffPaths]
    .filter((path) => !allowedFiles.has(path))
    .map((path) => `diff references ${path}, which is not declared as allowed context`);
}

async function writeFixtureFile(rootDir: string, file: z.infer<typeof fixtureFile>) {
  const safePath = file.path
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  const destination = join(rootDir, safePath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, file.content, { mode: 0o600 });
}

async function findGuardrailFailures(
  benchmarkCase: PrReviewBenchmarkCase,
  paths: string[],
): Promise<string[]> {
  const forbidden = [
    ...benchmarkCase.disallowedSources,
    ...benchmarkCase.guardrails.forbiddenPromptSubstrings,
  ];
  if (forbidden.length === 0) return [];

  const failures: string[] = [];
  for (const path of paths) {
    for (const filePath of await listFiles(path)) {
      const content = await readFile(filePath, "utf8").catch(() => undefined);
      if (content === undefined) continue;
      for (const token of forbidden) {
        if (content.includes(token)) {
          failures.push(
            `guardrail blocked leaked fixture metadata in ${relative(process.cwd(), filePath)}`,
          );
        }
      }
    }
  }
  return [...new Set(failures)];
}

async function listFiles(path: string): Promise<string[]> {
  const stat = await readdir(path, { withFileTypes: true }).catch(async () => undefined);
  if (!stat) return [path];

  const files: string[] = [];
  for (const entry of stat) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

function scoreFindings(
  expected: z.infer<typeof expectedFinding>[],
  actual: ReviewFinding[],
): PrReviewBenchmarkMetrics {
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

function sumMetrics(metrics: PrReviewBenchmarkMetrics[]): PrReviewBenchmarkMetrics {
  return metrics.reduce(
    (sum, item) => ({
      truePositives: sum.truePositives + item.truePositives,
      falsePositives: sum.falsePositives + item.falsePositives,
      falseNegatives: sum.falseNegatives + item.falseNegatives,
      severityMatches: sum.severityMatches + item.severityMatches,
      fileLineMatches: sum.fileLineMatches + item.fileLineMatches,
      commentUsefulness: sum.commentUsefulness + item.commentUsefulness,
    }),
    emptyMetrics(),
  );
}

function emptyMetrics(): PrReviewBenchmarkMetrics {
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    severityMatches: 0,
    fileLineMatches: 0,
    commentUsefulness: 0,
  };
}

function validateUniqueCaseIds(cases: PrReviewBenchmarkCase[]) {
  const ids = new Set<string>();
  for (const benchmarkCase of cases) {
    if (ids.has(benchmarkCase.id)) {
      throw new Error(`duplicate benchmark case id: ${benchmarkCase.id}`);
    }
    ids.add(benchmarkCase.id);
  }
}

export function formatPrReviewBenchmarkReport(report: PrReviewBenchmarkReport): string {
  const lines = [
    `PR review benchmark: ${report.passed}/${report.total} passed`,
    `TP ${report.metrics.truePositives} | FP ${report.metrics.falsePositives} | FN ${report.metrics.falseNegatives}`,
  ];
  for (const result of report.results) {
    const status = result.ok ? "PASS" : "FAIL";
    lines.push(
      `${status} ${result.id}: ${result.findings} finding(s), TP ${result.metrics.truePositives}, FP ${result.metrics.falsePositives}, FN ${result.metrics.falseNegatives}`,
    );
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }
  return lines.join("\n");
}

function caseRunDirName(index: number, id: string): string {
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `case-${index + 1}-${digest}`;
}
