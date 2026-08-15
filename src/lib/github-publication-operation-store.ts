import { createHash } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  AmbiguousGitHubPublicationOperation,
  ClaimedGitHubPublicationOperation,
  DurablePublicationDependencyEvidence,
  GitHubPublicationOperationStore,
  PublicationDispatchEvidence,
  PublicationTerminalEvidence,
} from "@/lib/github-publication-operation-executor";
import type { ExpectedGitHubPublicationPlan } from "@/lib/github-publication-plan";

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const SAFE_DECIMAL = /^[1-9][0-9]{0,18}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;

type JsonObject = Record<string, unknown>;

interface OperationRow extends QueryResultRow {
  database_repository_id: string;
  github_repository_id: string;
  repository_full_name: string;
  pr_number: number;
  publication_generation: string;
  review_id: string;
  head_sha: string;
  base_sha: string;
  target_sha: string;
  pull_request_title: string;
  pull_request_body: string;
  accepted_plan: JsonObject;
  accepted_plan_bytes: Buffer;
  accepted_plan_digest: string;
  controller_manifest_bytes: Buffer;
  controller_manifest_digest: string;
  operation_key: string;
  operation_ordinal: number;
  operation_source: "cli" | "service";
  kind: string;
  controller_record_bytes: Buffer;
  operation_record_bytes: Buffer;
  activation: JsonObject;
  activation_bytes: Buffer;
  desired_payload_bytes: Buffer;
  desired_payload_digest: string;
  state: "pending" | "applying" | "unknown";
  attempt_count: number;
  lease_generation: string;
  lease_id: string | null;
  claim_owner: string | null;
  selected_variant: string | null;
  lease_expires_at: Date | null;
  updated_at: Date;
  last_error: string | null;
}

interface CandidateRow extends QueryResultRow {
  id: string;
  database_repository_id: string;
  pr_number: number;
  publication_generation: string;
  operation_key: string;
  kind: string;
  state: "pending" | "applying";
  attempt_count: number;
  lease_generation: string;
  selected_variant: string | null;
}

interface DependencyRow extends QueryResultRow {
  dependency_operation_key: string;
  dependency_kind: string;
  dependency_state: "applied" | "skipped" | "failed" | "superseded";
  attempt_count: number;
  lease_generation: string;
  terminal_evidence: JsonObject | null;
  attempt_evidence: JsonObject | null;
  attempt_observed_at: Date | null;
  updated_at: Date;
}

