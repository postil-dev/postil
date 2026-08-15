import { createHash } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { GitHubPublicationControllerManifest } from "@/lib/github-publication-controller-manifest";
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

export interface GitHubPublicationReceiptEvidenceSnapshot {
  generation: GitHubPublicationReceiptGenerationSnapshot;
  operations: GitHubPublicationReceiptOperationSnapshot[];
  attempts: GitHubPublicationReceiptAttemptSnapshot[];
  reconciliations: GitHubPublicationReceiptReconciliationSnapshot[];
}

export interface LoadGitHubPublicationReceiptInput {
  database: Pick<Pool, "connect">;
  repositoryId: bigint | number | string;
  pullRequestNumber: number;
  publicationGeneration: bigint | number | string;
  reviewId: bigint | number | string;
  acceptedInputIdentity: string;
}

export class GitHubPublicationReceiptDerivationError extends Error {
  override name = "GitHubPublicationReceiptDerivationError";

  constructor(reason: string, options?: ErrorOptions) {
    super(`GitHub publication receipt derivation rejected: ${reason}`, options);
  }
}

interface GenerationRow extends QueryResultRow {
  database_repository_id: string;
  github_repository_id: string;
  repository_full_name: string;
  pr_number: number;
  publication_generation: string;
  review_id: string;
  accepted_review_id: string;
  accepted_input_digest: string;
  high_water_input_digest: string;
  head_sha: string;
  high_water_head_sha: string;
  base_sha: string;
  target_sha: string;
  pull_request_title: string;
  pull_request_body: string;
  accepted_plan_bytes: Buffer;
  accepted_plan_digest: string;
  plan_semantic_digest: string;
  operation_count: number;
  operation_manifest_digest: string;
  controller_operation_count: number;
  controller_operation_manifest_digest: string;
  controller_manifest_bytes: Buffer;
  controller_manifest_digest: string;
  sealed_at: Date | null;
}

interface OperationRow extends QueryResultRow {
  operation_key: string;
  operation_ordinal: number;
  operation_source: "cli" | "service";
  kind: string;
  controller_record: JsonObject;
  controller_record_bytes: Buffer;
  operation_record: JsonObject;
  operation_record_bytes: Buffer;
  activation: JsonObject;
  activation_bytes: Buffer;
  desired_payload: JsonObject;
  desired_payload_bytes: Buffer;
  desired_payload_digest: string;
  state: OperationState;
  attempt_count: number;
  lease_generation: string;
  selected_variant: string | null;
  terminal_evidence: JsonObject | null;
  updated_at: Date;
}

interface AttemptRow extends QueryResultRow {
  operation_key: string;
  attempt_number: number;
  lease_generation: string;
  phase: AttemptPhase;
  selected_variant: string;
  evidence_payload: JsonObject | null;
  remote_identity: string | null;
  remote_operation_id: string | null;
  observed_at: Date;
}

interface ReconciliationRow extends QueryResultRow {
  operation_key: string;
  attempt_number: number;
  lease_generation: string;
  phase: "retry" | "terminal";
  selected_variant: string;
  outcome: "exact_absence" | "applied";
  evidence_payload: JsonObject;
  remote_identity: string | null;
  remote_operation_id: string | null;
  observed_at: Date;
}

interface ValidatedArtifacts {
  plan: GitHubPublicationPlan;
  manifest: GitHubPublicationControllerManifest;
  operationsByKey: Map<string, GitHubPublicationReceiptOperationSnapshot>;
  requiredCliOperationKeys: Set<string>;
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

/** Load one locked current generation and derive its receipt before releasing high-water. */
export async function loadAndDeriveGitHubPublicationReceipt(
  input: LoadGitHubPublicationReceiptInput,
): Promise<PublicationReceipt> {
  const repositoryId = decimal(input.repositoryId, "database repository identity");
  const pullRequestNumber = positiveInteger(
    input.pullRequestNumber,
    "pull request identity",
  );
  const publicationGeneration = decimal(
    input.publicationGeneration,
    "publication generation",
  );
  const reviewId = decimal(input.reviewId, "review identity");
  const acceptedInputIdentity = prefixedDigest(
    input.acceptedInputIdentity,
    "accepted input identity",
  );
  const client = await input.database.connect();
  let began = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    began = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    const generation = await loadGeneration(
      client,
      repositoryId,
      pullRequestNumber,
      publicationGeneration,
      reviewId,
      acceptedInputIdentity.slice("sha256:".length),
    );
    const operations = await loadOperations(
      client,
      repositoryId,
      pullRequestNumber,
      generation.publicationGeneration,
    );
    const attempts = await loadCurrentAttempts(
      client,
      repositoryId,
      pullRequestNumber,
      generation.publicationGeneration,
    );
    const reconciliations = await loadCurrentReconciliations(
      client,
      repositoryId,
      pullRequestNumber,
      generation.publicationGeneration,
    );
    const receipt = deriveGitHubPublicationReceipt({
      generation,
      operations,
      attempts,
      reconciliations,
    });
    await client.query("COMMIT");
    began = false;
    return receipt;
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof GitHubPublicationReceiptDerivationError) throw error;
    throw new GitHubPublicationReceiptDerivationError(
      "the PostgreSQL evidence snapshot could not be loaded",
      { cause: error },
    );
  } finally {
    (client as PoolClient).release();
  }
}

