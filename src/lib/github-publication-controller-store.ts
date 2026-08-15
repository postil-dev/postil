import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  BuiltGitHubPublicationControllerManifest,
  GitHubPublicationControllerManifest,
} from "@/lib/github-publication-controller-manifest";
import {
  buildGitHubPublicationInputIdentity,
  type BuiltGitHubPublicationInputIdentity,
} from "@/lib/github-publication-cli-planner";
import {
  type AcceptedGitHubPublicationPlan,
  parseGitHubPublicationPlanBytes,
} from "@/lib/github-publication-plan";

const SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const DECIMAL_IDENTIFIER = /^[1-9][0-9]{0,18}$/;
const MAX_OPERATION_BYTES = 4 * 1024 * 1024;
const MAX_DEPENDENCY_EDGES = 1_024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
// PR title and body content is represented by digests in this bounded artifact.
const MAX_INPUT_ARTIFACT_BYTES = 16 * 1024;

type TransactionClient = Pick<PoolClient, "query">;
export interface PublicationControllerGenerationSnapshot {
  /** Internal database repository identity. */
  repositoryId: bigint | number | string;
  /** Immutable GitHub repository identity expected from the CLI. */
  githubRepositoryId: bigint | number | string;
  reviewId: bigint | number | string;
  reviewInputSequence: bigint | number | string;
  expectedPullRequestUpdatedAt: string;
  envelopeDigest: string;
  targetBranch: string;
  pullRequestTitle: string;
  pullRequestBody: string;
}

export interface GitHubPublicationControllerGenerationInput {
  acceptedInput: BuiltGitHubPublicationInputIdentity;
  acceptedPlan: AcceptedGitHubPublicationPlan;
  controllerManifest: BuiltGitHubPublicationControllerManifest;
  snapshot: PublicationControllerGenerationSnapshot;
}

export interface StageGitHubPublicationControllerGenerationInput
  extends GitHubPublicationControllerGenerationInput {
  database: Pick<Pool, "connect">;
}

export interface StagedGitHubPublicationControllerGeneration {
  generationId: bigint;
  repositoryId: bigint;
  pullRequestNumber: number;
  publicationGeneration: bigint;
  reviewId: bigint;
  acceptedPlanDigest: string;
  controllerManifestDigest: string;
  sealedAt: Date;
  status: "sealed";
  idempotent: boolean;
}

export class GitHubPublicationControllerStoreRejectedError extends Error {
  override name = "GitHubPublicationControllerStoreRejectedError";

  constructor(reason: string, options?: ErrorOptions) {
    super(`GitHub publication controller staging rejected: ${reason}`, options);
  }
}

interface ValidatedStage {
  acceptedInput: BuiltGitHubPublicationInputIdentity;
  acceptedPlan: AcceptedGitHubPublicationPlan;
  manifest: BuiltGitHubPublicationControllerManifest;
  repositoryId: string;
  githubRepositoryId: string;
  prNumber: number;
  publicationGeneration: string;
  reviewId: string;
  reviewInputSequence: string;
  expectedPullRequestUpdatedAt: string;
  envelopeDigest: string;
  targetBranch: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  planVersion: string;
  acceptedInputDigest: string;
  planSemanticDigest: string;
  controllerManifestDigest: string;
  operations: StagedOperation[];
}

interface StagedOperation {
  ordinal: number;
  source: "cli" | "service";
  controllerRecord: Record<string, unknown>;
  controllerRecordBytes: Buffer;
  operation: Record<string, unknown>;
  operationBytes: Buffer;
  operationKey: string;
  dependencies: string[];
  activation: Record<string, unknown>;
  activationBytes: Buffer;
  kind: string;
  desiredPayload: Record<string, unknown>;
  desiredPayloadBytes: Buffer;
  desiredPayloadDigest: string;
}

interface ExistingGenerationRow {
  id: string;
  repository_id: string;
  pr_number: number;
  publication_generation: string;
  review_id: string;
  accepted_plan_digest: string;
  accepted_plan_bytes: Buffer;
  plan_semantic_digest: string;
  review_input_sequence: string;
  expected_pull_request_updated_at: Date;
  accepted_input_bytes: Buffer;
  accepted_input_digest: string;
  envelope_digest: string;
  head_sha: string;
  base_sha: string;
  target_sha: string;
  target_branch: string;
  operation_count: number;
  operation_manifest_digest: string;
  controller_operation_count: number;
  controller_operation_manifest_digest: string;
  controller_manifest_digest: string;
  controller_manifest_bytes: Buffer;
  sealed_at: Date | null;
}