/** PostgreSQL implementation of the append-only publication operation boundary. */
export class PostgresGitHubPublicationOperationStore
  implements GitHubPublicationOperationStore {
  constructor(private readonly pool: Pool) {}

  async loadOneAmbiguous(): Promise<AmbiguousGitHubPublicationOperation | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<OperationRow>(
        `${operationSelect()}
         WHERE operation.state = 'unknown'
           AND high_water.publication_generation = operation.publication_generation
           AND generation.sealed_at IS NOT NULL
         ORDER BY operation.updated_at, operation.operation_ordinal
         FOR SHARE OF operation SKIP LOCKED
         LIMIT 1`,
      );
      const row = selected.rows[0];
      if (row === undefined) return null;
      const snapshot = await this.materializeSnapshot(client, row);
      const ambiguityEvidence = await loadAmbiguityEvidence(client, row);
      return {
        ...snapshot,
        attemptNumber: safeInteger(row.attempt_count, "attempt count"),
        leaseGeneration: safeInteger(row.lease_generation, "lease generation"),
        selectedVariant: requiredText(row.selected_variant, "selected variant"),
        ambiguousObservedAt: row.updated_at,
        errorReason: requiredText(row.last_error, "ambiguous error"),
        ...(ambiguityEvidence === null ? {} : { ambiguityEvidence }),
      };
    });
  }

  async claimOneEligible(input: {
    claimOwner: string;
    leaseId: string;
    leaseDurationMs: number;
  }): Promise<ClaimedGitHubPublicationOperation | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<CandidateRow>(
        `SELECT operation.id::text AS id,
                operation.repository_id::text AS database_repository_id,
                operation.pr_number,
                operation.publication_generation::text AS publication_generation,
                operation.operation_key,
                operation.kind,
                operation.state,
                operation.attempt_count,
                operation.lease_generation::text AS lease_generation,
                operation.selected_variant
         FROM review_publication_operations operation
         JOIN pull_request_publication_high_waters high_water
           ON high_water.repository_id = operation.repository_id
          AND high_water.pr_number = operation.pr_number
          AND high_water.publication_generation = operation.publication_generation
         JOIN review_publication_generations generation
           ON generation.repository_id = operation.repository_id
          AND generation.pr_number = operation.pr_number
          AND generation.publication_generation = operation.publication_generation
         WHERE generation.sealed_at IS NOT NULL
           AND (
             (operation.state = 'pending'
               AND (operation.retry_after IS NULL OR operation.retry_after <= clock_timestamp()))
             OR
             (operation.state = 'applying'
               AND operation.lease_expires_at <= clock_timestamp()
               AND NOT EXISTS (
                 SELECT 1
                 FROM review_publication_operation_attempts dispatched
                 WHERE dispatched.repository_id = operation.repository_id
                   AND dispatched.pr_number = operation.pr_number
                   AND dispatched.publication_generation = operation.publication_generation
                   AND dispatched.operation_key = operation.operation_key
                   AND dispatched.attempt_number = operation.attempt_count
                   AND dispatched.lease_generation = operation.lease_generation
                   AND dispatched.phase = 'dispatched'
               ))
           )
           AND NOT EXISTS (
             SELECT 1
             FROM review_publication_operation_dependencies edge
             JOIN review_publication_operations predecessor
               ON predecessor.repository_id = edge.repository_id
              AND predecessor.pr_number = edge.pr_number
              AND predecessor.publication_generation = edge.publication_generation
              AND predecessor.operation_key = edge.dependency_operation_key
             WHERE edge.repository_id = operation.repository_id
               AND edge.pr_number = operation.pr_number
               AND edge.publication_generation = operation.publication_generation
               AND edge.operation_key = operation.operation_key
               AND predecessor.state NOT IN ('applied', 'skipped', 'failed', 'superseded')
           )
         ORDER BY operation.updated_at, operation.operation_ordinal
         FOR UPDATE OF operation SKIP LOCKED
         LIMIT 1`,
      );
      let candidate = selected.rows[0];
      if (candidate === undefined) return null;

      await advisoryLock(client, candidate.database_repository_id, candidate.pr_number);
      if (!await currentSealedEligibility(client, candidate)) return null;

      if (candidate.state === "applying") {
        const recovered = await this.recoverExpiredUndispatched(client, candidate);
        if (!recovered) return null;
        candidate = { ...candidate, state: "pending", selected_variant: null };
      }

      const preclaim = await this.loadOperationRow(
        client,
        candidate.database_repository_id,
        candidate.pr_number,
        candidate.publication_generation,
        candidate.operation_key,
        "pending",
      );
      if (preclaim === null) return null;
      const dependencies = await loadDependencies(client, preclaim);
      if (!activationEligible(preclaim.activation, dependencies)) return null;
      const retryAuthorization = await loadRetryAuthorization(client, preclaim);
      if (retryAuthorization === null) return null;

      const claimed = await client.query(
        `UPDATE review_publication_operations operation
         SET state = 'applying',
             attempt_count = operation.attempt_count + 1,
             lease_generation = operation.lease_generation + 1,
             claim_owner = $5,
             lease_id = $6,
             lease_expires_at = clock_timestamp() + ($7::bigint * interval '1 millisecond'),
             selected_variant = operation.kind,
             retry_after = NULL,
             updated_at = clock_timestamp()
         WHERE operation.repository_id = $1::bigint
           AND operation.pr_number = $2
           AND operation.publication_generation = $3::bigint
           AND operation.operation_key = $4
           AND operation.state = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM review_publication_operations sibling
             WHERE sibling.repository_id = operation.repository_id
               AND sibling.pr_number = operation.pr_number
               AND sibling.publication_generation = operation.publication_generation
               AND sibling.operation_key <> operation.operation_key
               AND sibling.state IN ('applying', 'unknown')
           )
         RETURNING operation.id`,
        [
          candidate.database_repository_id,
          candidate.pr_number,
          candidate.publication_generation,
          candidate.operation_key,
          input.claimOwner,
          input.leaseId,
          input.leaseDurationMs,
        ],
      );
      if (claimed.rowCount !== 1) return null;
      const row = await this.loadOperationRow(
        client,
        candidate.database_repository_id,
        candidate.pr_number,
        candidate.publication_generation,
        candidate.operation_key,
        "applying",
      );
      if (row === null) return null;
      const snapshot = await this.materializeSnapshot(client, row);
      return {
        ...snapshot,
        databaseEligibility: {
          currentSealedHighWater: true,
          dependenciesEligible: true,
          mutuallyExclusive: true,
        },
        dependencies,
        attemptNumber: safeInteger(row.attempt_count, "attempt count"),
        leaseGeneration: safeInteger(row.lease_generation, "lease generation"),
        leaseId: requiredText(row.lease_id, "lease identity"),
        claimedAt: row.updated_at,
        leaseExpiresAt: requiredDate(row.lease_expires_at, "lease expiration"),
        claimOwner: requiredText(row.claim_owner, "claim owner"),
        retryAuthorization,
        selectedVariant: requiredText(row.selected_variant, "selected variant"),
      };
    });
  }

  async recordDispatched(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence,
  ): Promise<boolean> {
    return this.appendAttempt(claim, "dispatched", evidence, null, null, null, true);
  }

  async finishNotDispatched(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & { errorReason: string },
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      if (!await lockClaim(client, claim, true)) return false;
      const payload = evidencePayload({ ...evidence, outcome: "notDispatched", reason: boundedError(evidence.errorReason) });
      if (!await insertAttempt(client, claim, "not_dispatched", payload, null, null, null)) return false;
      const updated = await releaseToPending(client, claim, boundedError(evidence.errorReason));
      return updated;
    });
  }

  async finishApplied(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationTerminalEvidence,
  ): Promise<boolean> {
    if (evidence.remoteId === undefined || evidence.remoteOperationId === undefined) {
      throw new Error("applied publication evidence requires exact remote identities");
    }
    const remoteId = evidence.remoteId;
    const remoteOperationId = evidence.remoteOperationId;
    return this.transaction(async (client) => {
      if (!await lockClaim(client, claim, true)) return false;
      if (!await insertAttempt(
        client,
        claim,
        "applied",
        evidencePayload(evidence),
        null,
        remoteId,
        remoteOperationId,
      )) return false;
      const updated = await client.query(
        `${terminalClaimUpdate("applied")}, last_error = NULL, terminal_evidence = NULL
         WHERE ${claimIdentityWhere()}`,
        claimIdentityValues(claim),
      );
      return updated.rowCount === 1;
    });
  }

  async finishNotRequired(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationTerminalEvidence,
  ): Promise<boolean> {
    return this.finishWithoutDispatch(claim, evidence, "skipped", null);
  }

  async finishRejected(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationTerminalEvidence,
  ): Promise<boolean> {
    const errorReason = boundedError(typeof evidence.result.reason === "string"
      ? evidence.result.reason
      : `GitHub publication rejected with outcome ${evidence.outcome}`);
    const payload = evidencePayload(evidence);
    return this.transaction(async (client) => {
      if (!await lockClaim(client, claim, false)) return false;
      if (!await hasAttemptPhase(client, claim, "dispatched")) return false;
      if (!await insertAttempt(client, claim, "rejected", payload, errorReason, null, null)) return false;
      const updated = await client.query(
        `${terminalClaimUpdate("failed")}, last_error = $10, terminal_evidence = $11::jsonb
         WHERE ${claimIdentityWhere(false)}`,
        [...claimIdentityValues(claim), errorReason, payload],
      );
      return updated.rowCount === 1;
    });
  }

  async finishAmbiguous(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & { errorReason: string },
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      if (!await lockClaim(client, claim, true)) return false;
      const payload = evidencePayload({ ...evidence, outcome: "ambiguous" });
      if (!await insertAttempt(
        client,
        claim,
        "ambiguous",
        payload,
        boundedError(evidence.errorReason),
        null,
        null,
      )) return false;
      const updated = await client.query(
        `${terminalClaimUpdate("unknown")}, last_error = $10, terminal_evidence = NULL
         WHERE ${claimIdentityWhere()}`,
        [...claimIdentityValues(claim), boundedError(evidence.errorReason)],
      );
      return updated.rowCount === 1;
    });
  }

  async retainLeaseLossAfterDispatch(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & {
      errorReason: string;
      observedResult?: Readonly<JsonObject>;
    },
  ): Promise<void> {
    await this.transaction(async (client) => {
      if (!await lockClaim(client, claim, false)) return;
      const dispatched = await hasAttemptPhase(client, claim, "dispatched");
      if (!dispatched) return;
      const payload = evidencePayload({
        ...evidence,
        outcome: "ambiguous",
        ...(evidence.observedResult === undefined ? {} : { observedResult: evidence.observedResult }),
      });
      const inserted = await insertAttempt(
        client,
        claim,
        "ambiguous",
        payload,
        boundedError(evidence.errorReason),
        null,
        null,
      );
      if (!inserted) return;
      await client.query(
        `${terminalClaimUpdate("unknown")}, last_error = $10, terminal_evidence = NULL
         WHERE ${claimIdentityWhere(false)}`,
        [...claimIdentityValues(claim), boundedError(evidence.errorReason)],
      );
    });
  }

  async finishReconciledApplied(
    operation: AmbiguousGitHubPublicationOperation,
    evidence: PublicationTerminalEvidence,
  ): Promise<boolean> {
    if (evidence.remoteId === undefined || evidence.remoteOperationId === undefined) {
      throw new Error("reconciled publication evidence requires exact remote identities");
    }
    const remoteId = evidence.remoteId;
    const remoteOperationId = evidence.remoteOperationId;
    return this.transaction(async (client) => {
      if (!await lockAmbiguous(client, operation)) return false;
      const inserted = await insertReconciliation(
        client,
        operation,
        "terminal",
        "applied",
        evidencePayload(evidence),
        remoteId,
        remoteOperationId,
      );
      if (!inserted) return false;
      const updated = await client.query(
        `UPDATE review_publication_operations
         SET state = 'applied', claim_owner = NULL, lease_id = NULL,
             lease_expires_at = NULL, last_error = NULL,
             terminal_evidence = NULL, updated_at = clock_timestamp()
         WHERE repository_id = $1::bigint AND pr_number = $2
           AND publication_generation = $3::bigint AND operation_key = $4
           AND state = 'unknown' AND attempt_count = $5
           AND lease_generation = $6::bigint AND selected_variant = $7`,
        ambiguousIdentityValues(operation),
      );
      return updated.rowCount === 1;
    });
  }

  async finishReconciledRetry(
    operation: AmbiguousGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & {
      result: Readonly<JsonObject>;
      resultDigest: string;
    },
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      if (!await lockAmbiguous(client, operation)) return false;
      const inserted = await insertReconciliation(
        client,
        operation,
        "retry",
        "exact_absence",
        evidencePayload(evidence),
        null,
        null,
      );
      if (!inserted) return false;
      const updated = await client.query(
        `UPDATE review_publication_operations
         SET state = 'pending', claim_owner = NULL, lease_id = NULL,
             lease_expires_at = NULL, selected_variant = NULL,
             retry_after = clock_timestamp(), last_error = NULL,
             terminal_evidence = NULL, updated_at = clock_timestamp()
         WHERE repository_id = $1::bigint AND pr_number = $2
           AND publication_generation = $3::bigint AND operation_key = $4
           AND state = 'unknown' AND attempt_count = $5
           AND lease_generation = $6::bigint AND selected_variant = $7`,
        ambiguousIdentityValues(operation),
      );
      return updated.rowCount === 1;
    });
  }

  private async appendAttempt(
    claim: ClaimedGitHubPublicationOperation,
    phase: "dispatched",
    evidence: PublicationDispatchEvidence,
    errorReason: string | null,
    remoteId: string | null,
    remoteOperationId: string | null,
    requireFreshLease: boolean,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      if (!await lockClaim(client, claim, requireFreshLease)) return false;
      return insertAttempt(
        client,
        claim,
        phase,
        evidencePayload(evidence),
        errorReason,
        remoteId,
        remoteOperationId,
      );
    });
  }

  private async finishWithoutDispatch(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationTerminalEvidence,
    state: "skipped",
    errorReason: string | null,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      if (!await lockClaim(client, claim, true)) return false;
      if (await hasAttemptPhase(client, claim, "dispatched")) return false;
      const payload = evidencePayload({ ...evidence, outcome: "notDispatched" });
      if (!await insertAttempt(client, claim, "not_dispatched", payload, null, null, null)) return false;
      if (!await releaseToPending(client, claim, errorReason)) return false;
      const updated = await client.query(
        `UPDATE review_publication_operations
         SET state = $7, last_error = $8, terminal_evidence = $9::jsonb,
             updated_at = clock_timestamp()
         WHERE repository_id = $1::bigint AND pr_number = $2
           AND publication_generation = $3::bigint AND operation_key = $4
           AND state = 'pending' AND attempt_count = $5
           AND lease_generation = $6::bigint AND selected_variant IS NULL`,
        [
          ...claimIdentityValues(claim).slice(0, 6),
          state,
          errorReason,
          evidencePayload(evidence),
        ],
      );
      return updated.rowCount === 1;
    });
  }

  private async recoverExpiredUndispatched(
    client: PoolClient,
    candidate: CandidateRow,
  ): Promise<boolean> {
    const row = await client.query<OperationRow>(
      `${operationSelect()}
       WHERE operation.repository_id = $1::bigint
         AND operation.pr_number = $2
         AND operation.publication_generation = $3::bigint
         AND operation.operation_key = $4
         AND operation.state = 'applying'
         AND operation.lease_expires_at <= clock_timestamp()
       FOR UPDATE OF operation`,
      candidateValues(candidate),
    );
    const active = row.rows[0];
    if (active === undefined || await hasAttemptPhaseByRow(client, active, "dispatched")) return false;
    const recoveryEvidence = evidencePayload({
      operationKey: active.operation_key,
      selectedVariant: active.selected_variant,
      activationVariant: "expired-before-dispatch",
      requestDigest: active.desired_payload_digest,
      outcome: "notDispatched",
      reason: "database lease expired without durable dispatch evidence",
    });
    const claim = rowToClaimIdentity(active);
    if (!await insertAttempt(client, claim, "not_dispatched", recoveryEvidence, null, null, null)) return false;
    return releaseToPending(client, claim, "database lease expired without durable dispatch evidence");
  }

  private async loadOperationRow(
    client: PoolClient,
    repositoryId: string,
    prNumber: number,
    generation: string,
    operationKey: string,
    state: "pending" | "applying" | "unknown",
  ): Promise<OperationRow | null> {
    const result = await client.query<OperationRow>(
      `${operationSelect()}
       WHERE operation.repository_id = $1::bigint
         AND operation.pr_number = $2
         AND operation.publication_generation = $3::bigint
         AND operation.operation_key = $4
         AND operation.state = $5
         AND high_water.publication_generation = operation.publication_generation
         AND generation.sealed_at IS NOT NULL
       FOR UPDATE OF operation`,
      [repositoryId, prNumber, generation, operationKey, state],
    );
    return result.rows[0] ?? null;
  }

  private async materializeSnapshot(client: PoolClient, row: OperationRow) {
    const expectedPlan = expectedPlanFromRow(row);
    return {
      repositoryId: requiredDecimal(row.github_repository_id, "GitHub repository identity"),
      databaseRepositoryId: requiredDecimal(row.database_repository_id, "database repository identity"),
      reviewId: requiredDecimal(row.review_id, "review identity"),
      repositoryFullName: requiredText(row.repository_full_name, "repository full name"),
      pullRequestNumber: safeInteger(row.pr_number, "pull request number"),
      publicationGeneration: requiredDecimal(row.publication_generation, "publication generation"),
      headSha: requiredText(row.head_sha, "head SHA"),
      operationKey: requiredText(row.operation_key, "operation key"),
      operationOrdinal: safeInteger(row.operation_ordinal, "operation ordinal"),
      operationSource: row.operation_source,
      kind: requiredText(row.kind, "operation kind"),
      acceptedPlanBytes: Uint8Array.from(row.accepted_plan_bytes),
      acceptedPlanDigest: requiredDigest(row.accepted_plan_digest, false),
      expectedPlan,
      controllerManifestBytes: Uint8Array.from(row.controller_manifest_bytes),
      controllerManifestDigest: requiredDigest(row.controller_manifest_digest, true),
      controllerRecordBytes: Uint8Array.from(row.controller_record_bytes),
      operationRecordBytes: Uint8Array.from(row.operation_record_bytes),
      activationBytes: Uint8Array.from(row.activation_bytes),
      desiredPayloadBytes: Uint8Array.from(row.desired_payload_bytes),
      desiredPayloadDigest: requiredDigest(row.desired_payload_digest, true),
      dependencies: await loadDependencies(client, row),
    };
  }

  private async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isTransactionRetry(error)) return callbackInFreshTransaction(this.pool, callback);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function callbackInFreshTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const value = await callback(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function operationSelect(): string {
  return `SELECT operation.repository_id::text AS database_repository_id,
                 repository.github_repo_id::text AS github_repository_id,
                 repository.full_name AS repository_full_name,
                 operation.pr_number,
                 operation.publication_generation::text AS publication_generation,
                 operation.review_id::text AS review_id,
                 generation.head_sha, generation.base_sha, generation.target_sha,
                 generation.pull_request_title, generation.pull_request_body,
                 generation.accepted_plan, generation.accepted_plan_bytes,
                 generation.accepted_plan_digest,
                 generation.controller_manifest_bytes,
                 generation.controller_manifest_digest,
                 operation.operation_key, operation.operation_ordinal,
                 operation.operation_source, operation.kind,
                 operation.controller_record_bytes, operation.operation_record_bytes,
                 operation.activation, operation.activation_bytes,
                 operation.desired_payload_bytes, operation.desired_payload_digest,
                 operation.state, operation.attempt_count,
                 operation.lease_generation::text AS lease_generation,
                 operation.lease_id::text AS lease_id, operation.claim_owner,
                 operation.selected_variant, operation.lease_expires_at,
                 operation.updated_at, operation.last_error
          FROM review_publication_operations operation
          JOIN review_publication_generations generation
            ON generation.repository_id = operation.repository_id
           AND generation.pr_number = operation.pr_number
           AND generation.publication_generation = operation.publication_generation
           AND generation.review_id = operation.review_id
          JOIN pull_request_publication_high_waters high_water
            ON high_water.repository_id = operation.repository_id
           AND high_water.pr_number = operation.pr_number
          JOIN repositories repository ON repository.id = operation.repository_id`;
}

async function loadDependencies(
  client: PoolClient,
  row: Pick<OperationRow, "database_repository_id" | "pr_number" | "publication_generation" | "operation_key">,
): Promise<DurablePublicationDependencyEvidence[]> {
  const result = await client.query<DependencyRow>(
    `SELECT edge.dependency_operation_key,
            predecessor.kind AS dependency_kind,
            predecessor.state AS dependency_state,
            predecessor.attempt_count,
            predecessor.lease_generation::text AS lease_generation,
            predecessor.terminal_evidence,
            attempt.evidence_payload AS attempt_evidence,
            attempt.observed_at AS attempt_observed_at,
            predecessor.updated_at
     FROM review_publication_operation_dependencies edge
     JOIN review_publication_operations predecessor
       ON predecessor.repository_id = edge.repository_id
      AND predecessor.pr_number = edge.pr_number
      AND predecessor.publication_generation = edge.publication_generation
      AND predecessor.operation_key = edge.dependency_operation_key
     LEFT JOIN LATERAL (
       SELECT evidence_payload, observed_at
       FROM (
         SELECT attempt.evidence_payload, attempt.observed_at
         FROM review_publication_operation_attempts attempt
         WHERE attempt.repository_id = predecessor.repository_id
           AND attempt.pr_number = predecessor.pr_number
           AND attempt.publication_generation = predecessor.publication_generation
           AND attempt.operation_key = predecessor.operation_key
           AND attempt.attempt_number = predecessor.attempt_count
           AND attempt.lease_generation = predecessor.lease_generation
           AND attempt.phase = 'applied'
         UNION ALL
         SELECT reconciliation.evidence_payload, reconciliation.observed_at
         FROM review_publication_operation_reconciliations reconciliation
         WHERE reconciliation.repository_id = predecessor.repository_id
           AND reconciliation.pr_number = predecessor.pr_number
           AND reconciliation.publication_generation = predecessor.publication_generation
           AND reconciliation.operation_key = predecessor.operation_key
           AND reconciliation.attempt_number = predecessor.attempt_count
           AND reconciliation.lease_generation = predecessor.lease_generation
           AND reconciliation.phase = 'terminal'
           AND reconciliation.outcome = 'applied'
       ) terminal_result
       ORDER BY observed_at DESC
       LIMIT 1
     ) attempt ON true
     WHERE edge.repository_id = $1::bigint AND edge.pr_number = $2
       AND edge.publication_generation = $3::bigint AND edge.operation_key = $4
     ORDER BY edge.dependency_position`,
    [row.database_repository_id, row.pr_number, row.publication_generation, row.operation_key],
  );
  return result.rows.map((dependency) => dependencyFromRow(dependency));
}

function dependencyFromRow(row: DependencyRow): DurablePublicationDependencyEvidence {
  const evidence = row.attempt_evidence ?? row.terminal_evidence;
  if (evidence === null || !isObject(evidence)) {
    throw new Error("terminal publication dependency lacks immutable evidence");
  }
  const result = isObject(evidence.result) ? evidence.result : evidence;
  const resultDigest = prefixedDigest(canonicalJson(result));
  if (evidence.resultDigest !== undefined && evidence.resultDigest !== resultDigest) {
    throw new Error("publication dependency result digest is invalid");
  }
  const outcome = requiredOutcome(evidence.outcome);
  return {
    operationKey: requiredText(row.dependency_operation_key, "dependency key"),
    kind: requiredText(row.dependency_kind, "dependency kind"),
    state: row.dependency_state,
    outcome,
    result,
    resultDigest,
    attemptNumber: safeInteger(row.attempt_count, "dependency attempt"),
    leaseGeneration: safeInteger(row.lease_generation, "dependency lease generation"),
    observedAt: row.attempt_observed_at ?? row.updated_at,
    ...(typeof evidence.remoteId === "string" ? { remoteId: evidence.remoteId } : {}),
    ...(typeof evidence.remoteOperationId === "string" ? { remoteOperationId: evidence.remoteOperationId } : {}),
    ...(typeof evidence.httpStatus === "number" ? { httpStatus: evidence.httpStatus } : {}),
    ...(evidence.classification === "invalidReviewCommentPlacement"
      ? { classification: evidence.classification }
      : {}),
  };
}

function expectedPlanFromRow(row: OperationRow): ExpectedGitHubPublicationPlan {
  const accepted = row.accepted_plan;
  return {
    controllerGeneration: requiredText(accepted.controllerGeneration, "controller generation"),
    inputIdentity: requiredDigest(accepted.inputIdentity, true),
    reviewOutputDigest: requiredDigest(accepted.reviewOutputDigest, true),
    repositoryId: requiredDecimal(row.github_repository_id, "GitHub repository identity"),
    repositoryFullName: requiredText(row.repository_full_name, "repository full name"),
    pullRequestNumber: String(safeInteger(row.pr_number, "pull request number")),
    headSha: requiredText(row.head_sha, "head SHA"),
    mergeBaseSha: requiredText(row.base_sha, "merge-base SHA"),
    targetSha: requiredText(row.target_sha, "target SHA"),
    pullRequestTitle: row.pull_request_title,
    pullRequestBody: row.pull_request_body,
  };
}

async function loadRetryAuthorization(
  client: PoolClient,
  row: OperationRow,
): Promise<ClaimedGitHubPublicationOperation["retryAuthorization"] | null> {
  const attempt = safeInteger(row.attempt_count, "attempt count");
  const lease = safeInteger(row.lease_generation, "lease generation");
  if (attempt === 0 && lease === 0) return { kind: "initial" };
  if (attempt < 1 || lease < 1) return null;
  const evidence = await client.query<{
    kind: "notDispatched" | "exactAbsence";
    observed_at: Date;
    evidence_payload: JsonObject;
  }>(
    `SELECT kind, observed_at, evidence_payload
     FROM (
       SELECT 'notDispatched'::text AS kind, observed_at, evidence_payload
       FROM review_publication_operation_attempts
       WHERE repository_id = $1::bigint AND pr_number = $2
         AND publication_generation = $3::bigint AND operation_key = $4
         AND attempt_number = $5 AND lease_generation = $6::bigint
         AND phase = 'not_dispatched'
       UNION ALL
       SELECT 'exactAbsence'::text AS kind, observed_at, evidence_payload
       FROM review_publication_operation_reconciliations
       WHERE repository_id = $1::bigint AND pr_number = $2
         AND publication_generation = $3::bigint AND operation_key = $4
         AND attempt_number = $5 AND lease_generation = $6::bigint
         AND phase = 'retry' AND outcome = 'exact_absence'
     ) evidence
     ORDER BY observed_at DESC
     LIMIT 1`,
    [
      row.database_repository_id,
      row.pr_number,
      row.publication_generation,
      row.operation_key,
      attempt,
      lease,
    ],
  );
  const prior = evidence.rows[0];
  if (prior === undefined) return null;
  const base = {
    priorAttemptNumber: attempt,
    priorLeaseGeneration: lease,
    evidenceDigest: prefixedDigest(canonicalJson(prior.evidence_payload)),
  };
  return prior.kind === "notDispatched"
    ? { kind: "notDispatched", ...base }
    : { kind: "exactAbsence", observedAt: prior.observed_at, ...base };
}

async function loadAmbiguityEvidence(
  client: PoolClient,
  row: OperationRow,
): Promise<JsonObject | null> {
  const evidence = await client.query<{ evidence_payload: JsonObject }>(
    `SELECT evidence_payload
     FROM review_publication_operation_attempts
     WHERE repository_id = $1::bigint AND pr_number = $2
       AND publication_generation = $3::bigint AND operation_key = $4
       AND attempt_number = $5 AND lease_generation = $6::bigint
       AND phase = 'ambiguous'
     LIMIT 1`,
    [
      row.database_repository_id,
      row.pr_number,
      row.publication_generation,
      row.operation_key,
      row.attempt_count,
      row.lease_generation,
    ],
  );
  const value = evidence.rows[0]?.evidence_payload;
  return value !== undefined && isObject(value) ? value : null;
}

function activationEligible(
  activation: JsonObject,
  dependencies: readonly DurablePublicationDependencyEvidence[],
): boolean {
  if (!Array.isArray(activation.anyOf) || activation.anyOf.length === 0) return false;
  const byKey = new Map(dependencies.map((dependency) => [dependency.operationKey, dependency]));
  return activation.anyOf.some((raw) => {
    if (!isObject(raw) || typeof raw.condition !== "string") return false;
    if (["always", "markerAbsent", "findingContentDiffers", "allDependenciesTerminal"].includes(raw.condition)) {
      return true;
    }
    if (raw.condition === "semanticPlacementRejected") {
      const dependency = byKey.get(String(raw.dependencyOperationKey));
      return dependency?.state === "failed" && dependency.outcome === "rejected" &&
        dependency.httpStatus === 422 &&
        dependency.classification === "invalidReviewCommentPlacement";
    }
    if (raw.condition === "partialReviewObserved") {
      const dependency = byKey.get(String(raw.dependencyOperationKey));
      return dependency?.state === "applied" && dependency.outcome === "partialObserved" &&
        dependency.remoteId !== undefined;
    }
    if (raw.condition === "reviewSelectionTerminal") {
      return Array.isArray(raw.selectedReviewOperationKeys) &&
        raw.selectedReviewOperationKeys.every((key) => byKey.has(String(key)));
    }
    return false;
  });
}

async function currentSealedEligibility(
  client: PoolClient,
  candidate: CandidateRow,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM pull_request_publication_high_waters high_water
     JOIN review_publication_generations generation
       ON generation.repository_id = high_water.repository_id
      AND generation.pr_number = high_water.pr_number
      AND generation.publication_generation = high_water.publication_generation
     WHERE high_water.repository_id = $1::bigint AND high_water.pr_number = $2
       AND high_water.publication_generation = $3::bigint
       AND generation.sealed_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM review_publication_operations active
         WHERE active.repository_id = high_water.repository_id
           AND active.pr_number = high_water.pr_number
           AND active.publication_generation = high_water.publication_generation
           AND active.operation_key <> $4
           AND active.state IN ('applying', 'unknown')
       )`,
    candidateValues(candidate),
  );
  return result.rowCount === 1;
}

async function advisoryLock(client: PoolClient, repositoryId: string, prNumber: number): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`,
    [repositoryId, prNumber],
  );
}

