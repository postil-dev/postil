import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type PublicationCliExecutor,
  runGitHubPublicationCliPlanning,
} from "@/lib/github-publication-cli-planner";
import type {
  AcceptedGitHubPublicationPlan,
  ExpectedGitHubPublicationPlan,
} from "@/lib/github-publication-plan";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TARGET = "c".repeat(40);
const INPUT_IDENTITY = digest("input");
const REVIEW_OUTPUT_DIGEST = digest("output");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true })
  ));
});

describe("GitHub publication CLI planner", () => {
  test("runs a bounded pure planner and retains exact plan and envelope bytes", async () => {
    const workingDirectory = await temporaryDirectory();
    let observedArguments: string[] = [];
    let observedBounds: { stdout?: number; stderr?: number } = {};
    const execute: PublicationCliExecutor = async (args, _environment, cwd, observers) => {
      observedArguments = args;
      observedBounds = {
        stdout: observers.maxStdoutBytes,
        stderr: observers.maxStderrBytes,
      };
      expect(cwd).toBe(workingDirectory);
      await writeEnvelope(args, envelope());
      return executionResult(0);
    };

    const result = await runGitHubPublicationCliPlanning({
      execute,
      environment: { TEST_MODE: "1" },
      workingDirectory,
      expected,
      bounded: true,
      sinceSha: "d".repeat(40),
      baselinePath: join(workingDirectory, "baseline.json"),
    }, { parsePlanBytes: acceptedPlanParser() });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.acceptedPlan.bytes)).toBe("plan\n");
    expect(new TextDecoder().decode(result.envelopeArtifact.bytes)).toContain('"version":1');
    expect(observedBounds).toEqual({
      stdout: 8 * 1024 * 1024,
      stderr: 1024 * 1024,
    });
    expect(observedArguments).toContain("--publication-plan-output");
    expect(observedArguments).toContain("--publication-input-identity");
    expect(observedArguments).toContain("--bounded");
    expect(observedArguments).not.toContain("--publish");
    expect(observedArguments).not.toContain("--check-run-id");
    expect(observedArguments).not.toContain("--gate-check-run-id");
  });

  test("rejects replacement of the private envelope inode", async () => {
    const workingDirectory = await temporaryDirectory();
    const execute: PublicationCliExecutor = async (args) => {
      const envelopePath = outputFileArgument(args);
      const replacement = join(workingDirectory, "replacement.json");
      await writeFile(replacement, JSON.stringify(envelope()), { mode: 0o600 });
      await rename(replacement, envelopePath);
      return executionResult(0);
    };

    await expect(runGitHubPublicationCliPlanning({
      execute,
      environment: {},
      workingDirectory,
      expected,
    }, { parsePlanBytes: acceptedPlanParser() })).rejects.toThrow(
      "private JSON artifact is invalid",
    );
  });

  test("rejects exit, envelope, and advisory contradictions", async () => {
    const mismatchDirectory = await temporaryDirectory();
    const blocking = envelope({
      gateFailing: true,
      findings: [{
        id: "blocking-1",
        path: "src/controller.ts",
        line: 1,
        severity: "error",
        kind: "risk",
        confidence: 1,
        title: "Blocking finding",
        body: "The mutation is unsafe.",
      }],
    });
    await expect(runGitHubPublicationCliPlanning({
      execute: executorForEnvelope(blocking, 0),
      environment: {},
      workingDirectory: mismatchDirectory,
      expected,
    }, { parsePlanBytes: acceptedPlanParser() })).rejects.toThrow(
      "exit status disagrees",
    );

    const headDirectory = await temporaryDirectory();
    await expect(runGitHubPublicationCliPlanning({
      execute: executorForEnvelope(envelope({ headSha: "d".repeat(40) }), 0),
      environment: {},
      workingDirectory: headDirectory,
      expected,
    }, { parsePlanBytes: acceptedPlanParser() })).rejects.toThrow(
      "different head SHA",
    );

    const advisoryDirectory = await temporaryDirectory();
    const operational = envelope({
      findings: [{
        id: "operational-1",
        path: ".postil/provider",
        line: 1,
        severity: "error",
        kind: "risk",
        confidence: 1,
        title: "Provider unavailable",
        body: "No reviewer verdict exists.",
      }],
    });
    await expect(runGitHubPublicationCliPlanning({
      execute: executorForEnvelope(operational, 0),
      environment: {},
      workingDirectory: advisoryDirectory,
      expected,
    }, { parsePlanBytes: acceptedPlanParser() })).rejects.toThrow(
      "advisory completion disagrees",
    );
  });

  test("rejects interrupted, timed-out, and failed planner processes", async () => {
    for (const [result, message] of [
      [{ ...executionResult(null), interrupted: true }, "was interrupted"],
      [{ ...executionResult(null), timedOut: true }, "timed out"],
      [executionResult(2), "exited with code 2"],
    ] as const) {
      const workingDirectory = await temporaryDirectory();
      await expect(runGitHubPublicationCliPlanning({
        execute: async () => result,
        environment: {},
        workingDirectory,
        expected,
      }, { parsePlanBytes: acceptedPlanParser() })).rejects.toThrow(message);
    }
  });
});

