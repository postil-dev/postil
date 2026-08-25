import { createHash } from "node:crypto";

import {
  buildGitHubPublicationControllerManifest,
  type AuthoritativeGateOutput,
  type GitHubPublicationControllerManifest,
} from "@/lib/github-publication-controller-manifest";
import {
  parseGitHubPublicationPlanBytes,
  type GitHubPublicationOperation,
  type GitHubPublicationPlan,
} from "@/lib/github-publication-plan";
import {
  parsePublicationReceipt,
  type PublicationReceipt,
} from "@/lib/publication-receipt";

const MAX_OPERATIONS = 128;
const MAX_CURRENT_ATTEMPTS = MAX_OPERATIONS * 6;
const MAX_CURRENT_RECONCILIATIONS = MAX_OPERATIONS;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60_000 + 1_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_CARRIED_BINDINGS = 64;
const MAX_STRING_BYTES = 8 * 1024;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const DECIMAL_IDENTIFIER = /^[1-9][0-9]{0,18}$/;

type JsonObject = Record<string, unknown>;
type OperationState =
  | "pending"
  | "applying"
  | "unknown"
  | "applied"
  | "skipped"
  | "superseded"
  | "failed";
type AttemptPhase =
  | "claimed"
  | "dispatched"
  | "not_dispatched"
  | "ambiguous"
  | "applied"
  | "rejected";

export interface GitHubPublicationReceiptGenerationSnapshot {
  databaseRepositoryId: string;
  githubRepositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  publicationGeneration: string;
  reviewId: string;
  acceptedReviewId: string;
  acceptedInputDigest: string;
  highWaterInputDigest: string;
  headSha: string;
  highWaterHeadSha: string;
  mergeBaseSha: string;
  targetSha: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  acceptedPlanBytes: Uint8Array;
  acceptedPlanDigest: string;
  planSemanticDigest: string;
  operationCount: number;
  operationManifestDigest: string;
  controllerOperationCount: number;
  controllerOperationManifestDigest: string;
  controllerManifestBytes: Uint8Array;
  controllerManifestDigest: string;
  sealedAt: Date | null;
}

export interface GitHubPublicationReceiptOperationSnapshot {
  operationKey: string;
  operationOrdinal: number;
  operationSource: "cli" | "service";
  kind: string;
  controllerRecord: JsonObject;
  controllerRecordBytes: Uint8Array;
  operationRecord: JsonObject;
  operationRecordBytes: Uint8Array;
  activation: JsonObject;
  activationBytes: Uint8Array;
  desiredPayload: JsonObject;
  desiredPayloadBytes: Uint8Array;
  desiredPayloadDigest: string;
  state: OperationState;
  attemptCount: number;
  leaseGeneration: string;
  selectedVariant: string | null;
  terminalEvidence: JsonObject | null;
  updatedAt: Date;
}

export interface GitHubPublicationReceiptAttemptSnapshot {
  operationKey: string;
  attemptNumber: number;
  leaseGeneration: string;
  phase: AttemptPhase;
  selectedVariant: string;
  evidencePayload: JsonObject | null;
  remoteIdentity: string | null;
  remoteOperationId: string | null;
  observedAt: Date;
}

export interface GitHubPublicationReceiptReconciliationSnapshot {
  operationKey: string;
  attemptNumber: number;
  leaseGeneration: string;
  phase: "retry" | "terminal";
  selectedVariant: string;
  outcome: "exact_absence" | "applied";
  evidencePayload: JsonObject;
  remoteIdentity: string | null;
  remoteOperationId: string | null;
  observedAt: Date;
}

export interface CarriedCommentBinding {
  findingId: string;
  commentId: string;
}

export interface GitHubPublicationReceiptEvidenceSnapshot {
  generation: GitHubPublicationReceiptGenerationSnapshot;
  operations: GitHubPublicationReceiptOperationSnapshot[];
  attempts: GitHubPublicationReceiptAttemptSnapshot[];
  reconciliations: GitHubPublicationReceiptReconciliationSnapshot[];
  carriedCommentBindings: CarriedCommentBinding[];
}

export class GitHubPublicationReceiptDerivationError extends Error {
  override name = "GitHubPublicationReceiptDerivationError";

  constructor(reason: string, options?: ErrorOptions) {
    super(`GitHub publication receipt derivation rejected: ${reason}`, options);
  }
}

interface ValidatedArtifacts {
  plan: GitHubPublicationPlan;
  manifest: GitHubPublicationControllerManifest;
  operationsByKey: Map<string, GitHubPublicationReceiptOperationSnapshot>;
  requiredCliOperationKeys: Set<string>;
}

interface ExactOperationSerialization {
  operation: string;
  activation: string;
  desired: string;
}

interface TerminalEvidence {
  state: "applied" | "skipped" | "failed";
  outcome:
    | "created"
    | "reconciledExisting"
    | "partialObserved"
    | "applied"
    | "notRequiredMarkerPresent"
    | "notRequiredContentExact"
    | "rejected";
  result: JsonObject;
  remoteId?: string;
  remoteOperationId?: string;
  httpStatus?: number;
  classification?: "invalidReviewCommentPlacement";
  selectedVariant: string;
  attemptNumber: number;
  leaseGeneration: string;
  observedAt: Date;
  source: "attempt" | "reconciliation" | "terminal";
}

interface ObservedReviewComment {
  commentId: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  body: string;
}

interface ObservedReviewContent {
  body: string;
  comments: ObservedReviewComment[];
}

interface ObservedFileCommentContent {
  body: string;
  commitId: string;
  path: string;
  subjectType: "file";
}

interface ObservedFindingCommentContent {
  body: string;
}

interface ObservedCheckAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  annotationLevel: "notice" | "warning" | "failure";
  title: string;
  message: string;
}

interface ObservedCheckContent {
  name: string;
  headSha: string;
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  annotations: ObservedCheckAnnotation[];
  detailsUrl?: string;
}

/** Derive one receipt without performing a GitHub mutation or database write. */
export function deriveGitHubPublicationReceipt(
  snapshot: GitHubPublicationReceiptEvidenceSnapshot,
): PublicationReceipt {
  const artifacts = validateArtifacts(snapshot);
  const terminals = validateRequiredTerminalEvidence(snapshot, artifacts);
  validateTerminalOperationSemantics(artifacts, terminals);
  return materializeReceipt(
    artifacts,
    terminals,
    snapshot.carriedCommentBindings,
  );
}

function validateArtifacts(
  snapshot: GitHubPublicationReceiptEvidenceSnapshot,
): ValidatedArtifacts {
  const generation = snapshot.generation;
  if (generation.sealedAt === null || !validDate(generation.sealedAt)) {
    reject("the current publication generation is not sealed");
  }
  const exactIdentities: Array<[unknown, unknown, string]> = [
    [generation.reviewId, generation.acceptedReviewId, "accepted review"],
    [generation.acceptedInputDigest, generation.highWaterInputDigest, "accepted input"],
    [generation.headSha, generation.highWaterHeadSha, "accepted head"],
  ];
  for (const [actual, expected, name] of exactIdentities) {
    if (actual !== expected) reject(`high-water ${name} identity drifted`);
  }
  decimal(generation.databaseRepositoryId, "database repository identity");
  decimal(generation.githubRepositoryId, "GitHub repository identity");
  decimal(generation.publicationGeneration, "publication generation");
  decimal(generation.reviewId, "review identity");
  positiveInteger(generation.pullRequestNumber, "pull request identity");
  rawDigest(generation.acceptedInputDigest, "accepted input digest");
  rawDigest(generation.acceptedPlanDigest, "accepted plan digest");
  rawDigest(generation.planSemanticDigest, "plan semantic digest");
  prefixedDigest(generation.operationManifestDigest, "operation manifest digest");
  prefixedDigest(
    generation.controllerOperationManifestDigest,
    "controller operation manifest digest",
  );
  prefixedDigest(
    generation.controllerManifestDigest,
    "controller manifest digest",
  );
  boundedBytes(generation.acceptedPlanBytes, "accepted plan");
  boundedBytes(generation.controllerManifestBytes, "controller manifest");
  if (digestRaw(generation.acceptedPlanBytes) !== generation.acceptedPlanDigest) {
    reject("accepted plan bytes drifted from their digest");
  }
  if (
    digestPrefixed(generation.controllerManifestBytes) !==
      generation.controllerManifestDigest
  ) {
    reject("controller manifest bytes drifted from their digest");
  }

  const preliminaryPlan = object(
    decodeJson(generation.acceptedPlanBytes, "accepted plan"),
    "accepted plan",
  );
  const preliminaryReviewOutputDigest = prefixedDigest(
    preliminaryPlan.reviewOutputDigest,
    "review output digest",
  );
  let plan: GitHubPublicationPlan;
  try {
    plan = parseGitHubPublicationPlanBytes(generation.acceptedPlanBytes, {
      controllerGeneration: generation.publicationGeneration,
      inputIdentity: `sha256:${generation.acceptedInputDigest}`,
      reviewOutputDigest: preliminaryReviewOutputDigest,
      repositoryId: generation.githubRepositoryId,
      repositoryFullName: generation.repositoryFullName,
      pullRequestNumber: String(generation.pullRequestNumber),
      headSha: generation.headSha,
      mergeBaseSha: generation.mergeBaseSha,
      targetSha: generation.targetSha,
      pullRequestTitle: generation.pullRequestTitle,
      pullRequestBody: generation.pullRequestBody,
    }).value;
  } catch (error) {
    reject("accepted plan does not satisfy its sealed strict contract", error);
  }
  if (plan.intentDigest.slice("sha256:".length) !== generation.planSemanticDigest) {
    reject("accepted plan semantic digest drifted");
  }
  if (
    plan.operationCount !== generation.operationCount ||
    plan.operationManifestDigest !== generation.operationManifestDigest
  ) {
    reject("accepted plan operation identity drifted");
  }

  const manifest = object(
    decodeJson(generation.controllerManifestBytes, "controller manifest"),
    "controller manifest",
  ) as unknown as GitHubPublicationControllerManifest;
  if (
    bytesText(generation.controllerManifestBytes, "controller manifest") !==
      canonicalJson(manifest)
  ) {
    reject("controller manifest bytes are not canonical");
  }
  validateManifestIdentity(generation, plan, manifest);

  if (snapshot.operations.length !== manifest.operationCount) {
    reject("canonical operation rows do not match the controller manifest count");
  }
  const exactOperationSerializations = rebuildOperationSerializations(
    snapshot,
    plan,
    manifest,
  );
  const operationsByKey = new Map<string, GitHubPublicationReceiptOperationSnapshot>();
  let aggregateArtifactBytes = 0;
  for (const [index, operation] of snapshot.operations.entries()) {
    validateOperationRecord(
      operation,
      manifest,
      plan,
      index,
      exactOperationSerializations[index]!,
    );
    aggregateArtifactBytes +=
      operation.controllerRecordBytes.byteLength +
      operation.operationRecordBytes.byteLength +
      operation.activationBytes.byteLength +
      operation.desiredPayloadBytes.byteLength;
    if (aggregateArtifactBytes > MAX_ARTIFACT_BYTES * 4) {
      reject("canonical operation artifacts exceed the aggregate bound");
    }
    if (operationsByKey.has(operation.operationKey)) {
      reject("canonical operation identity is duplicated");
    }
    operationsByKey.set(operation.operationKey, operation);
  }
  if (
    digestPrefixed(
      Buffer.from(
        `[${snapshot.operations
          .map((operation) => bytesText(operation.controllerRecordBytes, "controller operation"))
          .join(",")}]`,
        "utf8",
      ),
    ) !== generation.controllerOperationManifestDigest
  ) {
    reject("canonical controller operation records drifted from their manifest digest");
  }
  const requiredCliOperationKeys = requiredCliOperations(
    plan,
    manifest,
    operationsByKey,
  );
  return { plan, manifest, operationsByKey, requiredCliOperationKeys };
}