async function lockClaim(
  client: PoolClient,
  claim: ClaimedGitHubPublicationOperation,
  requireFreshLease: boolean,
): Promise<boolean> {
  await advisoryLock(client, claim.databaseRepositoryId, claim.pullRequestNumber);
  const result = await client.query(
    `SELECT 1
     FROM review_publication_operations operation
     JOIN pull_request_publication_high_waters high_water
       ON high_water.repository_id = operation.repository_id
      AND high_water.pr_number = operation.pr_number
      AND high_water.publication_generation = operation.publication_generation
     JOIN review_publication_generations generation
       ON generation.repository_id = operation.repository_id
      AND generation.pr_number = operation.pr_number
      AND generation.publication_generation = operation.publication_generation
     WHERE operation.repository_id = $1::bigint AND operation.pr_number = $2
       AND operation.publication_generation = $3::bigint AND operation.operation_key = $4
       AND operation.state = 'applying' AND operation.attempt_count = $5
       AND operation.lease_generation = $6::bigint AND operation.lease_id = $7::uuid
       AND operation.claim_owner = $8 AND operation.selected_variant = $9
       AND generation.sealed_at IS NOT NULL
       ${requireFreshLease ? "AND operation.lease_expires_at > clock_timestamp()" : ""}
     FOR UPDATE OF operation`,
    [
      claim.databaseRepositoryId,
      claim.pullRequestNumber,
      claim.publicationGeneration,
      claim.operationKey,
      claim.attemptNumber,
      claim.leaseGeneration,
      claim.leaseId,
      claim.claimOwner,
      claim.selectedVariant,
    ],
  );
  return result.rowCount === 1;
}

