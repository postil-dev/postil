import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildGitHubPublicationInputIdentity,
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
const inputIdentity = {
  databaseRepositoryId: "12",
  githubRepositoryId: "42",
  repositoryFullName: "acme/api",
  pullRequestNumber: "7",
  controllerGeneration: "17",
  reviewId: "99",
  headSha: HEAD,
  mergeBaseSha: BASE,
  targetSha: TARGET,
  targetBranch: "main",
  pullRequestTitle: "Title",
  pullRequestBody: "Body",
  expectedPullRequestUpdatedAt: "2026-08-14T00:00:00.000Z",
  cliVersion: "0.9.0",
  cliCommitSha: "f".repeat(40),
  cliArtifactSha256: digest("CLI artifact"),
  configurationSha256: digest("configuration"),
  providerIdentity: "provider-v1",
  retryLineage: "review:99:attempt:1",
  baselineReviewId: "98",
  baselineHeadSha: "d".repeat(40),
  baselineEnvelopeSha256: digest("baseline"),
  sinceSha: "d".repeat(40),
  bounded: true,
  forceFullReview: false,
  detailsUrl: "https://postil.dev/orgs/acme/runs/run-17",
} as const;
const INPUT_IDENTITY = githubPublicationInputIdentity(inputIdentity);
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
      targetBranch: "main",
      pullRequestTitle: "Title",
      pullRequestBody: "Body",
      expectedPullRequestUpdatedAt: "2026-08-14T00:00:00.000Z",
      cliVersion: "0.8.16",
      cliCommitSha: "f".repeat(40),
      cliArtifactSha256: digest("CLI artifact"),
      configurationSha256: digest("configuration"),
      providerIdentity: "provider-v1",
      retryLineage: "review:99:attempt:1",
      baselineReviewId: "98",
      baselineHeadSha: "d".repeat(40),
      baselineEnvelopeSha256: digest("baseline"),
      sinceSha: "4".repeat(40),
      bounded: true,
      forceFullReview: false,
      detailsUrl: "https://postil.dev/orgs/acme/runs/run-17",
    };
    const built = buildGitHubPublicationInputIdentity(input);
    const identity = built.digest;
    expect(identity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.parse(Buffer.from(built.bytes).toString("utf8"))).toEqual(built.value);
    expect(Buffer.from(built.bytes).toString("utf8").startsWith('{"baseline":')).toBe(true);
    expect(buildGitHubPublicationInputIdentity(structuredClone(input))).toEqual(built);
    expect(githubPublicationInputIdentity(structuredClone(input))).toBe(identity);
    for (const changed of [
      { ...input, databaseRepositoryId: "13" },
      { ...input, githubRepositoryId: "420043" },
      { ...input, repositoryFullName: "acme/worker" },
      { ...input, pullRequestNumber: "8" },
      { ...input, controllerGeneration: "18" },
      { ...input, reviewId: "100" },
      { ...input, headSha: "1".repeat(40) },
      { ...input, mergeBaseSha: "2".repeat(40) },
      { ...input, targetSha: "e".repeat(40) },
      { ...input, targetBranch: "release" },
      { ...input, pullRequestTitle: "Changed title" },
      { ...input, pullRequestBody: "Changed body" },
      { ...input, expectedPullRequestUpdatedAt: "2026-08-14T00:00:01.000Z" },
      { ...input, cliVersion: "0.8.17" },
      { ...input, cliCommitSha: "0".repeat(40) },
      { ...input, cliArtifactSha256: digest("changed CLI artifact") },
      { ...input, configurationSha256: digest("changed configuration") },
      { ...input, providerIdentity: "provider-v2" },
      { ...input, retryLineage: "review:99:attempt:2" },
      { ...input, baselineReviewId: "97" },
      { ...input, baselineHeadSha: "3".repeat(40) },
      { ...input, baselineEnvelopeSha256: digest("changed baseline") },
      { ...input, sinceSha: "5".repeat(40) },
      { ...input, bounded: false },
      { ...input, sinceSha: undefined, forceFullReview: true },
      { ...input, detailsUrl: "https://postil.dev/orgs/acme/runs/run-18" },
    ]) expect(githubPublicationInputIdentity(changed)).not.toBe(identity);
    const withoutOptionalFields = buildGitHubPublicationInputIdentity({
      ...input,
      baselineReviewId: undefined,
      baselineHeadSha: undefined,
      baselineEnvelopeSha256: undefined,
      detailsUrl: undefined,
    });
    expect(withoutOptionalFields.digest).not.toBe(identity);
    expect(withoutOptionalFields.value.baseline).toBeNull();
    expect(withoutOptionalFields.value.detailsUrl).toBeNull();
    expect(withoutOptionalFields.value.sinceSha).toBe("4".repeat(40));

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
    expect(() => githubPublicationInputIdentity({
      ...input,
      forceFullReview: true,
    })).toThrow("full review cannot have an incremental review SHA");
  });

  test("keeps the maximum accepted input below its canonical artifact ceiling", () => {
    const detailsPrefix = "https://example.test/";
    const input = {
      databaseRepositoryId: "9223372036854775807",
      githubRepositoryId: "9223372036854775807",
      repositoryFullName: `${"a".repeat(100)}/${"b".repeat(100)}`,
      pullRequestNumber: "2147483647",
      controllerGeneration: "9223372036854775807",
      reviewId: "9223372036854775807",
      headSha: "a".repeat(64),
      mergeBaseSha: "b".repeat(64),
      targetSha: "c".repeat(64),
      targetBranch: "t".repeat(255),
      pullRequestTitle: "T".repeat(512),
      pullRequestBody: "B".repeat(65_536),
      expectedPullRequestUpdatedAt: "2026-08-14T00:00:00.000Z",
      cliVersion: "v".repeat(100),
      cliCommitSha: "d".repeat(64),
      cliArtifactSha256: digest("maximum CLI artifact"),
      configurationSha256: digest("maximum configuration"),
      providerIdentity: "p".repeat(2_048),
      retryLineage: "r".repeat(200),
      baselineReviewId: "9223372036854775807",
      baselineHeadSha: "e".repeat(64),
      baselineEnvelopeSha256: digest("maximum baseline"),
      sinceSha: "f".repeat(64),
      bounded: true,
      forceFullReview: false,
      detailsUrl: `${detailsPrefix}${"d".repeat(2_048 - detailsPrefix.length)}`,
    };
    const built = buildGitHubPublicationInputIdentity(input);
    expect(built.bytes.byteLength).toBeLessThan(16 * 1024);
    expect(built.value.pullRequestTitleSha256).toBe(digest(input.pullRequestTitle));
    expect(built.value.pullRequestBodySha256).toBe(digest(input.pullRequestBody));
    expect("pullRequestTitle" in built.value).toBe(false);
    expect("pullRequestBody" in built.value).toBe(false);

    expect(() => buildGitHubPublicationInputIdentity({
      ...input,
      providerIdentity: "p".repeat(2_049),
    })).toThrow("provider identity is invalid");
    expect(() => buildGitHubPublicationInputIdentity({
      ...input,
      pullRequestBody: "B".repeat(65_537),
    })).toThrow("pull request snapshot text is invalid");
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
      const artifactDirectory = await lstat(join(outputFileArgument(args), ".."));
      expect(artifactDirectory.mode & 0o777).toBe(0o700);
      await writeEnvelope(args, envelope());
      return executionResult(0);
    };

    const result = await runGitHubPublicationCliPlanning({
      execute,
      environment: { TEST_MODE: "1" },
      workingDirectory,
      expected,
      inputIdentity,
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

    await expectNoControllerArtifacts(workingDirectory);
    await expect(runGitHubPublicationCliPlanning({
      execute,
      environment: { TEST_MODE: "1" },
      workingDirectory,
      expected,
      inputIdentity,
    }, { parsePlanBytes: acceptedPlanParser() })).resolves.toMatchObject({ exitCode: 0 });

    await expect(runGitHubPublicationCliPlanning({
      execute,
      environment: { TEST_MODE: "1" },
      workingDirectory,
      expected,
      inputIdentity: { ...inputIdentity, sinceSha: "e".repeat(40) },
    }, { parsePlanBytes: acceptedPlanParser() })).rejects.toThrow(
      "different publication input identity",
    );
    await expectNoControllerArtifacts(workingDirectory);
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
      inputIdentity,
    }, { parsePlanBytes: acceptedPlanParser() })).rejects.toThrow(
      "private envelope artifact identity changed before cleanup",
    );
  });

  test("removes its private directory when initialization fails", async () => {
    const workingDirectory = await temporaryDirectory();
    await expect(runGitHubPublicationCliPlanning({
      execute: async () => executionResult(0),
      environment: {},
      workingDirectory,
      expected,
      inputIdentity,
    }, {
      afterArtifactDirectoryCreated: async (artifactDirectory) => {
        await chmod(artifactDirectory, 0o755);
      },
    })).rejects.toThrow("private artifact directory is not owner-only");
    await expectNoControllerArtifacts(workingDirectory);
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
      inputIdentity,
    }, { parsePlanBytes: acceptedPlanParser() })).rejects.toThrow(
      "exit status disagrees",
    );

    const headDirectory = await temporaryDirectory();
    await expect(runGitHubPublicationCliPlanning({
      execute: executorForEnvelope(envelope({ headSha: "d".repeat(40) }), 0),
      environment: {},
      workingDirectory: headDirectory,
      expected,
      inputIdentity,
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
      inputIdentity,
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
        inputIdentity,
      }, { parsePlanBytes: acceptedPlanParser() })).rejects.toThrow(message);
      await expectNoControllerArtifacts(workingDirectory);
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

async function expectNoControllerArtifacts(workingDirectory: string): Promise<void> {
  expect(
    (await readdir(workingDirectory)).filter((name) =>
      name.startsWith(".postil-controller-")
    ),
  ).toEqual([]);
}