function validateManifestIdentity(
  generation: GitHubPublicationReceiptGenerationSnapshot,
  plan: GitHubPublicationPlan,
  manifest: GitHubPublicationControllerManifest,
): void {
  const exact: Array<[unknown, unknown]> = [
    [manifest.version, "github-publication-controller-v1"],
    [manifest.forge, "github"],
    [manifest.controllerGeneration, plan.controllerGeneration],
    [manifest.inputIdentity, plan.inputIdentity],
    [manifest.reviewOutputDigest, plan.reviewOutputDigest],
    [manifest.repository?.id, plan.repository.id],
    [manifest.repository?.fullName, plan.repository.fullName],
    [manifest.pullRequestNumber, plan.pullRequestNumber],
    [manifest.headSha, plan.reviewedSnapshot.headSha],
    [manifest.acceptedPlanIntentDigest, plan.intentDigest],
    [manifest.acceptedPlanOperationManifestDigest, plan.operationManifestDigest],
    [manifest.acceptedPlanBytesDigest, `sha256:${generation.acceptedPlanDigest}`],
    [manifest.acceptedCliOperationCount, plan.operationCount],
    [manifest.operationCount, generation.controllerOperationCount],
    [manifest.operationManifestDigest, generation.controllerOperationManifestDigest],
  ];
  if (exact.some(([actual, expected]) => actual !== expected)) {
    reject("accepted plan and controller manifest identities drifted");
  }
  if (!Array.isArray(manifest.operations) || manifest.operations.length !== manifest.operationCount) {
    reject("controller manifest operation count is invalid");
  }
  if (digestPrefixed(Buffer.from(canonicalJson(manifest.operations))) !== manifest.operationManifestDigest) {
    reject("controller manifest operation digest is invalid");
  }
}

function rebuildOperationSerializations(
  snapshot: GitHubPublicationReceiptEvidenceSnapshot,
  plan: GitHubPublicationPlan,
  manifest: GitHubPublicationControllerManifest,
): ExactOperationSerialization[] {
  const gateCompletion = manifest.operations.find(
    (record) => object(record.operation, "controller operation").kind === "gateCheckComplete",
  );
  if (gateCompletion === undefined) reject("controller manifest omits gate completion");
  const gateOperation = object(gateCompletion.operation, "gate completion operation");
  const gatePayload = object(gateOperation.payload, "gate completion payload");
  const selection = object(gatePayload.selection, "gate completion selection");
  const outputs = object(gatePayload.outputs, "gate completion outputs");
  const policy = object(outputs.policy, "gate policy output");
  const rebuilt = buildGitHubPublicationControllerManifest({
    acceptedPlan: plan,
    acceptedPlanBytesDigest: `sha256:${snapshot.generation.acceptedPlanDigest}`,
    requiredTerminalOperationKeys: stringArray(
      selection.requiredOperationKeys,
      "gate completion required operations",
    ),
    gateOutput: policy as AuthoritativeGateOutput,
  });
  if (
    rebuilt.digest !== snapshot.generation.controllerManifestDigest ||
    bytesText(rebuilt.bytes, "rebuilt controller manifest") !==
      bytesText(snapshot.generation.controllerManifestBytes, "controller manifest")
  ) {
    reject("controller manifest cannot be deterministically rebuilt from the sealed plan");
  }
  return rebuilt.value.operations.map((record, index) => {
    const operation = (
      record.source === "cli" ? plan.operations[index] : record.operation
    ) as JsonObject;
    return {
      operation: JSON.stringify(operation),
      activation: JSON.stringify(operation.activation),
      desired: JSON.stringify(operationDesired(operation)),
    };
  });
}

function validateOperationRecord(
  row: GitHubPublicationReceiptOperationSnapshot,
  manifest: GitHubPublicationControllerManifest,
  plan: GitHubPublicationPlan,
  index: number,
  exactSerialization: ExactOperationSerialization,
): void {
  if (row.operationOrdinal !== index + 1) {
    reject("canonical operation ordinals are not contiguous");
  }
  const expectedController = object(
    manifest.operations[index],
    "controller operation record",
  );
  const expectedOperation = object(
    expectedController.operation,
    "controller operation",
  );
  const expectedSource = expectedController.source;
  const expectedComponentOperation =
    expectedSource === "cli"
      ? object(plan.operations[index], "accepted CLI operation")
      : expectedOperation;
  if (
    (expectedSource !== "cli" && expectedSource !== "service") ||
    row.operationSource !== expectedSource ||
    !jsonEqual(row.controllerRecord, expectedController) ||
    !jsonEqual(row.operationRecord, expectedComponentOperation)
  ) {
    reject("canonical operation row differs from the sealed controller manifest");
  }
  boundedBytes(row.controllerRecordBytes, "controller operation record");
  boundedBytes(row.operationRecordBytes, "operation record");
  boundedBytes(row.activationBytes, "operation activation");
  boundedBytes(row.desiredPayloadBytes, "operation desired payload");
  if (
    bytesText(row.controllerRecordBytes, "controller operation record") !==
      canonicalJson(expectedController)
  ) {
    reject("controller operation record bytes are not canonical");
  }
  const operationBytesMatch =
    bytesText(row.operationRecordBytes, "operation record") === exactSerialization.operation;
  const activationBytesMatch =
    bytesText(row.activationBytes, "operation activation") === exactSerialization.activation;
  const desiredBytesMatch =
    bytesText(row.desiredPayloadBytes, "operation desired payload") === exactSerialization.desired;
  if (!operationBytesMatch || !activationBytesMatch || !desiredBytesMatch) {
    reject("operation serialized bytes drifted from their sealed records");
  }
  if (
    !jsonEqual(
      decodeJson(row.operationRecordBytes, "operation record"),
      expectedComponentOperation,
    ) ||
    !jsonEqual(
      decodeJson(row.activationBytes, "operation activation"),
      row.activation,
    ) ||
    !jsonEqual(
      decodeJson(row.desiredPayloadBytes, "operation desired payload"),
      row.desiredPayload,
    )
  ) {
    reject("operation component bytes drifted from their canonical record");
  }
  const desired = operationDesired(expectedComponentOperation);
  if (!jsonEqual(row.desiredPayload, desired)) {
    reject("operation desired payload drifted from its sealed record");
  }
  if (
    row.desiredPayloadDigest !== expectedComponentOperation.desiredDigest ||
    digestPrefixed(row.desiredPayloadBytes) !== row.desiredPayloadDigest
  ) {
    reject(
      `operation ${row.operationOrdinal} desired payload digest drifted ` +
        `(${row.desiredPayloadDigest} != ${digestPrefixed(row.desiredPayloadBytes)})`,
    );
  }
  if (
    row.operationKey !== expectedOperation.operationKey ||
    row.kind !== expectedOperation.kind ||
    !jsonEqual(row.activation, expectedComponentOperation.activation)
  ) {
    reject("operation identity drifted from its canonical record");
  }
  if (row.operationSource === "cli") {
    const expectedPlanOperation = plan.operations[index];
    if (expectedPlanOperation === undefined || !jsonEqual(expectedPlanOperation, expectedOperation)) {
      reject("CLI operation record drifted from the accepted plan");
    }
  }
  if (!validDate(row.updatedAt)) reject("operation update time is invalid");
  if (!Number.isSafeInteger(row.attemptCount) || row.attemptCount < 0) {
    reject("operation attempt count is invalid");
  }
  if (!/^0$|^[1-9][0-9]{0,18}$/.test(row.leaseGeneration)) {
    reject("operation lease generation is invalid");
  }
}