interface ReviewRepositoryRow {
  repository_id: string;
  github_repo_id: string;
  full_name: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  status: string;
}

/**
 * Stages an immutable accepted CLI plan and service controller manifest, then
 * advances high-water as the final write that asks the database to seal it.
 */
export async function stageGitHubPublicationControllerGeneration(
  input: StageGitHubPublicationControllerGenerationInput,
): Promise<StagedGitHubPublicationControllerGeneration> {
  const client = await input.database.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await stageGitHubPublicationControllerGenerationInTransaction(
      client,
      input,
    );
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof GitHubPublicationControllerStoreRejectedError) throw error;
    throw new GitHubPublicationControllerStoreRejectedError(
      "the database transaction could not stage the generation",
      { cause: error },
    );
  } finally {
    client.release();
  }
}

/** Stage and seal one generation inside an existing PostgreSQL transaction. */
export async function stageGitHubPublicationControllerGenerationInTransaction(
  client: TransactionClient,
  input: GitHubPublicationControllerGenerationInput,
): Promise<StagedGitHubPublicationControllerGeneration> {
  const staged = validateStageInput(input);
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${staged.repositoryId}:${staged.prNumber}`,
    ]);

    const reviewRepository = await client.query<ReviewRepositoryRow>(
      `SELECT review.repository_id, repository.github_repo_id, repository.full_name,
              review.pr_number, review.head_sha, review.base_sha, review.status
         FROM reviews review
         JOIN repositories repository ON repository.id = review.repository_id
        WHERE review.id = $1
        FOR SHARE OF review, repository`,
      [staged.reviewId],
    );
    if (!exactReviewRepositoryMatches(reviewRepository.rows[0], staged)) {
      reject("the review and repository no longer match the accepted plan");
    }

    const existing = await client.query<ExistingGenerationRow>(
      `SELECT id, repository_id, pr_number, publication_generation, review_id,
              accepted_plan_digest, accepted_plan_bytes, plan_semantic_digest, review_input_sequence,
              expected_pull_request_updated_at, accepted_input_bytes, accepted_input_digest,
              envelope_digest,
              head_sha, base_sha, target_sha, target_branch, operation_count,
              operation_manifest_digest, controller_operation_count,
              controller_operation_manifest_digest, controller_manifest_digest,
              controller_manifest_bytes, sealed_at
       FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2
       ORDER BY publication_generation DESC
       LIMIT 1
       FOR UPDATE`,
      [staged.repositoryId, staged.prNumber],
    );
    const current = existing.rows[0];
    if (current !== undefined) {
      const comparison = BigInt(current.publication_generation) - BigInt(staged.publicationGeneration);
      if (comparison > 0n) reject("a later publication generation already exists");
      if (comparison === 0n) {
        if (!isExactSealedReplay(current, staged)) {
          reject(current.sealed_at === null
            ? "the requested publication generation is already being staged"
            : "the requested publication generation has a different immutable identity");
        }
        return resultFromExisting(current, true);
      }
    }

    await client.query(
      `INSERT INTO review_publication_generations
         (repository_id, pr_number, publication_generation, review_id, plan_version,
          accepted_plan, accepted_plan_bytes, accepted_plan_digest, plan_semantic_digest,
          review_input_sequence, expected_pull_request_updated_at, accepted_input,
          accepted_input_bytes, accepted_input_digest, envelope_digest, repository_full_name,
          head_sha, base_sha, target_sha,
          target_branch, pull_request_title, pull_request_body, operation_count,
          operation_manifest_digest, controller_operation_count,
          controller_operation_manifest_digest, controller_manifest,
          controller_manifest_bytes, controller_manifest_digest)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb,
               $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
               $26, $27::jsonb, $28, $29)`,
      [
        staged.repositoryId,
        staged.prNumber,
        staged.publicationGeneration,
        staged.reviewId,
        staged.planVersion,
        JSON.stringify(staged.acceptedPlan.value),
        Buffer.from(staged.acceptedPlan.bytes),
        staged.acceptedPlan.digest,
        staged.planSemanticDigest,
        staged.reviewInputSequence,
        staged.expectedPullRequestUpdatedAt,
        JSON.stringify(staged.acceptedInput.value),
        Buffer.from(staged.acceptedInput.bytes),
        staged.acceptedInputDigest,
        staged.envelopeDigest,
        staged.acceptedPlan.value.repository.fullName,
        staged.acceptedPlan.value.reviewedSnapshot.headSha,
        staged.acceptedPlan.value.reviewedSnapshot.mergeBaseSha,
        staged.acceptedPlan.value.reviewedSnapshot.targetSha,
        staged.targetBranch,
        staged.pullRequestTitle,
        staged.pullRequestBody,
        staged.acceptedPlan.value.operationCount,
        staged.acceptedPlan.value.operationManifestDigest,
        staged.manifest.value.operationCount,
        staged.manifest.value.operationManifestDigest,
        JSON.stringify(staged.manifest.value),
        Buffer.from(staged.manifest.bytes),
        staged.controllerManifestDigest,
      ],
    );

    for (const operation of staged.operations) {
      await client.query(
        `INSERT INTO review_publication_operations
           (repository_id, pr_number, publication_generation, review_id,
            operation_key, operation_ordinal, operation_source, controller_record,
            controller_record_bytes, operation_record, operation_record_bytes, activation,
            activation_bytes, kind, desired_payload, desired_payload_bytes,
            desired_payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11,
                 $12::jsonb, $13, $14, $15::jsonb, $16, $17)`,
        [
          staged.repositoryId,
          staged.prNumber,
          staged.publicationGeneration,
          staged.reviewId,
          operation.operationKey,
          operation.ordinal,
          operation.source,
          JSON.stringify(operation.controllerRecord),
          operation.controllerRecordBytes,
          JSON.stringify(operation.operation),
          operation.operationBytes,
          JSON.stringify(operation.activation),
          operation.activationBytes,
          operation.kind,
          JSON.stringify(operation.desiredPayload),
          operation.desiredPayloadBytes,
          operation.desiredPayloadDigest,
        ],
      );
    }
    for (const operation of staged.operations) {
      for (const [position, dependency] of operation.dependencies.entries()) {
        await client.query(
          `INSERT INTO review_publication_operation_dependencies
             (repository_id, pr_number, publication_generation, operation_key,
              dependency_position, dependency_operation_key)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            staged.repositoryId,
            staged.prNumber,
            staged.publicationGeneration,
            operation.operationKey,
            position,
            dependency,
          ],
        );
      }
    }

    await client.query(
      `INSERT INTO pull_request_publication_high_waters
         (repository_id, pr_number, publication_generation, accepted_review_id,
          accepted_input_digest, accepted_head_sha)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (repository_id, pr_number) DO UPDATE
       SET publication_generation = EXCLUDED.publication_generation,
           accepted_review_id = EXCLUDED.accepted_review_id,
           accepted_input_digest = EXCLUDED.accepted_input_digest,
           accepted_head_sha = EXCLUDED.accepted_head_sha,
           updated_at = clock_timestamp()`,
      [
        staged.repositoryId,
        staged.prNumber,
        staged.publicationGeneration,
        staged.reviewId,
        staged.acceptedInputDigest,
        staged.acceptedPlan.value.reviewedSnapshot.headSha,
      ],
    );
    const sealed = await client.query<ExistingGenerationRow>(
      `SELECT id, repository_id, pr_number, publication_generation, review_id,
              accepted_plan_digest, accepted_plan_bytes, plan_semantic_digest, review_input_sequence,
              expected_pull_request_updated_at, accepted_input_bytes, accepted_input_digest,
              envelope_digest,
              head_sha, base_sha, target_sha, target_branch, operation_count,
              operation_manifest_digest, controller_operation_count,
              controller_operation_manifest_digest, controller_manifest_digest,
              controller_manifest_bytes, sealed_at
       FROM review_publication_generations
       WHERE repository_id = $1 AND pr_number = $2 AND publication_generation = $3
       FOR SHARE`,
      [staged.repositoryId, staged.prNumber, staged.publicationGeneration],
    );
    const row = sealed.rows[0];
    if (row === undefined || !isExactSealedReplay(row, staged)) {
      reject("database did not seal the complete immutable publication generation");
    }
    return resultFromExisting(row, false);
  } catch (error) {
    if (error instanceof GitHubPublicationControllerStoreRejectedError) throw error;
    throw new GitHubPublicationControllerStoreRejectedError(
      "the database transaction could not stage the generation",
      { cause: error },
    );
  }
}