async function lockAmbiguous(
  client: PoolClient,
  operation: AmbiguousGitHubPublicationOperation,
): Promise<boolean> {
  await advisoryLock(client, operation.databaseRepositoryId, operation.pullRequestNumber);
  const result = await client.query(
    `SELECT 1
     FROM review_publication_operations candidate
     JOIN pull_request_publication_high_waters high_water
       ON high_water.repository_id = candidate.repository_id
      AND high_water.pr_number = candidate.pr_number
      AND high_water.publication_generation = candidate.publication_generation
     JOIN review_publication_generations generation
       ON generation.repository_id = candidate.repository_id
      AND generation.pr_number = candidate.pr_number
      AND generation.publication_generation = candidate.publication_generation
     WHERE candidate.repository_id = $1::bigint AND candidate.pr_number = $2
       AND candidate.publication_generation = $3::bigint AND candidate.operation_key = $4
       AND candidate.state = 'unknown' AND candidate.attempt_count = $5
       AND candidate.lease_generation = $6::bigint AND candidate.selected_variant = $7
       AND generation.sealed_at IS NOT NULL
     FOR UPDATE OF candidate`,
    ambiguousIdentityValues(operation),
  );
  return result.rowCount === 1;
}

async function insertAttempt(
  client: PoolClient,
  claim: Pick<
    ClaimedGitHubPublicationOperation,
    "databaseRepositoryId" | "pullRequestNumber" | "publicationGeneration" |
    "operationKey" | "attemptNumber" | "leaseGeneration" | "selectedVariant"
  >,
  phase: "dispatched" | "not_dispatched" | "ambiguous" | "applied" | "rejected",
  payload: string,
  errorReason: string | null,
  remoteIdentity: string | null,
  remoteOperationId: string | null,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO review_publication_operation_attempts
       (repository_id, pr_number, publication_generation, operation_key,
        attempt_number, lease_generation, phase, selected_variant,
        evidence_payload, error_reason, remote_identity, remote_operation_id,
        observed_at, created_at)
     VALUES ($1::bigint, $2, $3::bigint, $4, $5, $6::bigint, $7, $8,
             $9::jsonb, $10, $11, $12, clock_timestamp(), clock_timestamp())
     ON CONFLICT DO NOTHING`,
    [
      claim.databaseRepositoryId,
      claim.pullRequestNumber,
      claim.publicationGeneration,
      claim.operationKey,
      claim.attemptNumber,
      claim.leaseGeneration,
      phase,
      claim.selectedVariant,
      payload,
      errorReason,
      remoteIdentity,
      remoteOperationId,
    ],
  );
  return result.rowCount === 1;
}

async function insertReconciliation(
  client: PoolClient,
  operation: AmbiguousGitHubPublicationOperation,
  phase: "retry" | "terminal",
  outcome: "exact_absence" | "applied",
  payload: string,
  remoteIdentity: string | null,
  remoteOperationId: string | null,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO review_publication_operation_reconciliations
       (repository_id, pr_number, publication_generation, operation_key,
        attempt_number, lease_generation, phase, selected_variant, outcome,
        evidence_payload, remote_identity, remote_operation_id, observed_at, created_at)
     VALUES ($1::bigint, $2, $3::bigint, $4, $5, $6::bigint, $8, $7, $9,
             $10::jsonb, $11, $12, clock_timestamp(), clock_timestamp())
     ON CONFLICT DO NOTHING`,
    [
      operation.databaseRepositoryId,
      operation.pullRequestNumber,
      operation.publicationGeneration,
      operation.operationKey,
      operation.attemptNumber,
      operation.leaseGeneration,
      operation.selectedVariant,
      phase,
      outcome,
      payload,
      remoteIdentity,
      remoteOperationId,
    ],
  );
  return result.rowCount === 1;
}