function requiredCliOperations(
  plan: GitHubPublicationPlan,
  manifest: GitHubPublicationControllerManifest,
  operationsByKey: ReadonlyMap<string, GitHubPublicationReceiptOperationSnapshot>,
): Set<string> {
  const gateCompletionRecords = manifest.operations.filter((record) =>
    object(record.operation, "controller operation").kind === "gateCheckComplete"
  );
  if (gateCompletionRecords.length !== 1) {
    reject("controller manifest does not contain one gate completion");
  }
  const completionRecord = gateCompletionRecords[0]!;
  if (completionRecord.source !== "service") {
    reject("controller gate completion is not service-owned");
  }
  const completion = object(completionRecord.operation, "gate completion operation");
  const completionRow = operationsByKey.get(
    text(completion.operationKey, "gate completion identity"),
  );
  if (
    completionRow?.operationSource !== "service" ||
    completionRow.kind !== "gateCheckComplete"
  ) {
    reject("controller gate completion row is missing or inconsistent");
  }
  const remoteReference = object(completion.remoteId, "gate remote identity");
  if (remoteReference.source !== "operation") {
    reject("gate completion remote identity is not operation-bound");
  }
  const gateCreateKey = text(remoteReference.operationKey, "gate creation dependency");
  const gateCreate = operationsByKey.get(gateCreateKey);
  if (
    gateCreate?.operationSource !== "service" ||
    gateCreate.kind !== "gateCheckCreate"
  ) {
    reject("gate completion does not reference its service-owned creation");
  }
  const dependencyRoots = stringArray(
    completion.dependencies,
    "gate completion dependencies",
  ).filter(
    (key) => key !== gateCreateKey,
  );
  const payload = object(completion.payload, "gate completion payload");
  const selection = object(payload.selection, "gate completion selection");
  if (
    selection.kind !== "required-terminal-dependency-state-v1" ||
    selection.policyFailurePrecedence !== true
  ) {
    reject("gate completion has an unsupported terminal selection policy");
  }
  const dependencyFailureStates = stringArray(
    selection.dependencyFailureStates,
    "gate dependency failure states",
  );
  if (
    dependencyFailureStates.length !== 2 ||
    dependencyFailureStates[0] !== "failed" ||
    dependencyFailureStates[1] !== "superseded"
  ) {
    reject("gate completion has an unsupported dependency failure policy");
  }
  const roots = stringArray(
    selection.requiredOperationKeys,
    "gate required operation identities",
  );
  if (
    new Set(roots).size !== roots.length ||
    roots.length !== dependencyRoots.length ||
    roots.some((key) => !dependencyRoots.includes(key))
  ) {
    reject("gate completion selection differs from its terminal dependencies");
  }
  const required = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (required.has(key)) continue;
    const operation = operationsByKey.get(key);
    if (operation === undefined || operation.operationSource !== "cli") {
      reject("gate completion references a non-CLI required operation");
    }
    required.add(key);
    pending.push(
      ...stringArray(operation.operationRecord.dependencies, "operation dependencies"),
    );
  }
  const planKeys = new Set(plan.operations.map((operation) => operation.operationKey));
  if (required.size !== planKeys.size || [...planKeys].some((key) => !required.has(key))) {
    reject("gate completion does not transitively seal every CLI operation");
  }
  return required;
}

function validateRequiredTerminalEvidence(
  snapshot: GitHubPublicationReceiptEvidenceSnapshot,
  artifacts: ValidatedArtifacts,
): Map<string, TerminalEvidence> {
  if (snapshot.attempts.length > MAX_CURRENT_ATTEMPTS) {
    reject("current attempt evidence exceeds its bound");
  }
  if (snapshot.reconciliations.length > MAX_CURRENT_RECONCILIATIONS) {
    reject("current reconciliation evidence exceeds its bound");
  }
  let aggregateEvidenceBytes = 0;
  for (const evidence of [
    ...snapshot.attempts.map((entry) => entry.evidencePayload),
    ...snapshot.reconciliations.map((entry) => entry.evidencePayload),
    ...snapshot.operations.map((entry) => entry.terminalEvidence),
  ]) {
    if (evidence === null) continue;
    aggregateEvidenceBytes += Buffer.byteLength(canonicalJson(evidence), "utf8");
    if (aggregateEvidenceBytes > MAX_EVIDENCE_BYTES) {
      reject("terminal publication evidence exceeds the aggregate bound");
    }
  }

  const attemptsByOperation = groupBy(snapshot.attempts, (entry) => entry.operationKey);
  const reconciliationsByOperation = groupBy(
    snapshot.reconciliations,
    (entry) => entry.operationKey,
  );
  const terminals = new Map<string, TerminalEvidence>();
  for (const operationKey of artifacts.requiredCliOperationKeys) {
    const operation = artifacts.operationsByKey.get(operationKey)!;
    if (
      operation.state === "pending" ||
      operation.state === "applying" ||
      operation.state === "unknown"
    ) {
      reject(`required operation ${operation.operationOrdinal} is not terminal`);
    }
    if (operation.state === "superseded") {
      reject(`required operation ${operation.operationOrdinal} was superseded`);
    }
    const attempts = attemptsByOperation.get(operationKey) ?? [];
    const reconciliations = reconciliationsByOperation.get(operationKey) ?? [];
    terminals.set(
      operationKey,
      terminalEvidenceForOperation(operation, attempts, reconciliations),
    );
  }
  for (const attempt of snapshot.attempts) {
    if (!artifacts.operationsByKey.has(attempt.operationKey)) {
      reject("attempt evidence names an unknown operation");
    }
  }
  for (const reconciliation of snapshot.reconciliations) {
    if (!artifacts.operationsByKey.has(reconciliation.operationKey)) {
      reject("reconciliation evidence names an unknown operation");
    }
  }
  return terminals;
}

function terminalEvidenceForOperation(
  operation: GitHubPublicationReceiptOperationSnapshot,
  attempts: GitHubPublicationReceiptAttemptSnapshot[],
  reconciliations: GitHubPublicationReceiptReconciliationSnapshot[],
): TerminalEvidence {
  if (operation.attemptCount < 1 || operation.leaseGeneration === "0") {
    reject("required terminal operation has no current attempt identity");
  }
  const phases = new Map<AttemptPhase, GitHubPublicationReceiptAttemptSnapshot>();
  const variants = new Set<string>();
  const activationVariants = new Set<string>();
  for (const attempt of attempts) {
    if (
      attempt.attemptNumber !== operation.attemptCount ||
      attempt.leaseGeneration !== operation.leaseGeneration
    ) {
      reject("stale attempt evidence was offered for receipt derivation");
    }
    if (phases.has(attempt.phase)) reject("current attempt phase is duplicated");
    if (attempt.selectedVariant !== operation.kind) {
      reject("current attempt selected variant differs from its operation kind");
    }
    variants.add(attempt.selectedVariant);
    if (attempt.phase !== "claimed") {
      validatePhaseEvidenceIdentity(operation, attempt);
      activationVariants.add(
        text(attempt.evidencePayload!.activationVariant, "activation variant"),
      );
    } else if (attempt.evidencePayload !== null) {
      reject("claim evidence unexpectedly carries a payload");
    }
    phases.set(attempt.phase, attempt);
  }
  if (phases.get("claimed") === undefined) {
    reject("required terminal operation has no exact claim evidence");
  }
  if (reconciliations.some((entry) =>
    entry.attemptNumber !== operation.attemptCount ||
    entry.leaseGeneration !== operation.leaseGeneration
  )) {
    reject("stale reconciliation evidence was offered for receipt derivation");
  }
  if (reconciliations.length > 1) {
    reject("current operation has contradictory reconciliation evidence");
  }
  for (const reconciliation of reconciliations) {
    if (reconciliation.selectedVariant !== operation.kind) {
      reject("reconciliation selected variant differs from its operation kind");
    }
    variants.add(reconciliation.selectedVariant);
    validatePhaseEvidenceIdentity(operation, reconciliation);
    activationVariants.add(
      text(reconciliation.evidencePayload.activationVariant, "activation variant"),
    );
  }
  if (variants.size !== 1) {
    reject("current operation evidence contains contradictory variants");
  }
  const evidenceVariant = variants.values().next().value;
  if (
    typeof evidenceVariant !== "string" ||
    evidenceVariant !== operation.kind ||
    (operation.selectedVariant !== null && operation.selectedVariant !== operation.kind)
  ) {
    reject("current operation evidence has the wrong selected variant");
  }
  if (activationVariants.size !== 1) {
    reject("current operation evidence contains contradictory activation variants");
  }

  if (operation.state === "applied") {
    if (operation.terminalEvidence !== null || operation.selectedVariant === null) {
      reject("applied operation carries contradictory terminal state");
    }
    const direct = phases.get("applied");
    const reconciled = reconciliations[0];
    if ((direct === undefined) === (reconciled === undefined)) {
      reject("applied operation must have one exact terminal evidence source");
    }
    if (direct !== undefined) {
      requireExactPhases(phases, ["claimed", "dispatched", "applied"]);
      requirePhase(phases, "claimed", phases.get("dispatched")!.observedAt);
      requirePhase(phases, "dispatched", direct.observedAt);
      return evidenceFromAttempt(operation, direct, "applied");
    }
    if (
      reconciled?.phase !== "terminal" ||
      reconciled.outcome !== "applied" ||
      phases.get("ambiguous") === undefined
    ) {
      reject("applied reconciliation does not close the current ambiguity");
    }
    requireExactPhases(phases, ["claimed", "dispatched", "ambiguous"]);
    const dispatched = phases.get("dispatched")!;
    const ambiguous = phases.get("ambiguous")!;
    requirePhase(phases, "claimed", dispatched.observedAt);
    requirePhase(phases, "dispatched", ambiguous.observedAt);
    if (ambiguous.observedAt.getTime() > reconciled.observedAt.getTime()) {
      reject("terminal reconciliation precedes the ambiguity it closes");
    }
    return evidenceFromReconciliation(operation, reconciled);
  }

  if (operation.state === "failed") {
    if (
      operation.selectedVariant === null ||
      operation.selectedVariant !== operation.kind ||
      operation.terminalEvidence === null ||
      reconciliations.length > 0
    ) {
      reject("failed operation lacks exact rejection state");
    }
    const rejected = phases.get("rejected");
    if (rejected === undefined || !jsonEqual(rejected.evidencePayload, operation.terminalEvidence)) {
      reject("failed operation does not match its append-only rejection evidence");
    }
    requireExactPhases(phases, ["claimed", "dispatched", "rejected"]);
    requirePhase(phases, "claimed", phases.get("dispatched")!.observedAt);
    requirePhase(phases, "dispatched", rejected.observedAt);
    return evidenceFromAttempt(operation, rejected, "failed");
  }

  if (operation.state !== "skipped") {
    reject("required operation has an unsupported terminal state");
  }
  if (operation.selectedVariant !== null || operation.terminalEvidence === null) {
    reject("skipped operation lacks exact no-write terminal evidence");
  }
  if (reconciliations.length > 0) {
    reject("skipped operation has contradictory reconciliation evidence");
  }
  const notDispatched = phases.get("not_dispatched");
  if (
    notDispatched === undefined ||
    phases.has("dispatched") ||
    phases.has("applied") ||
    phases.has("rejected") ||
    phases.has("ambiguous")
  ) {
    reject("skipped operation has contradictory dispatch evidence");
  }
  requireExactPhases(phases, ["claimed", "not_dispatched"]);
  requirePhase(phases, "claimed", notDispatched.observedAt);
  const attemptPayload = object(
    notDispatched.evidencePayload,
    "not-dispatched evidence",
  );
  const terminalPayload = operation.terminalEvidence;
  if (
    attemptPayload.outcome !== "notDispatched" ||
    !jsonEqual(withoutKey(attemptPayload, "outcome"), withoutKey(terminalPayload, "outcome"))
  ) {
    reject("skipped operation terminal evidence drifted from its append-only attempt");
  }
  return evidenceFromPayload(
    operation,
    terminalPayload,
    notDispatched,
    "skipped",
    "terminal",
  );
}