function validateStageInput(input: GitHubPublicationControllerGenerationInput): ValidatedStage {
  const acceptedInput = input.acceptedInput;
  const plan = input.acceptedPlan;
  const manifest = input.controllerManifest;
  if (
    !acceptedInput ||
    !plan ||
    !manifest ||
    !(acceptedInput.bytes instanceof Uint8Array) ||
    !(plan.bytes instanceof Uint8Array) ||
    !(manifest.bytes instanceof Uint8Array)
  ) {
    reject("accepted artifacts are required");
  }
  const value = plan.value;
  const manifestValue = manifest.value;
  if (!value || !manifestValue || !SHA256.test(plan.digest) || !PREFIXED_SHA256.test(manifest.digest)) {
    reject("accepted artifact digests are malformed");
  }
  if (digestHex(plan.bytes) !== plan.digest || digestPrefixed(manifest.bytes) !== manifest.digest) {
    reject("accepted artifact bytes do not match their digests");
  }
  if (
    plan.bytes.byteLength < 3 ||
    plan.bytes.byteLength > MAX_ARTIFACT_BYTES ||
    manifest.bytes.byteLength < 2 ||
    manifest.bytes.byteLength > MAX_ARTIFACT_BYTES
  ) {
    reject("accepted artifact exceeds the byte limit");
  }
  if (!bytesParseAs(plan.bytes, value) || !bytesParseAs(manifest.bytes, manifestValue)) {
    reject("accepted artifact bytes do not match their values");
  }
  if (
    !Buffer.from(plan.bytes).equals(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")) ||
    !Buffer.from(manifest.bytes).equals(Buffer.from(canonicalJson(manifestValue), "utf8"))
  ) {
    reject("accepted artifact bytes are not canonical");
  }
  const repositoryId = decimal(input.snapshot.repositoryId, "database repository identity");
  const githubRepositoryId = decimal(
    input.snapshot.githubRepositoryId,
    "GitHub repository identity",
  );
  if (value.repository.id !== githubRepositoryId) {
    reject("accepted plan names a different GitHub repository");
  }
  const prNumber = positiveInteger(value.pullRequestNumber, "pull request identity");
  const publicationGeneration = decimal(value.controllerGeneration, "publication generation");
  const reviewId = decimal(input.snapshot.reviewId, "review identity");
  const reviewInputSequence = decimal(input.snapshot.reviewInputSequence, "review input sequence");
  if (reviewInputSequence !== publicationGeneration) {
    reject("publication generation differs from the review input sequence");
  }
  const envelopeDigest = rawDigest(input.snapshot.envelopeDigest, "envelope digest");
  const expectedPullRequestUpdatedAt = timestamp(input.snapshot.expectedPullRequestUpdatedAt);
  const targetBranch = boundedText(input.snapshot.targetBranch, 255, true, "target branch");
  const pullRequestTitle = boundedText(input.snapshot.pullRequestTitle, 512, true, "pull request title");
  const pullRequestBody = boundedText(input.snapshot.pullRequestBody, 65_536, false, "pull request body");
  if (
    value.reviewedSnapshot.pullRequestTitleSha256 !== digestPrefixed(Buffer.from(pullRequestTitle, "utf8"))
    || value.reviewedSnapshot.pullRequestBodySha256 !== digestPrefixed(Buffer.from(pullRequestBody, "utf8"))
  ) {
    reject("pull request snapshot text differs from the accepted plan");
  }
  const validatedInput = validateAcceptedInputArtifact(acceptedInput, {
    repositoryId,
    githubRepositoryId,
    repositoryFullName: value.repository.fullName,
    prNumber: String(prNumber),
    publicationGeneration,
    reviewId,
    headSha: value.reviewedSnapshot.headSha,
    mergeBaseSha: value.reviewedSnapshot.mergeBaseSha,
    targetSha: value.reviewedSnapshot.targetSha,
    targetBranch,
    pullRequestTitle,
    pullRequestBody,
    expectedPullRequestUpdatedAt,
  });
  let strictlyParsedPlan: AcceptedGitHubPublicationPlan["value"];
  try {
    strictlyParsedPlan = parseGitHubPublicationPlanBytes(plan.bytes, {
      controllerGeneration: value.controllerGeneration,
      inputIdentity: value.inputIdentity,
      reviewOutputDigest: value.reviewOutputDigest,
      repositoryId: githubRepositoryId,
      repositoryFullName: value.repository.fullName,
      pullRequestNumber: value.pullRequestNumber,
      headSha: value.reviewedSnapshot.headSha,
      mergeBaseSha: value.reviewedSnapshot.mergeBaseSha,
      targetSha: value.reviewedSnapshot.targetSha,
      pullRequestTitle,
      pullRequestBody,
    }).value;
  } catch {
    reject("accepted plan does not satisfy the strict CLI contract");
  }
  if (canonicalJson(strictlyParsedPlan) !== canonicalJson(value)) {
    reject("accepted plan value differs from its strict wire artifact");
  }
  if (value.inputIdentity !== validatedInput.digest) {
    reject("accepted plan input identity differs from the accepted input artifact");
  }
  const acceptedInputDigest = rawDigest(
    validatedInput.digest.slice("sha256:".length),
    "accepted input digest",
  );
  const planSemanticDigest = rawDigest(value.intentDigest.slice("sha256:".length), "plan semantic digest");
  const controllerManifestDigest = manifest.digest;

  validateManifestIdentity(value, manifestValue, plan.digest, manifest);
  const operations = stageOperations(value, manifestValue, manifest.operationBytes);
  return {
    acceptedInput: validatedInput,
    acceptedPlan: plan,
    manifest,
    repositoryId,
    githubRepositoryId,
    prNumber,
    publicationGeneration,
    reviewId,
    reviewInputSequence,
    expectedPullRequestUpdatedAt,
    envelopeDigest,
    targetBranch,
    pullRequestTitle,
    pullRequestBody,
    planVersion: `github-publication-v${value.version}`,
    acceptedInputDigest,
    planSemanticDigest,
    controllerManifestDigest,
    operations,
  };
}

function validateAcceptedInputArtifact(
  acceptedInput: BuiltGitHubPublicationInputIdentity,
  snapshot: {
    repositoryId: string;
    githubRepositoryId: string;
    repositoryFullName: string;
    prNumber: string;
    publicationGeneration: string;
    reviewId: string;
    headSha: string;
    mergeBaseSha: string;
    targetSha: string;
    targetBranch: string;
    pullRequestTitle: string;
    pullRequestBody: string;
    expectedPullRequestUpdatedAt: string;
  },
): BuiltGitHubPublicationInputIdentity {
  if (!PREFIXED_SHA256.test(acceptedInput.digest)) {
    reject("accepted input artifact digest is malformed");
  }
  if (
    acceptedInput.bytes.byteLength < 2 ||
    acceptedInput.bytes.byteLength > MAX_INPUT_ARTIFACT_BYTES
  ) {
    reject("accepted input artifact exceeds the byte limit");
  }
  if (
    digestPrefixed(acceptedInput.bytes) !== acceptedInput.digest ||
    !bytesParseAs(acceptedInput.bytes, acceptedInput.value) ||
    !Buffer.from(acceptedInput.bytes).equals(
      Buffer.from(canonicalJson(acceptedInput.value), "utf8"),
    )
  ) {
    reject("accepted input artifact bytes, value, and digest differ");
  }

  const value = object(acceptedInput.value, "accepted input artifact");
  const baseline = value.baseline === null
    ? null
    : object(value.baseline, "accepted input baseline");
  let rebuilt: BuiltGitHubPublicationInputIdentity;
  try {
    rebuilt = buildGitHubPublicationInputIdentity({
      databaseRepositoryId: snapshot.repositoryId,
      githubRepositoryId: snapshot.githubRepositoryId,
      repositoryFullName: snapshot.repositoryFullName,
      pullRequestNumber: snapshot.prNumber,
      controllerGeneration: snapshot.publicationGeneration,
      reviewId: snapshot.reviewId,
      headSha: snapshot.headSha,
      mergeBaseSha: snapshot.mergeBaseSha,
      targetSha: snapshot.targetSha,
      targetBranch: snapshot.targetBranch,
      pullRequestTitle: snapshot.pullRequestTitle,
      pullRequestBody: snapshot.pullRequestBody,
      expectedPullRequestUpdatedAt: snapshot.expectedPullRequestUpdatedAt,
      cliVersion: value.cliVersion as string,
      cliCommitSha: value.cliCommitSha as string,
      cliArtifactSha256: value.cliArtifactSha256 as string,
      configurationSha256: value.configurationSha256 as string,
      providerIdentity: value.providerIdentity as string,
      retryLineage: value.retryLineage as string,
      ...(baseline === null
        ? {}
        : {
            baselineReviewId: baseline.reviewId as string,
            baselineHeadSha: baseline.headSha as string,
            baselineEnvelopeSha256: baseline.envelopeSha256 as string,
          }),
      bounded: value.bounded as boolean,
      forceFullReview: value.forceFullReview as boolean,
      ...(value.detailsUrl === null ? {} : { detailsUrl: value.detailsUrl as string }),
    });
  } catch {
    reject("accepted input artifact does not satisfy the input identity contract");
  }
  if (
    canonicalJson(rebuilt.value) !== canonicalJson(acceptedInput.value) ||
    rebuilt.digest !== acceptedInput.digest ||
    !Buffer.from(rebuilt.bytes).equals(Buffer.from(acceptedInput.bytes))
  ) {
    reject("accepted input artifact differs from the publication snapshot");
  }
  return rebuilt;
}

function validateManifestIdentity(
  plan: AcceptedGitHubPublicationPlan["value"],
  manifest: GitHubPublicationControllerManifest,
  planDigest: string,
  built: BuiltGitHubPublicationControllerManifest,
): void {
  const exact: Array<[unknown, unknown]> = [
    [manifest.version, "github-publication-controller-v1"],
    [manifest.forge, "github"],
    [manifest.controllerGeneration, plan.controllerGeneration],
    [manifest.inputIdentity, plan.inputIdentity],
    [manifest.reviewOutputDigest, plan.reviewOutputDigest],
    [manifest.repository.id, plan.repository.id],
    [manifest.repository.fullName, plan.repository.fullName],
    [manifest.pullRequestNumber, plan.pullRequestNumber],
    [manifest.headSha, plan.reviewedSnapshot.headSha],
    [manifest.acceptedPlanIntentDigest, plan.intentDigest],
    [manifest.acceptedPlanOperationManifestDigest, plan.operationManifestDigest],
    [manifest.acceptedPlanBytesDigest, `sha256:${planDigest}`],
    [manifest.acceptedCliOperationCount, plan.operationCount],
    [manifest.operationCount, manifest.operations.length],
  ];
  if (!PREFIXED_SHA256.test(manifest.operationManifestDigest)) {
    reject("controller operation manifest digest is malformed");
  }
  if (built.operationBytes.length !== manifest.operations.length || manifest.operationCount < 2 || manifest.operationCount > 128) {
    reject("controller operation count is invalid");
  }
  if (manifest.operationManifestDigest !== digestPrefixed(joinJsonArray(built.operationBytes))) {
    reject("controller operation bytes do not match the manifest digest");
  }
  for (const [actual, expected] of exact) {
    if (actual !== expected) reject("accepted plan and controller manifest identities differ");
  }
}

function stageOperations(
  plan: AcceptedGitHubPublicationPlan["value"],
  manifest: GitHubPublicationControllerManifest,
  controllerBytes: readonly Uint8Array[],
): StagedOperation[] {
  const operations: StagedOperation[] = [];
  let dependencyEdges = 0;
  let aggregateControllerRecordBytes = 0;
  let aggregateOperationRecordBytes = 0;
  let aggregateActivationBytes = 0;
  let aggregateDesiredPayloadBytes = 0;
  const seenKeys = new Set<string>();
  for (const [index, record] of manifest.operations.entries()) {
    const controllerRecord = object(record, "controller operation record");
    const operation = object(controllerRecord.operation, "controller operation");
    const source = controllerRecord.source;
    if ((source !== "cli" && source !== "service") || Object.keys(controllerRecord).length !== 2) {
      reject("controller operation source is invalid");
    }
    const exactControllerBytes = Buffer.from(canonicalJson(controllerRecord), "utf8");
    const suppliedControllerBytes = Buffer.from(controllerBytes[index] ?? []);
    aggregateControllerRecordBytes += suppliedControllerBytes.byteLength;
    if (!exactControllerBytes.equals(suppliedControllerBytes)) {
      reject("controller operation bytes are not canonical");
    }
    const ordinal = positiveInteger(operation.ordinal, "operation ordinal");
    const operationKey = boundedText(operation.operationKey, 500, true, "operation key");
    if (ordinal !== index + 1 || seenKeys.has(operationKey)) reject("controller operation identity is invalid");
    seenKeys.add(operationKey);
    const dependencies = stringArray(operation.dependencies, "operation dependencies");
    dependencyEdges += dependencies.length;
    if (dependencyEdges > MAX_DEPENDENCY_EDGES || new Set(dependencies).size !== dependencies.length) {
      reject("controller dependency graph is invalid");
    }
    for (const dependency of dependencies) if (!seenKeys.has(dependency)) {
      reject("controller dependency is not an earlier operation");
    }
    let exactOperation = operation;
    let operationBytes: Buffer;
    if (source === "cli") {
      const expected = plan.operations[index];
      if (expected === undefined || canonicalJson(operation) !== canonicalJson(expected)) {
        reject("controller CLI operation differs from the accepted plan");
      }
      exactOperation = expected as unknown as Record<string, unknown>;
      operationBytes = Buffer.from(JSON.stringify(expected), "utf8");
    } else {
      if (index < plan.operationCount) reject("service operation precedes accepted CLI operations");
      operationBytes = Buffer.from(JSON.stringify(operation), "utf8");
    }
    const activation = object(exactOperation.activation, "operation activation");
    const activationBytes = Buffer.from(JSON.stringify(activation), "utf8");
    const kind = boundedText(exactOperation.kind, 100, true, "operation kind");
    const desiredPayload = deriveDesiredPayload(exactOperation);
    const desiredPayloadBytes = Buffer.from(JSON.stringify(desiredPayload), "utf8");
    if (desiredPayloadBytes.byteLength > MAX_OPERATION_BYTES) reject("operation payload exceeds the byte limit");
    const desiredPayloadDigest = prefixedDigest(exactOperation.desiredDigest, "operation desired digest");
    if (desiredPayloadDigest !== digestPrefixed(desiredPayloadBytes)) {
      reject(`operation ${ordinal} desired bytes do not match the declared digest`);
    }
    if (operationBytes.byteLength > MAX_OPERATION_BYTES || activationBytes.byteLength > 1024 * 1024) {
      reject("operation record exceeds the byte limit");
    }
    aggregateOperationRecordBytes += operationBytes.byteLength;
    aggregateActivationBytes += activationBytes.byteLength;
    aggregateDesiredPayloadBytes += desiredPayloadBytes.byteLength;
    if (
      aggregateControllerRecordBytes > MAX_ARTIFACT_BYTES ||
      aggregateOperationRecordBytes > MAX_ARTIFACT_BYTES ||
      aggregateActivationBytes > MAX_ARTIFACT_BYTES ||
      aggregateDesiredPayloadBytes > MAX_ARTIFACT_BYTES
    ) {
      reject("controller operation artifacts exceed the aggregate byte limit");
    }
    operations.push({
      ordinal,
      source,
      controllerRecord,
      controllerRecordBytes: suppliedControllerBytes,
      operation,
      operationBytes,
      operationKey,
      dependencies,
      activation,
      activationBytes,
      kind,
      desiredPayload,
      desiredPayloadBytes,
      desiredPayloadDigest,
    });
  }
  const cli = operations.filter((operation) => operation.source === "cli");
  if (cli.length !== plan.operationCount || operations.length !== plan.operationCount + 2) {
    reject("controller manifest operation sources or count are invalid");
  }
  const service = operations.slice(plan.operationCount);
  if (
    service[0]?.kind !== "gateCheckCreate"
    || service[1]?.kind !== "gateCheckComplete"
    || service.some((operation) => operation.source !== "service")
  ) {
    reject("controller manifest does not contain the required service gate operations");
  }
  if (digestPrefixed(joinJsonArray(cli.map((operation) => operation.operationBytes))) !== plan.operationManifestDigest) {
    reject("accepted CLI operation bytes do not match the accepted plan digest");
  }
  return operations;
}

function exactReviewRepositoryMatches(
  row: ReviewRepositoryRow | undefined,
  staged: ValidatedStage,
): boolean {
  return row !== undefined &&
    row.repository_id === staged.repositoryId &&
    row.github_repo_id === staged.githubRepositoryId &&
    row.full_name === staged.acceptedPlan.value.repository.fullName &&
    row.pr_number === staged.prNumber &&
    row.head_sha === staged.acceptedPlan.value.reviewedSnapshot.headSha &&
    row.base_sha === staged.acceptedPlan.value.reviewedSnapshot.targetSha &&
    row.status === "running";
}

function isExactSealedReplay(row: ExistingGenerationRow, staged: ValidatedStage): boolean {
  return row.sealed_at !== null
    && row.repository_id === staged.repositoryId
    && row.pr_number === staged.prNumber
    && row.publication_generation === staged.publicationGeneration
    && row.review_id === staged.reviewId
    && row.accepted_plan_digest === staged.acceptedPlan.digest
    && row.accepted_plan_bytes.equals(Buffer.from(staged.acceptedPlan.bytes))
    && row.plan_semantic_digest === staged.planSemanticDigest
    && row.review_input_sequence === staged.reviewInputSequence
    && row.expected_pull_request_updated_at.getTime() === new Date(staged.expectedPullRequestUpdatedAt).getTime()
    && row.accepted_input_bytes.equals(Buffer.from(staged.acceptedInput.bytes))
    && row.accepted_input_digest === staged.acceptedInputDigest
    && row.envelope_digest === staged.envelopeDigest
    && row.head_sha === staged.acceptedPlan.value.reviewedSnapshot.headSha
    && row.base_sha === staged.acceptedPlan.value.reviewedSnapshot.mergeBaseSha
    && row.target_sha === staged.acceptedPlan.value.reviewedSnapshot.targetSha
    && row.target_branch === staged.targetBranch
    && row.operation_count === staged.acceptedPlan.value.operationCount
    && row.operation_manifest_digest === staged.acceptedPlan.value.operationManifestDigest
    && row.controller_operation_count === staged.manifest.value.operationCount
    && row.controller_operation_manifest_digest === staged.manifest.value.operationManifestDigest
    && row.controller_manifest_digest === staged.controllerManifestDigest
    && row.controller_manifest_bytes.equals(Buffer.from(staged.manifest.bytes));
}

function resultFromExisting(
  row: ExistingGenerationRow,
  idempotent: boolean,
): StagedGitHubPublicationControllerGeneration {
  if (row.sealed_at === null) reject("the publication generation is not sealed");
  return {
    generationId: BigInt(row.id),
    repositoryId: BigInt(row.repository_id),
    pullRequestNumber: row.pr_number,
    publicationGeneration: BigInt(row.publication_generation),
    reviewId: BigInt(row.review_id),
    acceptedPlanDigest: row.accepted_plan_digest,
    controllerManifestDigest: row.controller_manifest_digest,
    sealedAt: row.sealed_at,
    status: "sealed",
    idempotent,
  };
}

function deriveDesiredPayload(operation: Record<string, unknown>): Record<string, unknown> {
  const {
    ordinal: _, operationKey: __, dependencies: ___, activation: ____,
    reconciliation: _____, desiredDigest: ______, ...payload
  } = operation;
  return object(payload, "operation desired payload");
}

function bytesParseAs(bytes: Uint8Array, value: unknown): boolean {
  try {
    return canonicalJson(JSON.parse(Buffer.from(bytes).toString("utf8"))) === canonicalJson(value);
  } catch {
    return false;
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject(`${name} is malformed`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) reject(`${name} is malformed`);
  return [...value];
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
  const string = decimal(value as bigint | number | string, name);
  const numeric = Number(string);
  if (!Number.isSafeInteger(numeric) || numeric > 2_147_483_647) reject(`${name} is malformed`);
  return numeric;
}

function rawDigest(value: string, name: string): string {
  if (!SHA256.test(value)) reject(`${name} is malformed`);
  return value;
}

function prefixedDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !PREFIXED_SHA256.test(value)) reject(`${name} is malformed`);
  return value;
}

function timestamp(value: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    reject("pull request timestamp is malformed");
  }
  return value;
}

function boundedText(value: unknown, maximum: number, nonEmpty: boolean, name: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || (nonEmpty && value.trim().length === 0)) {
    reject(`${name} is malformed`);
  }
  return value;
}

function joinJsonArray(parts: readonly Uint8Array[]): Buffer {
  return Buffer.concat([Buffer.from("["), ...parts.flatMap((part, index) => (
    index === 0 ? [Buffer.from(part)] : [Buffer.from(","), Buffer.from(part)]
  )), Buffer.from("]")]);
}

function digestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestPrefixed(bytes: Uint8Array): string {
  return `sha256:${digestHex(bytes)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const objectValue = object(value, "JSON value");
  return `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`).join(",")}}`;
}

function reject(reason: string): never {
  throw new GitHubPublicationControllerStoreRejectedError(reason);
}
