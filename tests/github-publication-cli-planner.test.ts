import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  githubPublicationInputIdentity,
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
const REVIEW_OUTPUT_DIGEST = digest(JSON.stringify({
  controllerGeneration: "17",
  inputIdentity: INPUT_IDENTITY,
  repositoryId: "42",
  pullRequestNumber: "7",
  headSha: HEAD,
  mergeBaseSha: BASE,
  targetSha: TARGET,
  pullRequestTitleSha256: digest("Title"),
  pullRequestBodySha256: digest("Body"),
  shouldComment: false,
  duplicateOfBaseline: false,
  annotateFindings: false,
  advisory: "success",
  gate: "success",
  detailsUrl: null,
  findings: [],
}));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true })
  ));
});

describe("GitHub publication CLI planner", () => {
  test("binds every service-owned publication input into one stable identity", () => {
    const input = {
      databaseRepositoryId: "12",
      githubRepositoryId: "420042",
      repositoryFullName: "acme/api",
      pullRequestNumber: "7",
      controllerGeneration: "17",
      reviewId: "99",
      headSha: HEAD,
      mergeBaseSha: BASE,
      targetSha: TARGET,
      pullRequestTitle: "Title",
      pullRequestBody: "Body",
      expectedPullRequestUpdatedAt: "2026-08-14T00:00:00.000Z",
      cliVersion: "0.8.16",
      configurationSha256: digest("configuration"),
      providerIdentity: "provider-v1",
      retryLineage: "review:99:attempt:1",
      baselineReviewId: "98",
      baselineHeadSha: "d".repeat(40),
      baselineEnvelopeSha256: digest("baseline"),
      bounded: true,
      forceFullReview: false,
      detailsUrl: "https://postil.dev/orgs/acme/runs/run-17",
    };
    const identity = githubPublicationInputIdentity(input);
    expect(identity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(githubPublicationInputIdentity(structuredClone(input))).toBe(identity);
    for (const changed of [
      { ...input, githubRepositoryId: "420043" },
      { ...input, targetSha: "e".repeat(40) },
      { ...input, pullRequestBody: "Changed body" },
      { ...input, configurationSha256: digest("changed configuration") },
      { ...input, providerIdentity: "provider-v2" },
      { ...input, baselineEnvelopeSha256: digest("changed baseline") },
      { ...input, bounded: false },
      { ...input, detailsUrl: "https://postil.dev/orgs/acme/runs/run-18" },
    ]) expect(githubPublicationInputIdentity(changed)).not.toBe(identity);

    expect(() => githubPublicationInputIdentity({
      ...input,
      baselineEnvelopeSha256: undefined,
    })).toThrow("baseline envelope identity is incomplete");
    expect(() => githubPublicationInputIdentity({
      ...input,
      expectedPullRequestUpdatedAt: "2026-08-14T00:00:00.000999Z",
    })).toThrow("update timestamp is invalid");
    expect(() => githubPublicationInputIdentity({
      ...input,
      expectedPullRequestUpdatedAt: "2026-99-14T00:00:00.000Z",
    })).toThrow("update timestamp is invalid");
    expect(() => githubPublicationInputIdentity({
      ...input,
      detailsUrl: "not a URL",
    })).toThrow("details URL is invalid");
    expect(() => githubPublicationInputIdentity({
      ...input,
      detailsUrl: "https://user:password@example.test/review",
    })).toThrow("details URL is invalid");
  });

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
    expect(observedArguments[observedArguments.indexOf("--base-sha") + 1]).toBe(TARGET);
    expect(observedArguments).not.toContain("--publish");
    expect(observedArguments).not.toContain("--check-run-id");
    expect(observedArguments).not.toContain("--gate-check-run-id");

    await expect(lstat(join(workingDirectory, ".postil-controller-envelope.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(runGitHubPublicationCliPlanning({
      execute,
      environment: { TEST_MODE: "1" },
      workingDirectory,
      expected,
    }, { parsePlanBytes: acceptedPlanParser() })).resolves.toMatchObject({ exitCode: 0 });
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
      "private envelope artifact identity changed before cleanup",
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
      await expect(lstat(join(workingDirectory, ".postil-controller-envelope.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
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
        controllerGeneration: String(expected.controllerGeneration),
        inputIdentity: expected.inputIdentity,
        reviewOutputDigest: expected.reviewOutputDigest,
        repository: {
          id: String(expected.repositoryId),
          fullName: expected.repositoryFullName,
        },
        pullRequestNumber: String(expected.pullRequestNumber),
        reviewedSnapshot: {
          headSha: expected.headSha,
          mergeBaseSha: expected.mergeBaseSha,
          targetSha: expected.targetSha,
          pullRequestTitleSha256: digest(expected.pullRequestTitle),
          pullRequestBodySha256: digest(expected.pullRequestBody),
        },
        gateAnalysis: { analyzedConclusion: "success" },
        operations: [
          { kind: "advisoryCheckCreate" },
          { kind: "advisoryCheckComplete", conclusion: "success" },
        ],
        lifecycleReceipt: {
          channel: "reviewComments",
          duplicateOfBaseline: false,
          findings: [],
        },
      } as unknown as AcceptedGitHubPublicationPlan["value"],
    };
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