/** Derive one receipt without performing a GitHub mutation or database write. */
export function deriveGitHubPublicationReceipt(
  snapshot: GitHubPublicationReceiptEvidenceSnapshot,
): PublicationReceipt {
  const artifacts = validateArtifacts(snapshot);
  const terminals = validateRequiredTerminalEvidence(snapshot, artifacts);
  validateTerminalOperationSemantics(artifacts, terminals);
  return materializeReceipt(artifacts, terminals);
}

async function loadGeneration(
  client: PoolClient,
  repositoryId: string,
  pullRequestNumber: number,
  publicationGeneration: string,
  reviewId: string,
  acceptedInputDigest: string,
): Promise<GitHubPublicationReceiptGenerationSnapshot> {
  const result = await client.query<GenerationRow>(
    `SELECT high_water.repository_id::text AS database_repository_id,
            repository.github_repo_id::text AS github_repository_id,
            generation.repository_full_name, high_water.pr_number,
            high_water.publication_generation::text AS publication_generation,
            generation.review_id::text AS review_id,
            high_water.accepted_review_id::text AS accepted_review_id,
            generation.accepted_input_digest,
            high_water.accepted_input_digest AS high_water_input_digest,
            generation.head_sha, high_water.accepted_head_sha AS high_water_head_sha,
            generation.base_sha, generation.target_sha,
            generation.pull_request_title, generation.pull_request_body,
            generation.accepted_plan_bytes, generation.accepted_plan_digest,
            generation.plan_semantic_digest, generation.operation_count,
            generation.operation_manifest_digest,
            generation.controller_operation_count,
            generation.controller_operation_manifest_digest,
            generation.controller_manifest_bytes,
            generation.controller_manifest_digest, generation.sealed_at
       FROM pull_request_publication_high_waters high_water
       JOIN review_publication_generations generation
         ON generation.repository_id = high_water.repository_id
        AND generation.pr_number = high_water.pr_number
        AND generation.publication_generation = high_water.publication_generation
       JOIN repositories repository ON repository.id = high_water.repository_id
      WHERE high_water.repository_id = $1::bigint
        AND high_water.pr_number = $2
        AND high_water.publication_generation = $3::bigint
        AND high_water.accepted_review_id = $4::bigint
        AND high_water.accepted_input_digest = $5
      FOR SHARE OF high_water, generation, repository`,
    [
      repositoryId,
      pullRequestNumber,
      publicationGeneration,
      reviewId,
      acceptedInputDigest,
    ],
  );
  const row = result.rows[0];
  if (row === undefined || result.rows.length !== 1) {
    reject("the continuation no longer owns the current publication generation");
  }
  return {
    databaseRepositoryId: row.database_repository_id,
    githubRepositoryId: row.github_repository_id,
    repositoryFullName: row.repository_full_name,
    pullRequestNumber: row.pr_number,
    publicationGeneration: row.publication_generation,
    reviewId: row.review_id,
    acceptedReviewId: row.accepted_review_id,
    acceptedInputDigest: row.accepted_input_digest,
    highWaterInputDigest: row.high_water_input_digest,
    headSha: row.head_sha,
    highWaterHeadSha: row.high_water_head_sha,
    mergeBaseSha: row.base_sha,
    targetSha: row.target_sha,
    pullRequestTitle: row.pull_request_title,
    pullRequestBody: row.pull_request_body,
    acceptedPlanBytes: Uint8Array.from(row.accepted_plan_bytes),
    acceptedPlanDigest: row.accepted_plan_digest,
    planSemanticDigest: row.plan_semantic_digest,
    operationCount: row.operation_count,
    operationManifestDigest: row.operation_manifest_digest,
    controllerOperationCount: row.controller_operation_count,
    controllerOperationManifestDigest:
      row.controller_operation_manifest_digest,
    controllerManifestBytes: Uint8Array.from(row.controller_manifest_bytes),
    controllerManifestDigest: row.controller_manifest_digest,
    sealedAt: row.sealed_at,
  };
}