function evidenceFromAttempt(
  operation: GitHubPublicationReceiptOperationSnapshot,
  attempt: GitHubPublicationReceiptAttemptSnapshot,
  state: "applied" | "failed",
): TerminalEvidence {
  if (attempt.evidencePayload === null) {
    reject("terminal attempt evidence payload is absent");
  }
  return evidenceFromPayload(operation, attempt.evidencePayload, attempt, state, "attempt");
}

function evidenceFromReconciliation(
  operation: GitHubPublicationReceiptOperationSnapshot,
  reconciliation: GitHubPublicationReceiptReconciliationSnapshot,
): TerminalEvidence {
  return evidenceFromPayload(
    operation,
    reconciliation.evidencePayload,
    reconciliation,
    "applied",
    "reconciliation",
  );
}

function evidenceFromPayload(
  operation: GitHubPublicationReceiptOperationSnapshot,
  payload: JsonObject,
  row:
    | GitHubPublicationReceiptAttemptSnapshot
    | GitHubPublicationReceiptReconciliationSnapshot,
  state: "applied" | "skipped" | "failed",
  source: TerminalEvidence["source"],
): TerminalEvidence {
  if (
    payload.operationKey !== operation.operationKey ||
    payload.requestDigest !== operation.desiredPayloadDigest ||
    payload.selectedVariant !== row.selectedVariant ||
    typeof payload.activationVariant !== "string" ||
    payload.activationVariant.length === 0
  ) {
    reject("terminal evidence drifted from its operation, variant, or request digest");
  }
  if (!activationVariantAllowed(operation.operationRecord, payload.activationVariant)) {
    reject("terminal evidence activation variant is not a sealed alternative");
  }
  if (
    operation.selectedVariant !== null &&
    operation.selectedVariant !== row.selectedVariant
  ) {
    reject("terminal evidence variant differs from the operation state");
  }
  const observedAt = evidenceTimestamp(payload.observedAt, row.observedAt);
  if (row.observedAt.getTime() > operation.updatedAt.getTime() + 1_000) {
    reject("terminal evidence is later than its operation state");
  }
  const outcome = terminalOutcome(payload.outcome);
  const result = object(payload.result, "terminal evidence result");
  if (payload.resultDigest !== digestPrefixed(Buffer.from(canonicalJson(result)))) {
    reject("terminal evidence result digest drifted");
  }
  const remoteId = optionalRemoteId(payload.remoteId, "remote identity");
  const remoteOperationId = optionalRemoteId(
    payload.remoteOperationId,
    "remote operation identity",
  );
  if ((remoteId === undefined) !== (remoteOperationId === undefined)) {
    reject("terminal evidence carries an incomplete remote identity");
  }
  if (source !== "terminal") {
    const expectedRemote = row.remoteIdentity ?? undefined;
    const expectedOperation = row.remoteOperationId ?? undefined;
    if (remoteId !== expectedRemote || remoteOperationId !== expectedOperation) {
      reject("terminal evidence remote identity drifted from its database columns");
    }
  }
  const httpStatus = payload.httpStatus;
  if (
    httpStatus !== undefined &&
    (!Number.isSafeInteger(httpStatus) || (httpStatus as number) < 100 || (httpStatus as number) > 599)
  ) {
    reject("terminal evidence HTTP status is invalid");
  }
  const classification = payload.classification;
  if (
    classification !== undefined &&
    classification !== "invalidReviewCommentPlacement"
  ) {
    reject("terminal evidence classification is invalid");
  }
  return {
    state,
    outcome,
    result,
    selectedVariant: row.selectedVariant,
    attemptNumber: row.attemptNumber,
    leaseGeneration: row.leaseGeneration,
    observedAt,
    source,
    ...(remoteId === undefined ? {} : { remoteId }),
    ...(remoteOperationId === undefined ? {} : { remoteOperationId }),
    ...(httpStatus === undefined ? {} : { httpStatus: httpStatus as number }),
    ...(classification === undefined
      ? {}
      : { classification: "invalidReviewCommentPlacement" as const }),
  };
}

function validatePhaseEvidenceIdentity(
  operation: GitHubPublicationReceiptOperationSnapshot,
  row:
    | GitHubPublicationReceiptAttemptSnapshot
    | GitHubPublicationReceiptReconciliationSnapshot,
): void {
  const payload = object(row.evidencePayload, "operation phase evidence");
  if (
    payload.operationKey !== operation.operationKey ||
    payload.requestDigest !== operation.desiredPayloadDigest ||
    payload.selectedVariant !== row.selectedVariant ||
    typeof payload.activationVariant !== "string" ||
    payload.activationVariant.length === 0
  ) {
    reject("operation phase evidence drifted from its operation or request identity");
  }
  if (!activationVariantAllowed(operation.operationRecord, payload.activationVariant)) {
    reject("operation phase evidence activation variant is not a sealed alternative");
  }
  evidenceTimestamp(payload.observedAt, row.observedAt);
}

function validateTerminalOperationSemantics(
  artifacts: ValidatedArtifacts,
  terminals: ReadonlyMap<string, TerminalEvidence>,
): void {
  for (const operationKey of artifacts.requiredCliOperationKeys) {
    const operation = artifacts.operationsByKey.get(operationKey)!;
    const terminal = terminals.get(operationKey)!;
    const plannedOperation = artifacts.plan.operations.find(
      (entry) => entry.operationKey === operationKey,
    );
    if (plannedOperation === undefined) {
      reject("required operation is absent from the accepted plan");
    }
    if (terminal.state === "failed") {
      if (!semanticPlacementRejection(operation, terminal)) {
        reject(`required operation ${operation.operationOrdinal} failed definitively`);
      }
      const acceptedByFallback = [...artifacts.requiredCliOperationKeys].some((candidateKey) => {
        const candidate = artifacts.operationsByKey.get(candidateKey)!;
        const conditions = activationConditions(candidate.operationRecord);
        return conditions.some((condition) =>
          condition.condition === "semanticPlacementRejected" &&
          condition.dependencyOperationKey === operationKey &&
          condition.httpStatus === 422 &&
          condition.classification === "invalidReviewCommentPlacement"
        );
      });
      if (!acceptedByFallback) {
        reject("semantic review placement rejection has no sealed fallback");
      }
      continue;
    }

    if (terminal.state === "skipped") {
      if (
        terminal.outcome !== "reconciledExisting" &&
        terminal.outcome !== "notRequiredMarkerPresent" &&
        terminal.outcome !== "notRequiredContentExact"
      ) {
        reject("skipped operation has an unsupported terminal outcome");
      }
      if (
        terminal.outcome !== "notRequiredMarkerPresent" &&
        terminal.remoteId === undefined
      ) {
        reject("skipped operation lacks exact existing remote evidence");
      }
    }

    switch (plannedOperation.kind) {
      case "reviewCreate":
        validateReviewTerminal(plannedOperation, terminal);
        break;
      case "fileCommentFallback":
        validateFileCommentFallbackTerminal(plannedOperation, terminal);
        break;
      case "findingCommentUpdate":
        validateFindingCommentUpdateTerminal(plannedOperation, terminal);
        break;
      case "reviewSummaryUpdate":
        validateReviewSummaryTerminal(
          plannedOperation,
          terminal,
          artifacts,
          terminals,
        );
        break;
      case "advisoryCheckCreate":
        validateRemoteTerminal(plannedOperation, terminal, "checkRunId", [
          "created",
          "reconciledExisting",
        ]);
        break;
      case "advisoryCheckComplete":
        validateAdvisoryCheckCompleteTerminal(plannedOperation, terminal);
        break;
      default:
        reject("required CLI operation kind is unsupported by receipt derivation");
    }
  }

  const advisoryCreate = artifacts.plan.operations.find(
    (operation) => operation.kind === "advisoryCheckCreate",
  );
  const advisoryComplete = artifacts.plan.operations.find(
    (operation) => operation.kind === "advisoryCheckComplete",
  );
  if (advisoryCreate === undefined || advisoryComplete === undefined) {
    reject("accepted plan omits the advisory check lifecycle");
  }
  const createIdentity = terminals.get(advisoryCreate.operationKey)?.remoteId;
  const completeIdentity = terminals.get(advisoryComplete.operationKey)?.remoteId;
  if (createIdentity === undefined || completeIdentity !== createIdentity) {
    reject("advisory check completion does not match its exact creation identity");
  }
}