async function releaseToPending(
  client: PoolClient,
  claim: Pick<
    ClaimedGitHubPublicationOperation,
    "databaseRepositoryId" | "pullRequestNumber" | "publicationGeneration" |
    "operationKey" | "attemptNumber" | "leaseGeneration" | "leaseId" |
    "claimOwner" | "selectedVariant"
  >,
  errorReason: string | null,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE review_publication_operations
     SET state = 'pending', claim_owner = NULL, lease_id = NULL,
         lease_expires_at = NULL, selected_variant = NULL,
         retry_after = clock_timestamp(), last_error = $10,
         terminal_evidence = NULL, updated_at = clock_timestamp()
     WHERE repository_id = $1::bigint AND pr_number = $2
       AND publication_generation = $3::bigint AND operation_key = $4
       AND state = 'applying' AND attempt_count = $5
       AND lease_generation = $6::bigint AND lease_id = $7::uuid
       AND claim_owner = $8 AND selected_variant = $9`,
    [
      claim.databaseRepositoryId,
      claim.pullRequestNumber,
      claim.publicationGeneration,
      claim.operationKey,
      claim.attemptNumber,
      claim.leaseGeneration,
      claim.leaseId,
      claim.claimOwner,
      claim.selectedVariant,
      errorReason,
    ],
  );
  return result.rowCount === 1;
}

async function hasAttemptPhase(
  client: PoolClient,
  claim: Pick<
    ClaimedGitHubPublicationOperation,
    "databaseRepositoryId" | "pullRequestNumber" | "publicationGeneration" |
    "operationKey" | "attemptNumber" | "leaseGeneration"
  >,
  phase: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM review_publication_operation_attempts
     WHERE repository_id = $1::bigint AND pr_number = $2
       AND publication_generation = $3::bigint AND operation_key = $4
       AND attempt_number = $5 AND lease_generation = $6::bigint AND phase = $7`,
    [
      claim.databaseRepositoryId,
      claim.pullRequestNumber,
      claim.publicationGeneration,
      claim.operationKey,
      claim.attemptNumber,
      claim.leaseGeneration,
      phase,
    ],
  );
  return result.rowCount === 1;
}

