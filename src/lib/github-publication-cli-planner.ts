import { createHash } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  type IngestedEnvelope,
  ingestEnvelope,
  type Finding,
} from "@/lib/envelope";
import {
  type AcceptedGitHubPublicationPlan,
  type ExpectedGitHubPublicationPlan,
  parseGitHubPublicationPlanBytes,
} from "@/lib/github-publication-plan";
import {
  type PrivateJsonArtifact,
  readPrivateJsonArtifactExact,
} from "@/lib/private-json-artifact";

const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const ENVELOPE_ARTIFACT_NAME = ".postil-controller-envelope.json";

export interface PublicationCliExecutionObservers {
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
  preserveOutputOnInterrupt?: boolean;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface PublicationCliExecutionResult {
  exitCode: number | null;
  stdout: string;
  stdoutBytes: Uint8Array;
  stderr: string;
  timedOut: boolean;
  interrupted: boolean;
}

export type PublicationCliExecutor = (
  args: string[],
  environment: Record<string, string>,
  workingDirectory: string,
  observers: PublicationCliExecutionObservers,
) => Promise<PublicationCliExecutionResult>;

export interface GitHubPublicationCliPlanningRequest {
  execute: PublicationCliExecutor;
  environment: Record<string, string>;
  workingDirectory: string;
  expected: ExpectedGitHubPublicationPlan;
  bounded?: boolean;
  baselinePath?: string;
  sinceSha?: string;
  signal?: AbortSignal;
  onStderrLine?: (line: string) => void;
}

export interface GitHubPublicationCliPlanningResult {
  acceptedPlan: AcceptedGitHubPublicationPlan;
  envelopeArtifact: PrivateJsonArtifact;
  ingestedEnvelope: IngestedEnvelope;
  exitCode: 0 | 1;
  stderr: string;
}

export interface GitHubPublicationInputIdentity {
  databaseRepositoryId: string;
  githubRepositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: string;
  controllerGeneration: string;
  reviewId: string;
  headSha: string;
  mergeBaseSha: string;
  targetSha: string;
  targetBranch: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  expectedPullRequestUpdatedAt: string;
  cliVersion: string;
  cliCommitSha: string;
  cliArtifactSha256: string;
  configurationSha256: string;
  providerIdentity: string;
  retryLineage: string;
  baselineReviewId?: string;
  baselineHeadSha?: string;
  baselineEnvelopeSha256?: string;
  bounded: boolean;
  forceFullReview: boolean;
  detailsUrl?: string;
}

interface GitHubPublicationCliPlanningDependencies {
  parsePlanBytes?: typeof parseGitHubPublicationPlanBytes;
}

/** Bind every service-owned input that can change one publication plan. */
export function githubPublicationInputIdentity(
  input: GitHubPublicationInputIdentity,
): string {
  for (const [name, value] of [
    ["database repository", input.databaseRepositoryId],
    ["GitHub repository", input.githubRepositoryId],
    ["pull request", input.pullRequestNumber],
    ["controller generation", input.controllerGeneration],
    ["review", input.reviewId],
  ] as const) assertDecimal(value, name);
  for (const [name, value] of [
    ["head", input.headSha],
    ["merge base", input.mergeBaseSha],
    ["target", input.targetSha],
    ["CLI commit", input.cliCommitSha],
    ...(input.baselineHeadSha === undefined
      ? []
      : [["baseline head", input.baselineHeadSha] as const]),
  ]) assertGitSha(value, `${name} SHA`);
  if (!/^sha256:[0-9a-f]{64}$/.test(input.configurationSha256)) {
    reject("configuration digest is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.cliArtifactSha256)) {
    reject("CLI artifact digest is invalid");
  }
  if (
    input.baselineEnvelopeSha256 !== undefined &&
    !/^sha256:[0-9a-f]{64}$/.test(input.baselineEnvelopeSha256)
  ) {
    reject("baseline envelope digest is invalid");
  }
  if ((input.baselineReviewId === undefined) !== (input.baselineHeadSha === undefined)) {
    reject("baseline review identity is incomplete");
  }
  if ((input.baselineReviewId === undefined) !== (input.baselineEnvelopeSha256 === undefined)) {
    reject("baseline envelope identity is incomplete");
  }
  if (input.baselineReviewId !== undefined) {
    assertDecimal(input.baselineReviewId, "baseline review");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      input.expectedPullRequestUpdatedAt,
    ) ||
    !Number.isFinite(Date.parse(input.expectedPullRequestUpdatedAt)) ||
    new Date(input.expectedPullRequestUpdatedAt).toISOString() !==
      input.expectedPullRequestUpdatedAt
  ) {
    reject("pull request update timestamp is invalid");
  }
  if (!/^[^/\s]{1,100}\/[^/\s]{1,100}$/.test(input.repositoryFullName)) {
    reject("repository full name is invalid");
  }
  if (
    input.targetBranch.length === 0 ||
    Buffer.byteLength(input.targetBranch, "utf8") > 255 ||
    input.pullRequestTitle.length === 0 ||
    Buffer.byteLength(input.pullRequestTitle, "utf8") > 512 ||
    Buffer.byteLength(input.pullRequestBody, "utf8") > 65_536
  ) {
    reject("pull request snapshot text is invalid");
  }
  for (const [name, value, maximum] of [
    ["CLI version", input.cliVersion, 100],
    ["provider identity", input.providerIdentity, 2_048],
    ["retry lineage", input.retryLineage, 200],
  ] as const) {
    if (value.length === 0 || Buffer.byteLength(value, "utf8") > maximum) {
      reject(`${name} is invalid`);
    }
  }
  if (input.detailsUrl !== undefined) {
    if (Buffer.byteLength(input.detailsUrl, "utf8") > 2_048) {
      reject("details URL is invalid");
    }
    let url: URL;
    try {
      url = new URL(input.detailsUrl);
    } catch {
      reject("details URL is invalid");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== ""
    ) reject("details URL is invalid");
  }
  const canonical = {
    version: "github-publication-input-v1",
    databaseRepositoryId: input.databaseRepositoryId,
    githubRepositoryId: input.githubRepositoryId,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    controllerGeneration: input.controllerGeneration,
    reviewId: input.reviewId,
    headSha: input.headSha,
    mergeBaseSha: input.mergeBaseSha,
    targetSha: input.targetSha,
    targetBranch: input.targetBranch,
    pullRequestTitleSha256: textDigest(input.pullRequestTitle),
    pullRequestBodySha256: textDigest(input.pullRequestBody),
    expectedPullRequestUpdatedAt: input.expectedPullRequestUpdatedAt,
    cliVersion: input.cliVersion,
    cliCommitSha: input.cliCommitSha,
    cliArtifactSha256: input.cliArtifactSha256,
    configurationSha256: input.configurationSha256,
    providerIdentity: input.providerIdentity,
    retryLineage: input.retryLineage,
    baseline: input.baselineReviewId === undefined
      ? null
      : {
        reviewId: input.baselineReviewId,
        headSha: input.baselineHeadSha!,
        envelopeSha256: input.baselineEnvelopeSha256!,
      },
    bounded: input.bounded,
    forceFullReview: input.forceFullReview,
    detailsUrl: input.detailsUrl ?? null,
  };
  return textDigest(JSON.stringify(canonical));
}

/**
 * Run the pinned CLI as a pure planner and authenticate both of its outputs.
 *
 * The plan travels only over the bounded child stdout pipe. The envelope is
 * written into an owner-only inode created before the child starts and read
 * back through the same-inode private artifact guard.
 */
export async function runGitHubPublicationCliPlanning(
  request: GitHubPublicationCliPlanningRequest,
  dependencies: GitHubPublicationCliPlanningDependencies = {},
): Promise<GitHubPublicationCliPlanningResult> {
  const envelopePath = join(request.workingDirectory, ENVELOPE_ARTIFACT_NAME);
  const handle = await open(envelopePath, "wx", 0o600);
  let artifactIdentity: { dev: bigint; ino: bigint };
  try {
    const stat = await handle.stat({ bigint: true });
    artifactIdentity = { dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close();
  }
  try {
    const expected = request.expected;
    const args = [
      "review",
      "--forge",
      "github",
      "--repo",
      expected.repositoryFullName,
      "--pr",
      String(expected.pullRequestNumber),
      "--sha",
      expected.headSha,
      "--base-sha",
      expected.targetSha,
    ];
    if (request.bounded) args.push("--bounded");
    if (request.sinceSha !== undefined) {
      assertGitSha(request.sinceSha, "incremental review SHA");
      args.push("--since-sha", request.sinceSha);
    }
    if (request.baselinePath !== undefined) {
      if (request.baselinePath.length === 0) reject("baseline path is empty");
      args.push("--baseline", request.baselinePath);
    }
    args.push(
      "--publication-plan-output",
      "-",
      "--publication-generation",
      String(expected.controllerGeneration),
      "--publication-input-identity",
      expected.inputIdentity,
      "--output",
      "json",
      "--output-file",
      envelopePath,
    );

    const execution = await request.execute(
    args,
    request.environment,
    request.workingDirectory,
    {
      signal: request.signal,
      onStderrLine: request.onStderrLine,
      preserveOutputOnInterrupt: true,
      maxStdoutBytes: MAX_PLAN_BYTES,
      maxStderrBytes: MAX_DIAGNOSTIC_BYTES,
    },
  );
    if (execution.timedOut) reject("CLI planning timed out");
    if (execution.interrupted) reject("CLI planning was interrupted");
    if (execution.exitCode !== 0 && execution.exitCode !== 1) {
      reject(`CLI planning exited with code ${execution.exitCode ?? "unknown"}`);
    }

    const envelopeArtifact = await readPrivateJsonArtifactExact(envelopePath, {
      maximumBytes: MAX_ENVELOPE_BYTES,
      expectedIdentity: artifactIdentity,
    });
    const envelopeText = new TextDecoder("utf-8", { fatal: true }).decode(
      envelopeArtifact.bytes,
    );
    const ingestedEnvelope = ingestEnvelope(envelopeText);
    if (ingestedEnvelope.envelope.headSha !== expected.headSha) {
      reject("CLI envelope targets a different head SHA");
    }
    if (ingestedEnvelope.envelope.baseSha !== expected.mergeBaseSha) {
      reject("CLI envelope targets a different merge-base SHA");
    }
    if ((execution.exitCode === 1) !== ingestedEnvelope.gateFailing) {
      reject("CLI exit status disagrees with the authenticated envelope gate");
    }

    const acceptedPlan = (dependencies.parsePlanBytes ?? parseGitHubPublicationPlanBytes)(
      execution.stdoutBytes,
      expected,
    );
    validatePlanAgainstEnvelope(acceptedPlan, ingestedEnvelope);
    return {
      acceptedPlan,
      envelopeArtifact,
      ingestedEnvelope,
      exitCode: execution.exitCode,
      stderr: execution.stderr,
    };
  } finally {
    await unlinkOwnedPrivateArtifact(envelopePath, artifactIdentity);
  }
}

function validatePlanAgainstEnvelope(
  acceptedPlan: AcceptedGitHubPublicationPlan,
  ingested: IngestedEnvelope,
): void {
  const plan = acceptedPlan.value;
  const envelope = ingested.envelope;
  const expectedGateConclusion = ingested.gateFailing ? "failure" : "success";
  if (plan.gateAnalysis.analyzedConclusion !== expectedGateConclusion) {
    reject("CLI plan gate analysis disagrees with the authenticated envelope");
  }
  const hasOperationalFailure = envelope.findings.some((finding) =>
    finding.path === ".postil/operational" || finding.path === ".postil/provider"
  );
  const expectedAdvisoryConclusion = hasOperationalFailure ? "failure" : "success";
  const advisoryCompletion = plan.operations.find((operation) =>
    operation.kind === "advisoryCheckComplete"
  );
  if (
    advisoryCompletion?.kind !== "advisoryCheckComplete" ||
    advisoryCompletion.conclusion !== expectedAdvisoryConclusion
  ) {
    reject("CLI advisory completion disagrees with the authenticated envelope");
  }

  const findingsById = new Map<string, Finding>();
  for (const finding of [
    ...envelope.findings,
    ...envelope.resolved,
    ...(envelope.suppressedFindings?.map((entry) => entry.finding) ?? []),
  ]) {
    if (finding.id) findingsById.set(finding.id, finding);
  }
  for (const lifecycle of plan.lifecycleReceipt.findings) {
    if (!lifecycle.stableIdentity) continue;
    const finding = findingsById.get(lifecycle.findingId);
    if (!finding) reject("CLI lifecycle receipt names an unknown stable finding");
    if (
      lifecycle.path !== finding.path ||
      lifecycle.line !== finding.line ||
      lifecycle.endLine !== finding.endLine ||
      lifecycle.contentDigest !== findingContentDigest(finding)
    ) {
      reject("CLI lifecycle receipt differs from its envelope finding");
    }
  }
  if (!expectedReviewOutputDigests(plan, envelope).has(plan.reviewOutputDigest)) {
    reject("CLI review output digest disagrees with the authenticated envelope");
  }
}

function expectedReviewOutputDigests(
  plan: AcceptedGitHubPublicationPlan["value"],
  envelope: IngestedEnvelope["envelope"],
): Set<string> {
  const allFindings = [
    ...envelope.findings,
    ...envelope.resolved,
    ...(envelope.suppressedFindings?.map((entry) => entry.finding) ?? []),
  ];
  const findings = plan.lifecycleReceipt.findings.map((lifecycle) => {
    const finding = lifecycle.stableIdentity
      ? allFindings.find((candidate) => candidate.id === lifecycle.findingId)
      : allFindings.find((candidate) =>
        candidate.path === lifecycle.path &&
        candidate.line === lifecycle.line &&
        candidate.endLine === lifecycle.endLine &&
        findingContentDigest(candidate) === lifecycle.contentDigest
      );
    if (!finding) reject("CLI lifecycle receipt cannot be bound to an envelope finding");
    const suppressed = (envelope.suppressedFindings ?? []).find((entry) =>
      entry.finding === finding ||
      (finding.id !== undefined && entry.finding.id === finding.id) ||
      findingContentDigest(entry.finding) === lifecycle.contentDigest
    );
    return {
      findingId: lifecycle.findingId,
      contentDigest: findingContentDigest(finding),
      initialOutcome: lifecycle.initialOutcome,
      suppressionReason: suppressed?.reason ?? null,
    };
  }).sort((left, right) =>
    left.findingId < right.findingId ? -1 : left.findingId > right.findingId ? 1 : 0
  );
  const advisoryCreate = plan.operations.find((operation) =>
    operation.kind === "advisoryCheckCreate"
  );
  if (advisoryCreate?.kind !== "advisoryCheckCreate") {
    reject("CLI plan omits advisory creation");
  }
  const advisory = envelope.findings.some((finding) =>
    finding.path === ".postil/operational" || finding.path === ".postil/provider"
  ) ? "failure" : "success";
  const gate = envelope.gate.failing ? "failure" : "success";
  const duplicateOfBaseline = plan.lifecycleReceipt.duplicateOfBaseline;
  const annotateFindings = plan.lifecycleReceipt.channel === "checkAnnotations";
  const hasReviewCreate = plan.operations.some((operation) => operation.kind === "reviewCreate");
  const shouldCommentCandidates = annotateFindings
    ? [false, true]
    : [hasReviewCreate];
  return new Set(shouldCommentCandidates.map((shouldComment) => {
    const canonical = {
      controllerGeneration: plan.controllerGeneration,
      inputIdentity: plan.inputIdentity,
      repositoryId: plan.repository.id,
      pullRequestNumber: plan.pullRequestNumber,
      headSha: plan.reviewedSnapshot.headSha,
      mergeBaseSha: plan.reviewedSnapshot.mergeBaseSha,
      targetSha: plan.reviewedSnapshot.targetSha,
      pullRequestTitleSha256: plan.reviewedSnapshot.pullRequestTitleSha256,
      pullRequestBodySha256: plan.reviewedSnapshot.pullRequestBodySha256,
      shouldComment,
      duplicateOfBaseline,
      annotateFindings,
      advisory,
      gate,
      detailsUrl: advisoryCreate.detailsUrl ?? null,
      findings,
    };
    return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
  }));
}

function findingContentDigest(finding: Finding): string {
  const canonical = {
    path: finding.path,
    line: finding.line,
    ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
    severity: finding.severity,
    kind: finding.kind,
    confidence: finding.confidence,
    title: finding.title,
    body: finding.body,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

function textDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function assertDecimal(value: string, label: string): void {
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    reject(`${label} identity is invalid`);
  }
}

function assertGitSha(value: string, label: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) reject(`${label} is invalid`);
}

async function unlinkOwnedPrivateArtifact(
  path: string,
  identity: { dev: bigint; ino: bigint },
): Promise<void> {
  try {
    const current = await lstat(path, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      reject("private envelope artifact identity changed before cleanup");
    }
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function reject(reason: string): never {
  throw new Error(`GitHub publication CLI planning rejected: ${reason}`);
}