function validateReviewTerminal(
  operation: Extract<GitHubPublicationOperation, { kind: "reviewCreate" }>,
  terminal: TerminalEvidence,
): void {
  if (terminal.state === "failed") return;
  if (terminal.remoteId === undefined) {
    if (
      terminal.state !== "skipped" ||
      terminal.outcome !== "notRequiredMarkerPresent"
    ) {
      reject("review operation lacks exact remote evidence");
    }
    return;
  }
  if (
    terminal.outcome !== "created" &&
    terminal.outcome !== "reconciledExisting" &&
    terminal.outcome !== "partialObserved"
  ) {
    reject("review operation has an unsupported terminal outcome");
  }
  if (terminal.result.reviewId !== terminal.remoteId) {
    reject("review evidence result has the wrong remote identity");
  }
  validateReviewContent(operation, terminal.result);
}

function validateReviewContent(
  operation: Extract<GitHubPublicationOperation, { kind: "reviewCreate" }>,
  result: JsonObject,
): void {
  const observed = observedReviewContent(result.observedContent);
  if (observed.body !== operation.payload.body) {
    reject("review evidence does not match the sealed review body");
  }

  const commentIdsByMarker = object(
    result.commentIdsByMarker,
    "review comment identities",
  );
  const missingMarkers = stringArray(
    result.missingCommentMarkers,
    "missing review comment markers",
  );
  if (new Set(missingMarkers).size !== missingMarkers.length) {
    reject("missing review comment markers contain duplicates");
  }
  const observedById = new Map<string, ObservedReviewComment>();
  for (const comment of observed.comments) {
    if (observedById.has(comment.commentId)) {
      reject("review evidence repeats an observed comment identity");
    }
    observedById.set(comment.commentId, comment);
  }
  if (observed.comments.length !== Object.keys(commentIdsByMarker).length) {
    reject("review evidence observed comments do not match its remote identities");
  }

  const expectedComments = operation.payload.comments ?? [];
  const seenExpected = new Set<number>();
  for (const [marker, rawCommentId] of Object.entries(commentIdsByMarker)) {
    const commentId = remoteId(rawCommentId, "review comment identity");
    const candidates = expectedComments.flatMap((comment, index) =>
      comment.body.includes(marker) ? [{ comment, index }] : [],
    );
    if (candidates.length !== 1) {
      reject("review evidence marker does not bind one sealed comment");
    }
    const expected = candidates[0]!;
    if (seenExpected.has(expected.index)) {
      reject("review evidence reuses one sealed comment marker");
    }
    seenExpected.add(expected.index);
    const actual = observedById.get(commentId);
    if (actual === undefined) {
      reject("review evidence lacks typed content for an observed comment");
    }
    const expectedContent = expectedReviewComment(expected.comment);
    if (!jsonEqual(observedReviewCommentWithoutId(actual), expectedContent)) {
      reject("review evidence comment content does not match the sealed plan");
    }
  }

  const allMarkers = [...Object.keys(commentIdsByMarker), ...missingMarkers];
  if (
    new Set(allMarkers).size !== allMarkers.length ||
    seenExpected.size + missingMarkers.length !== expectedComments.length
  ) {
    reject("review evidence does not exactly partition the sealed comments");
  }
  for (const marker of missingMarkers) {
    const candidates = expectedComments.filter((comment) => comment.body.includes(marker));
    if (candidates.length !== 1) {
      reject("missing review marker does not bind one sealed comment");
    }
  }
}

function expectedReviewComment(
  comment: NonNullable<
    Extract<GitHubPublicationOperation, { kind: "reviewCreate" }>["payload"]["comments"]
  >[number],
): Omit<ObservedReviewComment, "commentId"> {
  return {
    path: comment.path,
    line: comment.line,
    side: comment.side,
    ...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
    ...(comment.startSide === undefined ? {} : { startSide: comment.startSide }),
    body: comment.body,
  };
}

function observedReviewCommentWithoutId(
  comment: ObservedReviewComment,
): Omit<ObservedReviewComment, "commentId"> {
  const { commentId: _commentId, ...content } = comment;
  return content;
}

function observedReviewContent(value: unknown): ObservedReviewContent {
  const content = object(value, "observed review content");
  requireKeys(content, ["body", "comments"], [], "observed review content");
  return {
    body: contentString(content.body, "observed review body"),
    comments: objectArray(content.comments, "observed review comments").map(
      observedReviewComment,
    ),
  };
}

function observedReviewComment(value: JsonObject): ObservedReviewComment {
  requireKeys(
    value,
    ["body", "commentId", "line", "path", "side"],
    ["startLine", "startSide"],
    "observed review comment",
  );
  const side = value.side;
  if (side !== "LEFT" && side !== "RIGHT") {
    reject("observed review comment side is invalid");
  }
  const startSide = value.startSide;
  if (startSide !== undefined && startSide !== "LEFT" && startSide !== "RIGHT") {
    reject("observed review comment start side is invalid");
  }
  return {
    commentId: remoteId(value.commentId, "observed review comment identity"),
    path: contentString(value.path, "observed review comment path", 4_096),
    line: positiveInteger(value.line, "observed review comment line"),
    side,
    ...(value.startLine === undefined
      ? {}
      : { startLine: positiveInteger(value.startLine, "observed review comment start line") }),
    ...(startSide === undefined ? {} : { startSide }),
    body: contentString(value.body, "observed review comment body"),
  };
}

function observedFileCommentContent(value: unknown): ObservedFileCommentContent {
  const content = object(value, "observed file comment content");
  requireKeys(content, ["body", "commitId", "path", "subjectType"], [], "observed file comment content");
  if (content.subjectType !== "file") {
    reject("observed file comment subject type is invalid");
  }
  return {
    body: contentString(content.body, "observed file comment body"),
    commitId: contentString(content.commitId, "observed file comment commit", 100),
    path: contentString(content.path, "observed file comment path", 4_096),
    subjectType: "file",
  };
}

function observedFindingCommentContent(value: unknown): ObservedFindingCommentContent {
  const content = object(value, "observed finding comment content");
  requireKeys(content, ["body"], [], "observed finding comment content");
  return { body: contentString(content.body, "observed finding comment body") };
}

function observedCheckContent(value: unknown): ObservedCheckContent {
  const content = object(value, "observed check content");
  requireKeys(
    content,
    ["annotations", "conclusion", "headSha", "name", "summary", "title"],
    ["detailsUrl"],
    "observed check content",
  );
  if (
    content.conclusion !== "success" &&
    content.conclusion !== "failure" &&
    content.conclusion !== "neutral"
  ) {
    reject("observed check conclusion is invalid");
  }
  return {
    name: contentString(content.name, "observed check name", 255),
    headSha: contentString(content.headSha, "observed check head", 100),
    conclusion: content.conclusion,
    title: contentString(content.title, "observed check title", 255),
    summary: contentString(content.summary, "observed check summary"),
    annotations: objectArray(content.annotations, "observed check annotations").map(
      observedCheckAnnotation,
    ),
    ...(content.detailsUrl === undefined
      ? {}
      : { detailsUrl: contentString(content.detailsUrl, "observed check details URL", 2_048) }),
  };
}

function observedCheckAnnotation(value: JsonObject): ObservedCheckAnnotation {
  requireKeys(
    value,
    ["annotationLevel", "endLine", "message", "path", "startLine", "title"],
    [],
    "observed check annotation",
  );
  if (
    value.annotationLevel !== "notice" &&
    value.annotationLevel !== "warning" &&
    value.annotationLevel !== "failure"
  ) {
    reject("observed check annotation level is invalid");
  }
  return {
    path: contentString(value.path, "observed check annotation path", 4_096),
    startLine: positiveInteger(value.startLine, "observed check annotation start line"),
    endLine: positiveInteger(value.endLine, "observed check annotation end line"),
    annotationLevel: value.annotationLevel,
    title: contentString(value.title, "observed check annotation title", 255),
    message: contentString(value.message, "observed check annotation message", 65_535),
  };
}

function validateRemoteTerminal(
  operation: JsonObject,
  terminal: TerminalEvidence,
  resultField: "reviewId" | "commentId" | "checkRunId",
  acceptedOutcomes: readonly TerminalEvidence["outcome"][],
): void {
  if (
    terminal.state === "skipped" &&
    terminal.outcome === "notRequiredMarkerPresent" &&
    terminal.remoteId === undefined
  ) {
    return;
  }
  if (
    !acceptedOutcomes.includes(terminal.outcome) ||
    terminal.remoteId === undefined ||
    terminal.result[resultField] !== terminal.remoteId
  ) {
    reject(`operation ${operation.operationOrdinal} lacks exact ${resultField} evidence`);
  }
}

function validateFileCommentFallbackTerminal(
  operation: Extract<GitHubPublicationOperation, { kind: "fileCommentFallback" }>,
  terminal: TerminalEvidence,
): void {
  if (
    terminal.state === "skipped" &&
    terminal.outcome === "notRequiredMarkerPresent"
  ) {
    if (
      terminal.remoteId === undefined ||
      terminal.result.reviewId !== terminal.remoteId ||
      terminal.result.commentId !== undefined
    ) {
      reject("partial review fallback evidence must carry its review identity");
    }
    return;
  }
  validateRemoteTerminal(operation, terminal, "commentId", [
    "created",
    "reconciledExisting",
  ]);
  const observed = observedFileCommentContent(terminal.result.observedContent);
  const expected: ObservedFileCommentContent = {
    body: operation.payload.body,
    commitId: operation.payload.commitId,
    path: operation.payload.path,
    subjectType: operation.payload.subjectType,
  };
  if (!jsonEqual(observed, expected)) {
    reject("file comment evidence does not match the sealed content");
  }
}