async function hasAttemptPhaseByRow(
  client: PoolClient,
  row: OperationRow,
  phase: string,
): Promise<boolean> {
  return hasAttemptPhase(client, rowToClaimIdentity(row), phase);
}

function terminalClaimUpdate(state: "applied" | "unknown" | "failed"): string {
  return `UPDATE review_publication_operations
          SET state = '${state}', claim_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, updated_at = clock_timestamp()`;
}

function claimIdentityWhere(fresh = true): string {
  return `repository_id = $1::bigint AND pr_number = $2
          AND publication_generation = $3::bigint AND operation_key = $4
          AND state = 'applying' AND attempt_count = $5
          AND lease_generation = $6::bigint AND lease_id = $7::uuid
          AND claim_owner = $8 AND selected_variant = $9
          ${fresh ? "AND lease_expires_at > clock_timestamp()" : ""}`;
}

function claimIdentityValues(claim: ClaimedGitHubPublicationOperation): unknown[] {
  return [
    claim.databaseRepositoryId,
    claim.pullRequestNumber,
    claim.publicationGeneration,
    claim.operationKey,
    claim.attemptNumber,
    claim.leaseGeneration,
    claim.leaseId,
    claim.claimOwner,
    claim.selectedVariant,
  ];
}

function ambiguousIdentityValues(operation: AmbiguousGitHubPublicationOperation): unknown[] {
  return [
    operation.databaseRepositoryId,
    operation.pullRequestNumber,
    operation.publicationGeneration,
    operation.operationKey,
    operation.attemptNumber,
    operation.leaseGeneration,
    operation.selectedVariant,
  ];
}