const expected: ExpectedGitHubPublicationPlan = {
  controllerGeneration: 17n,
  inputIdentity: INPUT_IDENTITY,
  reviewOutputDigest: REVIEW_OUTPUT_DIGEST,
  repositoryId: 42n,
  repositoryFullName: "acme/api",
  pullRequestNumber: 7n,
  headSha: HEAD,
  mergeBaseSha: BASE,
  targetSha: TARGET,
  pullRequestTitle: "Title",
  pullRequestBody: "Body",
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "postil-cli-planner-"));
  directories.push(directory);
  return directory;
}

function envelope(overrides: {
  gateFailing?: boolean;
  headSha?: string;
  findings?: Array<Record<string, unknown>>;
} = {}) {
  const findings = overrides.findings ?? [];
  return {
    version: 1,
    summary: "",
    silent: true,
    findings,
    resolved: [],
    counts: {
      info: 0,
      warn: 0,
      error: findings.length,
      suppressed: 0,
      ungrounded: 0,
    },
    confidenceBuckets: [0, 0, 0, 0, findings.length],
    gate: { failOn: "error", failing: overrides.gateFailing ?? false },
    modelUsed: "test/model",
    usage: { promptTokens: 1, completionTokens: 1 },
    durationMs: 1,
    baseSha: BASE,
    headSha: overrides.headSha ?? HEAD,
    sinceSha: null,
  };
}

function executorForEnvelope(
  value: ReturnType<typeof envelope>,
  exitCode: number,
): PublicationCliExecutor {
  return async (args) => {
    await writeEnvelope(args, value);
    return executionResult(exitCode);
  };
}

async function writeEnvelope(args: string[], value: unknown): Promise<void> {
  await writeFile(outputFileArgument(args), JSON.stringify(value));
}

function outputFileArgument(args: string[]): string {
  const index = args.indexOf("--output-file");
  if (index < 0 || args[index + 1] === undefined) throw new Error("missing output file");
  return args[index + 1]!;
}

function executionResult(exitCode: number | null) {
  return {
    exitCode,
    stdout: "plan\n",
    stdoutBytes: Buffer.from("plan\n"),
    stderr: "",
    timedOut: false,
    interrupted: false,
  };
}

function acceptedPlanParser() {
  return (
    source: Uint8Array,
    actualExpected: ExpectedGitHubPublicationPlan,
  ): AcceptedGitHubPublicationPlan => {
    expect(Buffer.from(source)).toEqual(Buffer.from("plan\n"));
    expect(actualExpected).toEqual(expected);
    return {
      bytes: Uint8Array.from(source),
      digest: createHash("sha256").update(source).digest("hex"),
      value: {
        gateAnalysis: { analyzedConclusion: "success" },
        operations: [{ kind: "advisoryCheckComplete", conclusion: "success" }],
        lifecycleReceipt: { findings: [] },
      } as unknown as AcceptedGitHubPublicationPlan["value"],
    };
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