function validateFindingCommentUpdateTerminal(
  operation: Extract<GitHubPublicationOperation, { kind: "findingCommentUpdate" }>,
  terminal: TerminalEvidence,
): void {
  validateRemoteTerminal(operation, terminal, "commentId", [
    "applied",
    "reconciledExisting",
    "notRequiredContentExact",
  ]);
  const target = remoteId(operation.observedCommentId, "sealed comment target");
  if (terminal.remoteId !== target || terminal.result.commentId !== target) {
    reject("finding comment update evidence targets a different remote comment");
  }
  const observed = observedFindingCommentContent(terminal.result.observedContent);
  if (observed.body !== operation.body) {
    reject("finding comment update evidence does not match the sealed content");
  }
}

function selectedReviewDependency(
  operation: Extract<GitHubPublicationOperation, { kind: "reviewSummaryUpdate" }>,
  plan: GitHubPublicationPlan,
  terminals: ReadonlyMap<string, TerminalEvidence>,
): {
  operation: Extract<GitHubPublicationOperation, { kind: "reviewCreate" }>;
  terminal: TerminalEvidence;
  body: string;
} {
  const conditions = operation.activation.anyOf.filter(
    (condition) => condition.condition === "reviewSelectionTerminal",
  );
  if (conditions.length !== 1) {
    reject("review summary does not seal one review selection alternative");
  }
  const condition = conditions[0]!;
  const candidates = condition.selectedReviewOperationKeys.flatMap((key) => {
    const candidate = plan.operations.find(
      (entry): entry is Extract<GitHubPublicationOperation, { kind: "reviewCreate" }> =>
        entry.operationKey === key && entry.kind === "reviewCreate",
    );
    const terminal = terminals.get(key);
    return candidate !== undefined &&
        terminal !== undefined &&
        terminal.remoteId !== undefined &&
        terminal.state !== "failed" &&
        ["created", "reconciledExisting", "partialObserved"].includes(terminal.outcome)
      ? [{ operation: candidate, terminal }]
      : [];
  });
  if (candidates.length !== 1) {
    reject("review summary does not have one uniquely selected review dependency");
  }
  const selected = candidates[0]!;
  const cases = operation.cases.filter(
    (summaryCase) =>
      summaryCase.selectedReviewOperationKey === selected.operation.operationKey &&
        summaryCase.selectedReviewOutcomes.includes(
          selected.terminal.outcome as (typeof summaryCase.selectedReviewOutcomes)[number],
        ),
  );
  if (cases.length !== 1) {
    reject("review summary does not have one selected content case");
  }
  return { ...selected, body: cases[0]!.body };
}

function validateReviewSummaryTerminal(
  operation: Extract<GitHubPublicationOperation, { kind: "reviewSummaryUpdate" }>,
  terminal: TerminalEvidence,
  artifacts: ValidatedArtifacts,
  terminals: ReadonlyMap<string, TerminalEvidence>,
): void {
  validateRemoteTerminal(operation, terminal, "reviewId", [
    "applied",
    "reconciledExisting",
    "notRequiredContentExact",
  ]);
  const planned = artifacts.plan.operations.find(
    (entry): entry is Extract<GitHubPublicationOperation, { kind: "reviewSummaryUpdate" }> =>
      entry.operationKey === operation.operationKey && entry.kind === "reviewSummaryUpdate",
  );
  if (planned === undefined) reject("review summary operation is absent from the accepted plan");
  const selected = selectedReviewDependency(planned, artifacts.plan, terminals);
  if (
    terminal.remoteId !== selected.terminal.remoteId ||
    terminal.result.reviewId !== selected.terminal.remoteId ||
    terminal.result.body !== selected.body
  ) {
    reject("review summary evidence targets a different review or body");
  }
  const observed = observedFindingCommentContent(terminal.result.observedContent);
  if (observed.body !== selected.body) {
    reject("review summary evidence does not match the sealed content");
  }
}

function validateAdvisoryCheckCompleteTerminal(
  operation: Extract<GitHubPublicationOperation, { kind: "advisoryCheckComplete" }>,
  terminal: TerminalEvidence,
): void {
  validateRemoteTerminal(operation, terminal, "checkRunId", ["applied"]);
  if (terminal.result.conclusion !== operation.conclusion) {
    reject("advisory check completion evidence has the wrong conclusion");
  }
  const observed = observedCheckContent(terminal.result.observedContent);
  const expected: ObservedCheckContent = {
    name: operation.name,
    headSha: operation.headSha,
    conclusion: operation.conclusion,
    title: operation.title,
    summary: operation.summary,
    annotations: (operation.annotations ?? []).map((annotation) => ({
      path: annotation.path,
      startLine: annotation.startLine,
      endLine: annotation.endLine,
      annotationLevel: annotation.annotationLevel,
      title: annotation.title,
      message: annotation.message,
    })),
    ...(operation.detailsUrl === undefined ? {} : { detailsUrl: operation.detailsUrl }),
  };
  if (!jsonEqual(observed, expected)) {
    reject("advisory check evidence does not match the sealed content");
  }
}

function materializeReceipt(
  artifacts: ValidatedArtifacts,
  terminals: ReadonlyMap<string, TerminalEvidence>,
  carriedCommentBindings: readonly CarriedCommentBinding[],
): PublicationReceipt {
  const lifecycle = artifacts.plan.lifecycleReceipt;
  const findingByMarker = new Map<string, typeof lifecycle.findings[number]>();
  for (const finding of lifecycle.findings) {
    for (const marker of [finding.marker, ...(finding.compatibleMarkers ?? [])]) {
      if (findingByMarker.has(marker)) {
        reject("lifecycle finding marker is duplicated");
      }
      findingByMarker.set(marker, finding);
    }
  }

  const reviewCandidates = artifacts.plan.operations
    .filter((operation) => operation.kind === "reviewCreate")
    .flatMap((operation) => {
      const terminal = terminals.get(operation.operationKey)!;
      return terminal.remoteId === undefined || terminal.state === "failed"
        ? []
        : [{ operation, terminal }];
    });
  if (reviewCandidates.length > 1) {
    reject("multiple review operations claim a terminal remote identity");
  }
  const selectedReview = reviewCandidates[0];
  const commentsByFinding = new Map<
    string,
    { outcome: "inline" | "fileComment"; commentId: string }
  >();
  const findingByComment = new Map<string, string>();
  const carriedCommentsByFinding = validateCarriedCommentBindings(
    lifecycle,
    carriedCommentBindings,
  );
  for (const [findingId, commentId] of carriedCommentsByFinding) {
    findingByComment.set(commentId, findingId);
  }
  const missingMarkers = new Set<string>();

  if (selectedReview !== undefined) {
    const expectedMarkers = reviewCommentMarkers(
      selectedReview.operation,
      findingByMarker,
    );
    const ids = object(
      selectedReview.terminal.result.commentIdsByMarker,
      "review comment identities",
    );
    const missing = stringArray(
      selectedReview.terminal.result.missingCommentMarkers,
      "missing review comment markers",
    );
    if (new Set(missing).size !== missing.length) {
      reject("missing review comment markers contain duplicates");
    }
    const supplied = new Set([...Object.keys(ids), ...missing]);
    if (
      supplied.size !== expectedMarkers.size ||
      [...expectedMarkers].some((marker) => !supplied.has(marker)) ||
      missing.some((marker) => Object.hasOwn(ids, marker))
    ) {
      reject("review evidence does not exactly cover its sealed comment markers");
    }
    if (
      selectedReview.terminal.outcome === "partialObserved" && missing.length === 0
    ) {
      reject("partial review evidence reports no missing comment marker");
    }
    if (
      selectedReview.terminal.outcome === "created" && missing.length > 0
    ) {
      reject("complete review evidence reports a missing comment marker");
    }
    for (const [marker, value] of Object.entries(ids)) {
      const finding = findingByMarker.get(marker);
      if (finding === undefined) reject("review evidence names an unknown finding marker");
      addFindingComment(
        commentsByFinding,
        findingByComment,
        finding.findingId,
        "inline",
        remoteId(value, "review comment identity"),
      );
    }
    missing.forEach((marker) => missingMarkers.add(marker));
  }

  for (const operation of artifacts.plan.operations) {
    const terminal = terminals.get(operation.operationKey)!;
    if (
      operation.kind === "fileCommentFallback" &&
      terminal.remoteId !== undefined &&
      terminal.outcome !== "notRequiredMarkerPresent"
    ) {
      addFindingComment(
        commentsByFinding,
        findingByComment,
        operation.findingId,
        "fileComment",
        terminal.remoteId,
      );
    }
    if (operation.kind === "findingCommentUpdate" && terminal.remoteId !== undefined) {
      const finding = lifecycle.findings.find(
        (entry) => entry.findingId === operation.findingId,
      );
      if (
        finding?.observedOutcome !== "inline" &&
        finding?.observedOutcome !== "fileComment"
      ) {
        reject("comment update evidence has no sealed placement classification");
      }
      addFindingComment(
        commentsByFinding,
        findingByComment,
        operation.findingId,
        finding.observedOutcome,
        terminal.remoteId,
      );
    }
  }

  const summaryCarrier = reviewSummaryCarrier(artifacts.plan, terminals, selectedReview);
  const summaryFindingIds = summaryEvidenceFindingIds(
    artifacts.plan,
    terminals,
    selectedReview,
    findingByMarker,
  );
  const semanticRejectedMarkers = semanticRejectedFindingMarkers(
    artifacts.plan,
    terminals,
    findingByMarker,
  );
  const advisoryCompletion = artifacts.plan.operations.find(
    (operation) => operation.kind === "advisoryCheckComplete",
  )!;
  const advisoryTerminal = terminals.get(advisoryCompletion.operationKey)!;
  const annotationCount = advisoryCompletion.annotations?.length ?? 0;
  const plannedAnnotationCount = lifecycle.findings.filter(
    (finding) => finding.initialOutcome === "checkAnnotation",
  ).length;
  if (
    lifecycle.channel === "checkAnnotations" &&
    annotationCount !== plannedAnnotationCount
  ) {
    reject("check annotation evidence does not match the sealed finding classification");
  }
  if (
    lifecycle.channel === "checkAnnotations" &&
    (
      commentsByFinding.size > 0 ||
      carriedCommentsByFinding.size > 0 ||
      reviewCandidates.length > 0
    )
  ) {
    reject("check-annotation publication carries review-comment evidence");
  }
  if (
    lifecycle.channel === "checkAnnotations" &&
    (advisoryTerminal.state !== "applied" || advisoryTerminal.outcome !== "applied")
  ) {
    reject("check annotations lack exact terminal check evidence");
  }

  const findings = lifecycle.findings.map((finding) => {
    const comment = commentsByFinding.get(finding.findingId);
    if (comment !== undefined) {
      if (
        finding.initialOutcome !== "inline" &&
        finding.initialOutcome !== "fileComment"
      ) {
        reject("remote comment evidence contradicts the sealed lifecycle classification");
      }
      return {
        findingId: finding.findingId,
        stableIdentity: finding.stableIdentity,
        initialOutcome: comment.outcome,
        inlineRejected: false,
        commentId: comment.commentId,
      };
    }

    if (
      finding.initialOutcome === "inline" ||
      finding.initialOutcome === "fileComment"
    ) {
      const fallbackProven =
        (finding.fallbackIntent ?? []).includes("summaryOnly") &&
        summaryCarrier &&
        markersForFinding(finding).some((marker) =>
          missingMarkers.has(marker) || semanticRejectedMarkers.has(marker),
        );
      if (!fallbackProven) {
        reject("planned review comment identity has no exact applied evidence");
      }
      return {
        findingId: finding.findingId,
        stableIdentity: finding.stableIdentity,
        initialOutcome: "summaryOnly" as const,
        inlineRejected: finding.initialOutcome === "inline",
      };
    }

    const carriedCommentId = carriedCommentsByFinding.get(finding.findingId);
    if (finding.initialOutcome === "carried") {
      if (carriedCommentId === undefined) {
        reject("carried finding cannot materialize without a comment identity");
      }
      return {
        findingId: finding.findingId,
        stableIdentity: finding.stableIdentity,
        initialOutcome: "carried" as const,
        inlineRejected: false,
        commentId: carriedCommentId,
      };
    }

    if (
      finding.initialOutcome !== "checkAnnotation" &&
      finding.initialOutcome !== "summaryOnly" &&
      finding.initialOutcome !== "resolved" &&
      finding.initialOutcome !== "suppressed" &&
      finding.initialOutcome !== "unknown"
    ) {
      reject("lifecycle finding has an unsupported final classification");
    }
    if (
      lifecycle.channel === "reviewComments" &&
      finding.initialOutcome === "summaryOnly" &&
      (!summaryCarrier || !summaryFindingIds.has(finding.findingId))
    ) {
      reject("summary-only finding lacks exact review summary evidence");
    }
    if (
      lifecycle.channel === "checkAnnotations" &&
      finding.initialOutcome === "summaryOnly" &&
      !summaryFindingIds.has(finding.findingId)
    ) {
      reject("check summary-only finding lacks exact summary or finding evidence");
    }
    return {
      findingId: finding.findingId,
      stableIdentity: finding.stableIdentity,
      initialOutcome: finding.initialOutcome,
      inlineRejected: false,
    };
  });

  return parsePublicationReceipt({
    version: 2,
    channel: lifecycle.channel,
    receiptId: lifecycle.receiptId,
    ...(lifecycle.channel === "reviewComments" && selectedReview !== undefined
      ? { reviewId: selectedReview.terminal.remoteId }
      : {}),
    findings,
  });
}