async function loadOperations(
  client: PoolClient,
  repositoryId: string,
  pullRequestNumber: number,
  generation: string,
): Promise<GitHubPublicationReceiptOperationSnapshot[]> {
  const result = await client.query<OperationRow>(
    `SELECT operation_key, operation_ordinal, operation_source, kind,
            controller_record, controller_record_bytes, operation_record,
            operation_record_bytes, activation, activation_bytes,
            desired_payload, desired_payload_bytes, desired_payload_digest,
            state, attempt_count, lease_generation::text AS lease_generation,
            selected_variant, terminal_evidence, updated_at
       FROM review_publication_operations
      WHERE repository_id = $1::bigint AND pr_number = $2
        AND publication_generation = $3::bigint
      ORDER BY operation_ordinal
      LIMIT ${MAX_OPERATIONS + 1}
      FOR SHARE`,
    [repositoryId, pullRequestNumber, generation],
  );
  if (result.rows.length > MAX_OPERATIONS) {
    reject("the current generation exceeds the operation bound");
  }
  return result.rows.map((row) => ({
    operationKey: row.operation_key,
    operationOrdinal: row.operation_ordinal,
    operationSource: row.operation_source,
    kind: row.kind,
    controllerRecord: row.controller_record,
    controllerRecordBytes: Uint8Array.from(row.controller_record_bytes),
    operationRecord: row.operation_record,
    operationRecordBytes: Uint8Array.from(row.operation_record_bytes),
    activation: row.activation,
    activationBytes: Uint8Array.from(row.activation_bytes),
    desiredPayload: row.desired_payload,
    desiredPayloadBytes: Uint8Array.from(row.desired_payload_bytes),
    desiredPayloadDigest: row.desired_payload_digest,
    state: row.state,
    attemptCount: row.attempt_count,
    leaseGeneration: row.lease_generation,
    selectedVariant: row.selected_variant,
    terminalEvidence: row.terminal_evidence,
    updatedAt: row.updated_at,
  }));
}

async function loadCurrentAttempts(
  client: PoolClient,
  repositoryId: string,
  pullRequestNumber: number,
  generation: string,
): Promise<GitHubPublicationReceiptAttemptSnapshot[]> {
  const result = await client.query<AttemptRow>(
    `SELECT attempt.operation_key, attempt.attempt_number,
            attempt.lease_generation::text AS lease_generation,
            attempt.phase, attempt.selected_variant, attempt.evidence_payload,
            attempt.remote_identity, attempt.remote_operation_id,
            attempt.observed_at
       FROM review_publication_operation_attempts attempt
       JOIN review_publication_operations operation
         ON operation.repository_id = attempt.repository_id
        AND operation.pr_number = attempt.pr_number
        AND operation.publication_generation = attempt.publication_generation
        AND operation.operation_key = attempt.operation_key
        AND operation.attempt_count = attempt.attempt_number
        AND operation.lease_generation = attempt.lease_generation
      WHERE attempt.repository_id = $1::bigint AND attempt.pr_number = $2
        AND attempt.publication_generation = $3::bigint
      ORDER BY attempt.operation_key, attempt.observed_at, attempt.id
      LIMIT ${MAX_CURRENT_ATTEMPTS + 1}`,
    [repositoryId, pullRequestNumber, generation],
  );
  if (result.rows.length > MAX_CURRENT_ATTEMPTS) {
    reject("the current operation evidence exceeds the attempt bound");
  }
  return result.rows.map((row) => ({
    operationKey: row.operation_key,
    attemptNumber: row.attempt_number,
    leaseGeneration: row.lease_generation,
    phase: row.phase,
    selectedVariant: row.selected_variant,
    evidencePayload: row.evidence_payload,
    remoteIdentity: row.remote_identity,
    remoteOperationId: row.remote_operation_id,
    observedAt: row.observed_at,
  }));
}

