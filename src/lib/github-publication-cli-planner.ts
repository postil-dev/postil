import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
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

interface GitHubPublicationCliPlanningDependencies {
  parsePlanBytes?: typeof parseGitHubPublicationPlanBytes;
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
    expected.mergeBaseSha,
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
    reject("CLI envelope targets a different base SHA");
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

function assertGitSha(value: string, label: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) reject(`${label} is invalid`);
}

function reject(reason: string): never {
  throw new Error(`GitHub publication CLI planning rejected: ${reason}`);
}
