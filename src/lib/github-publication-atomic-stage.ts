import { createHash } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

import { schema, type Database } from "@/lib/db";
import { envelopeSchema } from "@/lib/envelope";
import {
  type GitHubPublicationControllerGenerationInput,
  stageGitHubPublicationControllerGenerationInTransaction,
  type StagedGitHubPublicationControllerGeneration,
} from "@/lib/github-publication-controller-store";
import type { PrivateJsonArtifact } from "@/lib/private-json-artifact";
import {
  stageReviewCompletionCandidateInTransaction,
  type ControllerStagedReviewCompletionInput,
  type ReviewCompletionWithGateModeResult,
} from "@/lib/review-completion";

const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

export interface StageGitHubPublicationCandidateAtomicallyInput {
  database: Pick<Pool, "connect">;
  organizationId: number | null;
  envelopeArtifact: PrivateJsonArtifact;
  completion: ControllerStagedReviewCompletionInput;
  generation: GitHubPublicationControllerGenerationInput;
}

export interface StagedGitHubPublicationCandidateAtomically {
  completion: ReviewCompletionWithGateModeResult & { staged: true };
  generation: StagedGitHubPublicationControllerGeneration;
}

export class GitHubPublicationAtomicStageRejectedError extends Error {
  override name = "GitHubPublicationAtomicStageRejectedError";

  constructor(reason: string, options?: ErrorOptions) {
    super(`GitHub publication atomic staging rejected: ${reason}`, options);
  }
}

/**
 * Persist the authenticated review result, recovery pointer, and immutable
 * controller generation with one PostgreSQL commit. Publication evidence is
 * derived and persisted only after the controller reaches terminal state.
 */
export async function stageGitHubPublicationCandidateAtomically(
  input: StageGitHubPublicationCandidateAtomicallyInput,
): Promise<StagedGitHubPublicationCandidateAtomically> {
  validateAtomicIdentity(input);
  const client = await input.database.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const tx = drizzle(client, { schema }) as Database;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${input.generation.acceptedInput.value.databaseRepositoryId}:${input.generation.acceptedInput.value.pullRequestNumber}`,
    ]);
    const completion = await stageReviewCompletionCandidateInTransaction(
      tx,
      input.completion,
      input.organizationId,
    );
    if (!completion.staged) reject("the review completion candidate lost its exact lease");
    await requireExactReviewJobInput(client, input);
    const generation = await stageGitHubPublicationControllerGenerationInTransaction(
      client,
      input.generation,
    );
    await client.query("COMMIT");
    began = false;
    return {
      completion: { ...completion, staged: true },
      generation,
    };
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof GitHubPublicationAtomicStageRejectedError) throw error;
    throw new GitHubPublicationAtomicStageRejectedError(
      "the shared database transaction could not stage the candidate",
      { cause: error },
    );
  } finally {
    client.release();
  }
}

/** Digest the normalized envelope value that PostgreSQL stores as JSONB. */
export function githubPublicationEnvelopeDigest(envelope: unknown): string {
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success) reject("the authenticated envelope is invalid");
  return createHash("sha256")
    .update(canonicalJson(parsed.data), "utf8")
    .digest("hex");
}

function validateAtomicIdentity(input: StageGitHubPublicationCandidateAtomicallyInput): void {
  const bytes = input.envelopeArtifact.bytes;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_ENVELOPE_BYTES
  ) {
    reject("the authenticated envelope artifact is invalid");
  }
  let artifactValue: unknown;
  try {
    artifactValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    reject("the authenticated envelope artifact is invalid");
  }
  if (canonicalJson(artifactValue) !== canonicalJson(input.envelopeArtifact.value)) {
    reject("the authenticated envelope bytes differ from their parsed value");
  }
  const artifactEnvelope = envelopeSchema.safeParse(artifactValue);
  const completionEnvelope = envelopeSchema.safeParse(input.completion.envelope);
  if (!artifactEnvelope.success || !completionEnvelope.success) {
    reject("the authenticated envelope is invalid");
  }
  if (canonicalJson(artifactEnvelope.data) !== canonicalJson(completionEnvelope.data)) {
    reject("the completion envelope differs from the authenticated artifact");
  }
  const envelopeDigest = githubPublicationEnvelopeDigest(artifactEnvelope.data);
  if (input.generation.snapshot.envelopeDigest !== envelopeDigest) {
    reject("the controller generation names a different envelope digest");
  }
  if (
    BigInt(input.generation.snapshot.reviewId) !== BigInt(input.completion.reviewId) ||
    input.generation.acceptedInput.value.reviewId !== String(input.completion.reviewId)
  ) {
    reject("the review completion and controller generation identities differ");
  }
  if (
    input.completion.deferPublicationReceipt !== true ||
    input.completion.publicationReceipt !== undefined
  ) {
    reject("atomic controller staging must defer publication receipt evidence");
  }
}

async function requireExactReviewJobInput(
  client: Pick<PoolClient, "query">,
  input: StageGitHubPublicationCandidateAtomicallyInput,
): Promise<void> {
  const result = await client.query<{ payload: Record<string, unknown> }>(
    `SELECT payload
       FROM jobs
      WHERE id = $1
        AND kind = 'review'
        AND status = 'running'
        AND locked_by = $2
        AND lock_generation = $3
      FOR UPDATE`,
    [
      input.completion.reviewJobLease.id,
      input.completion.reviewJobLease.lockedBy,
      input.completion.reviewJobLease.lockGeneration.toString(),
    ],
  );
  const payload = result.rows[0]?.payload;
  const accepted = input.generation.acceptedInput.value;
  if (
    payload === undefined ||
    String(payload.githubRepoId) !== accepted.githubRepositoryId ||
    payload.repoFullName !== accepted.repositoryFullName ||
    String(payload.prNumber) !== accepted.pullRequestNumber ||
    payload.headSha !== accepted.headSha ||
    payload.baseSha !== accepted.targetSha ||
    payload.expectedPullRequestUpdatedAt !== accepted.expectedPullRequestUpdatedAt ||
    payload.reviewInputSequence !== accepted.controllerGeneration
  ) {
    reject("the claimed review job differs from the accepted publication input");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("the authenticated envelope is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") reject("the authenticated envelope is invalid");
  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`
  ).join(",")}}`;
}

function reject(reason: string): never {
  throw new GitHubPublicationAtomicStageRejectedError(reason);
}