async function loadCurrentReconciliations(
  client: PoolClient,
  repositoryId: string,
  pullRequestNumber: number,
  generation: string,
): Promise<GitHubPublicationReceiptReconciliationSnapshot[]> {
  const result = await client.query<ReconciliationRow>(
    `SELECT reconciliation.operation_key, reconciliation.attempt_number,
            reconciliation.lease_generation::text AS lease_generation,
            reconciliation.phase, reconciliation.selected_variant,
            reconciliation.outcome, reconciliation.evidence_payload,
            reconciliation.remote_identity,
            reconciliation.remote_operation_id,
            reconciliation.observed_at
       FROM review_publication_operation_reconciliations reconciliation
       JOIN review_publication_operations operation
         ON operation.repository_id = reconciliation.repository_id
        AND operation.pr_number = reconciliation.pr_number
        AND operation.publication_generation = reconciliation.publication_generation
        AND operation.operation_key = reconciliation.operation_key
        AND operation.attempt_count = reconciliation.attempt_number
        AND operation.lease_generation = reconciliation.lease_generation
      WHERE reconciliation.repository_id = $1::bigint
        AND reconciliation.pr_number = $2
        AND reconciliation.publication_generation = $3::bigint
      ORDER BY reconciliation.operation_key
      LIMIT ${MAX_CURRENT_RECONCILIATIONS + 1}`,
    [repositoryId, pullRequestNumber, generation],
  );
  if (result.rows.length > MAX_CURRENT_RECONCILIATIONS) {
    reject("the current operation evidence exceeds the reconciliation bound");
  }
  return result.rows.map((row) => ({
    operationKey: row.operation_key,
    attemptNumber: row.attempt_number,
    leaseGeneration: row.lease_generation,
    phase: row.phase,
    selectedVariant: row.selected_variant,
    outcome: row.outcome,
    evidencePayload: row.evidence_payload,
    remoteIdentity: row.remote_identity,
    remoteOperationId: row.remote_operation_id,
    observedAt: row.observed_at,
  }));
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
  const operationsByKey = new Map<string, GitHubPublicationReceiptOperationSnapshot>();
  let aggregateArtifactBytes = 0;
  for (const [index, operation] of snapshot.operations.entries()) {
    validateOperationRecord(operation, manifest, plan, index);
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

function validateOperationRecord(
  row: GitHubPublicationReceiptOperationSnapshot,
  manifest: GitHubPublicationControllerManifest,
  plan: GitHubPublicationPlan,
  index: number,
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
  if (
    (expectedSource !== "cli" && expectedSource !== "service") ||
    row.operationSource !== expectedSource ||
    !jsonEqual(row.controllerRecord, expectedController) ||
    !jsonEqual(row.operationRecord, expectedOperation)
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
  if (
    !jsonEqual(
      decodeJson(row.operationRecordBytes, "operation record"),
      expectedOperation,
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
  const desired = operationDesired(expectedOperation);
  if (!jsonEqual(row.desiredPayload, desired)) {
    reject("operation desired payload drifted from its sealed record");
  }
  if (
    row.desiredPayloadDigest !== expectedOperation.desiredDigest ||
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
    !jsonEqual(row.activation, expectedOperation.activation)
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
  const gateCompletion = manifest.operations
    .map((record) => object(record.operation, "controller operation"))
    .filter((operation) => operation.kind === "gateCheckComplete");
  if (gateCompletion.length !== 1) {
    reject("controller manifest does not contain one gate completion");
  }
  const completion = gateCompletion[0]!;
  const remoteReference = object(completion.remoteId, "gate remote identity");
  const gateCreateKey = text(remoteReference.operationKey, "gate creation dependency");
  const roots = stringArray(completion.dependencies, "gate completion dependencies").filter(
    (key) => key !== gateCreateKey,
  );
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
    (operation.selectedVariant !== null &&
      evidenceVariant !== operation.selectedVariant)
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
    if (operation.selectedVariant === null || operation.terminalEvidence === null) {
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
  evidenceTimestamp(payload.observedAt, row.observedAt);
}

function validateTerminalOperationSemantics(
  artifacts: ValidatedArtifacts,
  terminals: ReadonlyMap<string, TerminalEvidence>,
): void {
  for (const operationKey of artifacts.requiredCliOperationKeys) {
    const operation = artifacts.operationsByKey.get(operationKey)!;
    const terminal = terminals.get(operationKey)!;
    const record = operation.operationRecord;
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

    switch (operation.kind) {
      case "reviewCreate":
        validateReviewTerminal(operation, terminal);
        break;
      case "fileCommentFallback":
        validateRemoteTerminal(operation, terminal, "commentId", [
          "created",
          "reconciledExisting",
        ]);
        break;
      case "findingCommentUpdate":
        validateRemoteTerminal(operation, terminal, "commentId", [
          "applied",
          "reconciledExisting",
          "notRequiredContentExact",
        ]);
        break;
      case "reviewSummaryUpdate":
        validateRemoteTerminal(operation, terminal, "reviewId", [
          "applied",
          "reconciledExisting",
          "notRequiredContentExact",
        ]);
        break;
      case "advisoryCheckCreate":
        validateRemoteTerminal(operation, terminal, "checkRunId", [
          "created",
          "reconciledExisting",
        ]);
        break;
      case "advisoryCheckComplete":
        validateRemoteTerminal(operation, terminal, "checkRunId", ["applied"]);
        if (terminal.result.conclusion !== record.conclusion) {
          reject("advisory check completion evidence has the wrong conclusion");
        }
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
  operation: GitHubPublicationReceiptOperationSnapshot,
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
}

function validateRemoteTerminal(
  operation: GitHubPublicationReceiptOperationSnapshot,
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

function materializeReceipt(
  artifacts: ValidatedArtifacts,
  terminals: ReadonlyMap<string, TerminalEvidence>,
): PublicationReceipt {
  const lifecycle = artifacts.plan.lifecycleReceipt;
  const findingByMarker = new Map(
    lifecycle.findings.map((finding) => [finding.marker, finding]),
  );
  if (findingByMarker.size !== lifecycle.findings.length) {
    reject("lifecycle finding marker is duplicated");
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
    if (operation.kind === "fileCommentFallback" && terminal.remoteId !== undefined) {
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
    (commentsByFinding.size > 0 || reviewCandidates.length > 0)
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
        (missingMarkers.has(finding.marker) ||
          semanticRejectedMarkers.has(finding.marker));
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

    if (
      finding.initialOutcome !== "checkAnnotation" &&
      finding.initialOutcome !== "summaryOnly" &&
      finding.initialOutcome !== "carried" &&
      finding.initialOutcome !== "resolved" &&
      finding.initialOutcome !== "suppressed" &&
      finding.initialOutcome !== "unknown"
    ) {
      reject("lifecycle finding has an unsupported final classification");
    }
    if (
      lifecycle.channel === "reviewComments" &&
      finding.initialOutcome === "summaryOnly" &&
      !summaryCarrier
    ) {
      reject("summary-only finding lacks exact review summary evidence");
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
  if (selectedReview?.operation.attempt === "summaryOnly") return true;
  return plan.operations.some((operation) => {
    if (operation.kind !== "reviewSummaryUpdate") return false;
    const terminal = terminals.get(operation.operationKey)!;
    return terminal.remoteId !== undefined &&
      (terminal.state === "applied" || terminal.state === "skipped");
  }) || (selectedReview !== undefined && selectedReview.operation.payload.body.length > 0);
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
    terminal.remoteId === undefined;
}

function activationConditions(operation: JsonObject): JsonObject[] {
  const activation = object(operation.activation, "operation activation");
  return objectArray(activation.anyOf, "operation activation conditions");
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
  if (!DECIMAL_IDENTIFIER.test(identity)) reject(`${name} is malformed`);
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
  return value.map((entry) => object(entry, name));
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    reject(`${name} must contain strings`);
  }
  return [...value] as string[];
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    reject(`${name} is malformed`);
  }
  return value;
}

function decimal(value: bigint | number | string, name: string): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    reject(`${name} is malformed`);
  }
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!DECIMAL_IDENTIFIER.test(normalized) || BigInt(normalized) > 9_223_372_036_854_775_807n) {
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("publication evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = object(value, "JSON value");
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
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