function reviewSummaryCarrier(
  plan: GitHubPublicationPlan,
  terminals: ReadonlyMap<string, TerminalEvidence>,
  selectedReview:
    | {
        operation: Extract<GitHubPublicationOperation, { kind: "reviewCreate" }>;
        terminal: TerminalEvidence;
      }
    | undefined,
): boolean {
  const summaryOperation = plan.operations.find(
    (operation) => operation.kind === "reviewSummaryUpdate",
  );
  if (summaryOperation !== undefined) {
    const terminal = terminals.get(summaryOperation.operationKey)!;
    if (
      terminal.remoteId !== undefined &&
      (terminal.outcome === "applied" ||
        terminal.outcome === "reconciledExisting" ||
        terminal.outcome === "notRequiredContentExact")
    ) {
      return true;
    }
  }
  return (
    selectedReview !== undefined &&
    selectedReview.operation.payload.body.length > 0 &&
    (
      selectedReview.terminal.outcome === "created" ||
      selectedReview.terminal.outcome === "partialObserved"
    )
  );
}

function summaryEvidenceFindingIds(
  plan: GitHubPublicationPlan,
  terminals: ReadonlyMap<string, TerminalEvidence>,
  selectedReview:
    | {
        operation: Extract<GitHubPublicationOperation, { kind: "reviewCreate" }>;
        terminal: TerminalEvidence;
      }
    | undefined,
  findingByMarker: ReadonlyMap<
    string,
    GitHubPublicationPlan["lifecycleReceipt"]["findings"][number]
  >,
): Set<string> {
  const bodies: string[] = [];
  if (
    selectedReview !== undefined &&
    (selectedReview.terminal.outcome === "created" ||
      selectedReview.terminal.outcome === "partialObserved")
  ) {
    bodies.push(selectedReview.operation.payload.body);
  }
  const summary = plan.operations.find(
    (operation): operation is Extract<GitHubPublicationOperation, { kind: "reviewSummaryUpdate" }> =>
      operation.kind === "reviewSummaryUpdate",
  );
  if (summary !== undefined) {
    const terminal = terminals.get(summary.operationKey);
    if (
      terminal !== undefined &&
      (terminal.outcome === "applied" ||
        terminal.outcome === "reconciledExisting" ||
        terminal.outcome === "notRequiredContentExact")
    ) {
      const selected = selectedReviewDependency(summary, plan, terminals);
      bodies.push(selected.body);
    }
  }
  const check = plan.operations.find(
    (operation): operation is Extract<GitHubPublicationOperation, { kind: "advisoryCheckComplete" }> =>
      operation.kind === "advisoryCheckComplete",
  );
  if (check !== undefined) {
    bodies.push(check.summary);
    for (const annotation of check.annotations ?? []) {
      bodies.push(annotation.title, annotation.message);
    }
  }
  const findingIds = new Set<string>();
  for (const body of bodies) {
    for (const [marker, finding] of findingByMarker) {
      if (body.includes(marker)) findingIds.add(finding.findingId);
    }
  }
  return findingIds;
}

function markersForFinding(
  finding: GitHubPublicationPlan["lifecycleReceipt"]["findings"][number],
): string[] {
  return [finding.marker, ...(finding.compatibleMarkers ?? [])];
}

function semanticRejectedFindingMarkers(
  plan: GitHubPublicationPlan,
  terminals: ReadonlyMap<string, TerminalEvidence>,
  findingByMarker: ReadonlyMap<string, GitHubPublicationPlan["lifecycleReceipt"]["findings"][number]>,
): Set<string> {
  const markers = new Set<string>();
  for (const operation of plan.operations) {
    if (operation.kind !== "reviewCreate") continue;
    const terminal = terminals.get(operation.operationKey)!;
    if (!semanticPlacementRejectionRecord(terminal)) continue;
    for (const comment of operation.payload.comments ?? []) {
      const matches = [...findingByMarker.keys()].filter((marker) =>
        comment.body.includes(marker),
      );
      if (matches.length !== 1) {
        reject("rejected review comment does not bind one lifecycle finding marker");
      }
      markers.add(matches[0]!);
    }
  }
  return markers;
}

function reviewCommentMarkers(
  operation: Extract<GitHubPublicationOperation, { kind: "reviewCreate" }>,
  findingByMarker: ReadonlyMap<string, GitHubPublicationPlan["lifecycleReceipt"]["findings"][number]>,
): Set<string> {
  const markers = new Set<string>();
  for (const comment of operation.payload.comments ?? []) {
    const matches = [...findingByMarker.keys()].filter((marker) =>
      comment.body.includes(marker),
    );
    if (matches.length !== 1 || markers.has(matches[0]!)) {
      reject("review comment does not bind one unique lifecycle finding marker");
    }
    markers.add(matches[0]!);
  }
  return markers;
}