function candidateValues(candidate: CandidateRow): unknown[] {
  return [
    candidate.database_repository_id,
    candidate.pr_number,
    candidate.publication_generation,
    candidate.operation_key,
  ];
}

function rowToClaimIdentity(row: OperationRow): ClaimedGitHubPublicationOperation {
  return {
    databaseEligibility: {
      currentSealedHighWater: true,
      dependenciesEligible: true,
      mutuallyExclusive: true,
    },
    databaseRepositoryId: row.database_repository_id,
    repositoryId: row.github_repository_id,
    reviewId: row.review_id,
    repositoryFullName: row.repository_full_name,
    pullRequestNumber: row.pr_number,
    publicationGeneration: row.publication_generation,
    headSha: row.head_sha,
    operationKey: row.operation_key,
    operationOrdinal: row.operation_ordinal,
    operationSource: row.operation_source,
    kind: row.kind,
    acceptedPlanBytes: row.accepted_plan_bytes,
    acceptedPlanDigest: row.accepted_plan_digest,
    expectedPlan: expectedPlanFromRow(row),
    controllerManifestBytes: row.controller_manifest_bytes,
    controllerManifestDigest: row.controller_manifest_digest,
    controllerRecordBytes: row.controller_record_bytes,
    operationRecordBytes: row.operation_record_bytes,
    activationBytes: row.activation_bytes,
    desiredPayloadBytes: row.desired_payload_bytes,
    desiredPayloadDigest: row.desired_payload_digest,
    dependencies: [],
    attemptNumber: safeInteger(row.attempt_count, "attempt count"),
    leaseGeneration: safeInteger(row.lease_generation, "lease generation"),
    leaseId: requiredText(row.lease_id, "lease identity"),
    claimedAt: row.updated_at,
    leaseExpiresAt: requiredDate(row.lease_expires_at, "lease expiration"),
    claimOwner: requiredText(row.claim_owner, "claim owner"),
    retryAuthorization: { kind: "initial" },
    selectedVariant: requiredText(row.selected_variant, "selected variant"),
  };
}