function validateCarriedCommentBindings(
  lifecycle: GitHubPublicationPlan["lifecycleReceipt"],
  bindings: readonly CarriedCommentBinding[],
): Map<string, string> {
  if (!Array.isArray(bindings)) {
    reject("carried comment bindings must be an array");
  }
  if (bindings.length > MAX_CARRIED_BINDINGS) {
    reject("carried comment bindings exceed their bound");
  }

  const required = new Map<string, string>();
  for (const finding of lifecycle.findings) {
    if (finding.initialOutcome === "carried") {
      if (finding.observedCommentId === undefined) {
        reject("carried finding lacks an exact prior comment identity");
      }
      required.set(finding.findingId, finding.observedCommentId);
    }
  }

  const byFinding = new Map<string, string>();
  const byComment = new Map<string, string>();
  for (const value of bindings) {
    const binding = object(value, "carried comment binding");
    const keys = Object.keys(binding).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "commentId" ||
      keys[1] !== "findingId"
    ) {
      reject("carried comment binding is not normalized");
    }
    const findingId = text(binding.findingId, "carried finding identity");
    const commentId = remoteId(binding.commentId, "carried comment identity");
    const existingComment = byFinding.get(findingId);
    if (existingComment !== undefined) {
      if (existingComment === commentId) {
        reject("carried comment binding is duplicated");
      }
      reject("carried comment binding conflicts for one finding");
    }
    const existingFinding = byComment.get(commentId);
    if (existingFinding !== undefined) {
      reject("one carried comment identity is assigned to multiple findings");
    }
    byFinding.set(findingId, commentId);
    byComment.set(commentId, findingId);
  }

  for (const [findingId, expectedCommentId] of required) {
    const actualCommentId = byFinding.get(findingId);
    if (actualCommentId === undefined) {
      reject("carried finding lacks exact durable comment binding evidence");
    }
    if (actualCommentId !== expectedCommentId) {
      reject("carried comment binding conflicts with the sealed lifecycle identity");
    }
  }
  for (const findingId of byFinding.keys()) {
    if (!required.has(findingId)) {
      reject("carried comment binding is extraneous");
    }
  }
  return byFinding;
}

function addFindingComment(
  commentsByFinding: Map<
    string,
    { outcome: "inline" | "fileComment"; commentId: string }
  >,
  findingByComment: Map<string, string>,
  findingId: string,
  outcome: "inline" | "fileComment",
  commentId: string,
): void {
  const existingFinding = findingByComment.get(commentId);
  if (existingFinding !== undefined && existingFinding !== findingId) {
    reject("one remote comment identity is assigned to multiple findings");
  }
  const existing = commentsByFinding.get(findingId);
  if (
    existing !== undefined &&
    (existing.commentId !== commentId || existing.outcome !== outcome)
  ) {
    reject("one finding has contradictory remote comment evidence");
  }
  findingByComment.set(commentId, findingId);
  commentsByFinding.set(findingId, { outcome, commentId });
}

function semanticPlacementRejection(
  operation: GitHubPublicationReceiptOperationSnapshot,
  terminal: TerminalEvidence,
): boolean {
  return operation.kind === "reviewCreate" && semanticPlacementRejectionRecord(terminal);
}

function semanticPlacementRejectionRecord(terminal: TerminalEvidence): boolean {
  return terminal.state === "failed" &&
    terminal.outcome === "rejected" &&
    terminal.httpStatus === 422 &&
    terminal.classification === "invalidReviewCommentPlacement" &&
    terminal.result.httpStatus === 422 &&
    terminal.result.classification === "invalidReviewCommentPlacement" &&
    terminal.remoteId === undefined;
}

function activationConditions(operation: JsonObject): JsonObject[] {
  const activation = object(operation.activation, "operation activation");
  return objectArray(activation.anyOf, "operation activation conditions");
}

function activationVariantAllowed(
  operation: JsonObject,
  activationVariant: string,
): boolean {
  const variants = new Set<string>();
  for (const condition of activationConditions(operation)) {
    switch (condition.condition) {
      case "always":
        variants.add("always");
        break;
      case "markerAbsent":
        variants.add("marker-absent");
        break;
      case "semanticPlacementRejected":
        variants.add("semantic-422-fallback");
        break;
      case "partialReviewObserved":
        variants.add("partial-review-fallback");
        variants.add("partial-review-marker-present");
        break;
      case "findingContentDiffers":
        variants.add("finding-content-differs");
        variants.add("content-already-exact");
        break;
      case "reviewSelectionTerminal":
        variants.add("review-selection-terminal");
        break;
      case "allDependenciesTerminal":
        variants.add("all-dependencies-terminal");
        if (operation.kind === "gateCheckComplete") {
          variants.add("all-dependencies-terminal:publication-success");
          variants.add("all-dependencies-terminal:publication-failure");
        }
        break;
      default:
        break;
    }
  }
  if (
    activationVariant === "reconciled-existing" ||
    activationVariant === "not-required" ||
    activationVariant === "not-activated" ||
    activationVariant === "retry-reconciled" ||
    activationVariant === "ambiguity-reconciliation"
  ) {
    return true;
  }
  return variants.has(activationVariant);
}

function requirePhase(
  phases: ReadonlyMap<AttemptPhase, GitHubPublicationReceiptAttemptSnapshot>,
  phase: AttemptPhase,
  noLaterThan: Date,
): void {
  const evidence = phases.get(phase);
  if (evidence === undefined || evidence.observedAt.getTime() > noLaterThan.getTime()) {
    reject(`terminal evidence lacks a preceding ${phase} phase`);
  }
}

function requireExactPhases(
  phases: ReadonlyMap<AttemptPhase, GitHubPublicationReceiptAttemptSnapshot>,
  expected: readonly AttemptPhase[],
): void {
  const accepted = new Set(expected);
  if (
    phases.size !== accepted.size ||
    [...phases.keys()].some((phase) => !accepted.has(phase))
  ) {
    reject("terminal operation carries contradictory attempt phases");
  }
}

function evidenceTimestamp(value: unknown, databaseObservedAt: Date): Date {
  if (!validDate(databaseObservedAt) || typeof value !== "string") {
    reject("terminal evidence timestamp is invalid");
  }
  const timestamp = new Date(value);
  if (
    !validDate(timestamp) ||
    Math.abs(timestamp.getTime() - databaseObservedAt.getTime()) > MAX_CLOCK_SKEW_MS
  ) {
    reject("terminal evidence timestamp is stale or contradictory");
  }
  return databaseObservedAt;
}

function terminalOutcome(value: unknown): TerminalEvidence["outcome"] {
  if (
    value !== "created" &&
    value !== "reconciledExisting" &&
    value !== "partialObserved" &&
    value !== "applied" &&
    value !== "notRequiredMarkerPresent" &&
    value !== "notRequiredContentExact" &&
    value !== "rejected"
  ) {
    reject("terminal evidence outcome is invalid");
  }
  return value;
}

function optionalRemoteId(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : remoteId(value, name);
}

function remoteId(value: unknown, name: string): string {
  const identity = text(value, name);
  if (!DECIMAL_IDENTIFIER.test(identity) || BigInt(identity) > MAX_SIGNED_INT64) {
    reject(`${name} is malformed`);
  }
  return identity;
}

function operationDesired(operation: JsonObject): JsonObject {
  const {
    ordinal: _ordinal,
    operationKey: _operationKey,
    dependencies: _dependencies,
    activation: _activation,
    reconciliation: _reconciliation,
    desiredDigest: _desiredDigest,
    ...desired
  } = operation;
  return desired;
}

function groupBy<T, K>(values: readonly T[], key: (value: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const value of values) {
    const identity = key(value);
    const entries = grouped.get(identity) ?? [];
    entries.push(value);
    grouped.set(identity, entries);
  }
  return grouped;
}

function withoutKey(value: JsonObject, key: string): JsonObject {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

function decodeJson(bytes: Uint8Array, name: string): unknown {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject(`${name} is not valid UTF-8`);
  }
  try {
    return JSON.parse(source);
  } catch {
    reject(`${name} is not valid JSON`);
  }
}

function bytesText(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject(`${name} is not valid UTF-8`);
  }
}

function boundedBytes(bytes: Uint8Array, name: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
    reject(`${name} exceeds its byte bound`);
  }
}

function object(value: unknown, name: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${name} must be an object`);
  }
  return value as JsonObject;
}

function objectArray(value: unknown, name: string): JsonObject[] {
  if (!Array.isArray(value)) reject(`${name} must be an array`);
  if (value.length > MAX_JSON_NODES) reject(`${name} exceeds its bound`);
  return value.map((entry) => object(entry, name));
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    reject(`${name} must contain strings`);
  }
  if (value.length > MAX_JSON_NODES) reject(`${name} exceeds its bound`);
  return value.map((entry) => text(entry, name));
}

function text(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES
  ) {
    reject(`${name} is malformed`);
  }
  return value;
}

function contentString(value: unknown, name: string, maximum = 128 * 1024): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    reject(`${name} is malformed`);
  }
  return value;
}

function requireKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    reject(`${name} is not normalized`);
  }
}

function decimal(value: bigint | number | string, name: string): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    reject(`${name} is malformed`);
  }
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!DECIMAL_IDENTIFIER.test(normalized) || BigInt(normalized) > MAX_SIGNED_INT64) {
    reject(`${name} is malformed`);
  }
  return normalized;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 2_147_483_647) {
    reject(`${name} is malformed`);
  }
  return value as number;
}

function rawDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !RAW_SHA256.test(value)) {
    reject(`${name} is malformed`);
  }
  return value;
}

function prefixedDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !PREFIXED_SHA256.test(value)) {
    reject(`${name} is malformed`);
  }
  return value;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

interface JsonWalkState {
  depth: number;
  nodes: number;
}

function canonicalJson(
  value: unknown,
  state: JsonWalkState = { depth: 0, nodes: 0 },
): string {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) {
    reject("publication evidence JSON exceeds its node bound");
  }
  if (state.depth > MAX_JSON_DEPTH) {
    reject("publication evidence JSON exceeds its depth bound");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("publication evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    state.depth += 1;
    const result = `[${value.map((entry) => canonicalJson(entry, state)).join(",")}]`;
    state.depth -= 1;
    return result;
  }
  const record = object(value, "JSON value");
  state.depth += 1;
  const result = `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], state)}`)
    .join(",")}}`;
  state.depth -= 1;
  return result;
}

function digestRaw(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestPrefixed(bytes: Uint8Array): string {
  return `sha256:${digestRaw(bytes)}`;
}

function reject(reason: string, cause?: unknown): never {
  throw new GitHubPublicationReceiptDerivationError(
    reason,
    cause === undefined ? undefined : { cause },
  );
}