function evidencePayload(value: unknown): string {
  const serialized = canonicalJson(JSON.parse(JSON.stringify(value)));
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_BYTES - 1024) {
    throw new Error("publication evidence exceeds its database byte limit");
  }
  if (serialized === "{}") throw new Error("publication evidence must not be empty");
  return serialized;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("publication evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isObject(value)) throw new Error("publication evidence contains a non-JSON value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function prefixedDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function requiredOutcome(value: unknown): DurablePublicationDependencyEvidence["outcome"] {
  if (
    value !== "created" && value !== "reconciledExisting" &&
    value !== "partialObserved" && value !== "applied" &&
    value !== "notRequiredMarkerPresent" && value !== "notRequiredContentExact" &&
    value !== "rejected"
  ) throw new Error("publication dependency outcome is invalid");
  return value;
}

function requiredDigest(value: unknown, prefixed: boolean): string {
  if (typeof value !== "string" || !(prefixed ? PREFIXED_SHA256 : RAW_SHA256).test(value)) {
    throw new Error("publication digest is invalid");
  }
  return value;
}

function requiredDecimal(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (!SAFE_DECIMAL.test(text) || BigInt(text) > 9_223_372_036_854_775_807n) {
    throw new Error(`${name} is invalid`);
  }
  return text;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requiredDate(value: unknown, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${name} is invalid`);
  return value;
}

function safeInteger(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} is invalid`);
  return number;
}

function boundedError(value: string): string {
  const trimmed = value.trim().slice(0, 4_000);
  return trimmed.length > 0 ? trimmed : "unknown publication failure";
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTransactionRetry(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "40001" || code === "40P01" || code === "23505";
}
