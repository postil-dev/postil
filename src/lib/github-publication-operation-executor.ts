import { createHash, randomUUID } from "node:crypto";

import {
  buildGitHubPublicationControllerManifest,
  type GitHubPublicationControllerManifest,
} from "@/lib/github-publication-controller-manifest";
import {
  parseGitHubPublicationPlanBytes,
  type ExpectedGitHubPublicationPlan,
  type GitHubPublicationPlan,
} from "@/lib/github-publication-plan";
import {
  completeGitHubCheckRun,
  createGitHubCheckRun,
  findGitHubCheckRunByExternalId,
  findGitHubFileCommentByMarker,
  GitHubPublicationAmbiguousError,
  GitHubPublicationRejectedError,
  GitHubReviewPlacementRejectedError,
  observeGitHubCheckRunCompletion,
  observeGitHubCompositeReviewByMarker,
  observeGitHubReviewComment,
  publishGitHubCompositeReview,
  publishGitHubFileComment,
  updateGitHubReviewComment,
  updateGitHubReviewSummary,
  type GitHubCheckRunCompletionIntent,
  type GitHubCheckRunCompletionObservation,
  type GitHubCheckRunStartIntent,
  type GitHubCompositeReviewIntent,
  type GitHubFileCommentIntent,
  type GitHubReviewCommentUpdateIntent,
  type GitHubReviewObservation,
} from "@/lib/github/review-publication";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const OPERATION_KEY = /^(?:github-publication-v1:[a-z-]+|github-publication-controller-v1:gate-(?:create|complete)):sha256:[0-9a-f]{64}$/;
const MARKER = /^<!-- postil-(review|finding):v(?:1:[0-9a-f]{12}|2:[0-9a-f]{64}) -->$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REMOTE_ID = /^[1-9][0-9]{0,19}$/;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_CONTROLLER_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_OPERATION_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_OPERATION_COMPONENT_BYTES = 1024 * 1024;
const SUPPORTED_KINDS = new Set([
  "reviewCreate",
  "fileCommentFallback",
  "findingCommentUpdate",
  "reviewSummaryUpdate",
  "advisoryCheckCreate",
  "advisoryCheckComplete",
  "gateCheckCreate",
  "gateCheckComplete",
]);

type JsonObject = Record<string, unknown>;

export type PublicationTerminalOutcome =
  | "created"
  | "reconciledExisting"
  | "partialObserved"
  | "applied"
  | "notRequiredMarkerPresent"
  | "notRequiredContentExact"
  | "rejected";

export interface DurablePublicationDependencyEvidence {
  readonly operationKey: string;
  readonly kind: string;
  readonly state: "applied" | "skipped" | "failed" | "superseded";
  readonly outcome: PublicationTerminalOutcome;
  readonly remoteId?: string;
  readonly remoteOperationId?: string;
  readonly httpStatus?: number;
  readonly classification?: "invalidReviewCommentPlacement";
  readonly result: Readonly<JsonObject>;
  readonly resultDigest: string;
  readonly attemptNumber: number;
  readonly leaseGeneration: number;
  readonly observedAt: Date;
}

export interface ClaimedGitHubPublicationOperation {
  readonly databaseEligibility: {
    /** The claim transaction joined and locked the current high-water row. */
    readonly currentSealedHighWater: true;
    /** The claim transaction enforced dependency and activation readiness. */
    readonly dependenciesEligible: true;
    /** The claim used row locking with SKIP LOCKED or an equivalent serializable primitive. */
    readonly mutuallyExclusive: true;
  };
  readonly repositoryId: string;
  /** Internal database identity, distinct from the GitHub repository ID. */
  readonly databaseRepositoryId: string;
  readonly reviewId: string;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly publicationGeneration: string;
  readonly headSha: string;
  readonly operationKey: string;
  readonly operationOrdinal: number;
  readonly operationSource: "cli" | "service";
  readonly kind: string;
  readonly acceptedPlanBytes: Uint8Array;
  readonly acceptedPlanDigest: string;
  readonly expectedPlan: ExpectedGitHubPublicationPlan;
  readonly controllerManifestBytes: Uint8Array;
  readonly controllerManifestDigest: string;
  readonly controllerRecordBytes: Uint8Array;
  readonly operationRecordBytes: Uint8Array;
  readonly activationBytes: Uint8Array;
  readonly desiredPayloadBytes: Uint8Array;
  readonly desiredPayloadDigest: string;
  readonly dependencies: readonly DurablePublicationDependencyEvidence[];
  readonly attemptNumber: number;
  readonly leaseGeneration: number;
  readonly leaseId: string;
  readonly claimedAt: Date;
  readonly leaseExpiresAt: Date;
  readonly claimOwner: string;
  readonly retryAuthorization:
    | { readonly kind: "initial" }
    | {
        readonly kind: "notDispatched";
        readonly priorAttemptNumber: number;
        readonly priorLeaseGeneration: number;
        readonly evidenceDigest: string;
      }
    | {
        readonly kind: "exactAbsence";
        readonly priorAttemptNumber: number;
        readonly priorLeaseGeneration: number;
        readonly observedAt: Date;
        readonly evidenceDigest: string;
      };
  readonly selectedVariant: string;
}

export interface AmbiguousGitHubPublicationOperation
  extends Omit<
    ClaimedGitHubPublicationOperation,
    | "databaseEligibility"
    | "claimedAt"
    | "leaseExpiresAt"
    | "leaseId"
    | "claimOwner"
    | "retryAuthorization"
  > {
  readonly ambiguousObservedAt: Date;
  readonly errorReason: string;
  readonly ambiguityEvidence?: Readonly<JsonObject>;
}

export interface PublicationDispatchEvidence {
  readonly requestDigest: string;
  readonly operationKey: string;
  readonly selectedVariant: string;
  readonly activationVariant: string;
  readonly observedAt: Date;
}

export interface PublicationTerminalEvidence extends PublicationDispatchEvidence {
  readonly outcome: PublicationTerminalOutcome;
  readonly result: Readonly<JsonObject>;
  readonly resultDigest: string;
  readonly remoteId?: string;
  readonly remoteOperationId?: string;
  readonly httpStatus?: number;
  readonly classification?: "invalidReviewCommentPlacement";
}

/**
 * Transactional persistence boundary for the operation consumer.
 *
 * `claimOneEligible` must enforce current sealed high-water membership,
 * dependency readiness, retry authorization, lease freshness, and one active
 * operation per pull request in the database transaction that creates the
 * claim. Every remaining method is an append-and-CAS transaction bound to the
 * exact attempt number, lease generation, lease ID, owner, and unexpired lease.
 */
export interface GitHubPublicationOperationStore {
  loadOneAmbiguous(): Promise<AmbiguousGitHubPublicationOperation | null>;
  claimOneEligible(input: {
    claimOwner: string;
    leaseId: string;
    leaseDurationMs: number;
  }): Promise<ClaimedGitHubPublicationOperation | null>;
  recordDispatched(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence,
  ): Promise<boolean>;
  finishNotDispatched(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & { errorReason: string },
  ): Promise<boolean>;
  finishApplied(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationTerminalEvidence,
  ): Promise<boolean>;
  finishNotRequired(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationTerminalEvidence,
  ): Promise<boolean>;
  finishRejected(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationTerminalEvidence,
  ): Promise<boolean>;
  finishAmbiguous(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & { errorReason: string },
  ): Promise<boolean>;
  retainLeaseLossAfterDispatch(
    claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & {
      errorReason: string;
      observedResult?: Readonly<JsonObject>;
    },
  ): Promise<void>;
  finishReconciledApplied(
    operation: AmbiguousGitHubPublicationOperation,
    evidence: PublicationTerminalEvidence,
  ): Promise<boolean>;
  finishReconciledRetry(
    operation: AmbiguousGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & {
      result: Readonly<JsonObject>;
      resultDigest: string;
    },
  ): Promise<boolean>;
}

export interface GitHubPublicationAdapters {
  observeReview(
    token: string,
    repo: string,
    pr: number,
    marker: string,
    headSha: string,
    commentMarkers: string[],
    signal?: AbortSignal,
  ): Promise<GitHubReviewObservation | null>;
  publishReview(
    token: string,
    repo: string,
    pr: number,
    intent: GitHubCompositeReviewIntent,
    signal?: AbortSignal,
  ): Promise<GitHubReviewObservation>;
  observeFileComment(
    token: string,
    repo: string,
    pr: number,
    intent: GitHubFileCommentIntent,
    signal?: AbortSignal,
  ): ReturnType<typeof findGitHubFileCommentByMarker>;
  publishFileComment(
    token: string,
    repo: string,
    pr: number,
    intent: GitHubFileCommentIntent,
    signal?: AbortSignal,
  ): ReturnType<typeof publishGitHubFileComment>;
  observeReviewComment(
    token: string,
    repo: string,
    intent: GitHubReviewCommentUpdateIntent,
    signal?: AbortSignal,
  ): ReturnType<typeof observeGitHubReviewComment>;
  updateReviewComment(
    token: string,
    repo: string,
    intent: GitHubReviewCommentUpdateIntent,
    signal?: AbortSignal,
  ): ReturnType<typeof updateGitHubReviewComment>;
  updateReviewSummary(
    token: string,
    repo: string,
    pr: number,
    reviewId: string,
    headSha: string,
    marker: string,
    body: string,
    signal?: AbortSignal,
  ): ReturnType<typeof updateGitHubReviewSummary>;
  observeCheck(
    token: string,
    repo: string,
    intent: GitHubCheckRunStartIntent,
    signal?: AbortSignal,
  ): ReturnType<typeof findGitHubCheckRunByExternalId>;
  createCheck(
    token: string,
    repo: string,
    intent: GitHubCheckRunStartIntent,
    signal?: AbortSignal,
  ): ReturnType<typeof createGitHubCheckRun>;
  completeCheck(
    token: string,
    repo: string,
    intent: GitHubCheckRunCompletionIntent,
    signal?: AbortSignal,
  ): ReturnType<typeof completeGitHubCheckRun>;
  observeCheckCompletion(
    token: string,
    repo: string,
    intent: GitHubCheckRunCompletionIntent,
    signal?: AbortSignal,
  ): Promise<GitHubCheckRunCompletionObservation>;
}

export interface ExecuteGitHubPublicationOperationInput {
  readonly store: GitHubPublicationOperationStore;
  readonly token: string;
  readonly appId: number;
  readonly claimOwner: string;
  readonly leaseDurationMs?: number;
  readonly adapters?: GitHubPublicationAdapters;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly leaseId?: () => string;
}

export type GitHubPublicationContinuation =
  | { readonly status: "idle"; readonly shouldContinue: false }
  | {
      readonly status: "applied" | "skipped" | "rejected" | "unknown";
      readonly shouldContinue: boolean;
      readonly operationKey: string;
      readonly publicationGeneration: string;
    };

export class GitHubPublicationOperationValidationError extends Error {
  override name = "GitHubPublicationOperationValidationError";
  constructor(reason: string) {
    super(`GitHub publication operation rejected before dispatch: ${reason}`);
  }
}

const productionAdapters: GitHubPublicationAdapters = {
  observeReview: observeGitHubCompositeReviewByMarker,
  publishReview: publishGitHubCompositeReview,
  observeFileComment: findGitHubFileCommentByMarker,
  publishFileComment: publishGitHubFileComment,
  observeReviewComment: observeGitHubReviewComment,
  updateReviewComment: updateGitHubReviewComment,
  updateReviewSummary: updateGitHubReviewSummary,
  observeCheck: findGitHubCheckRunByExternalId,
  createCheck: createGitHubCheckRun,
  completeCheck: completeGitHubCheckRun,
  observeCheckCompletion: observeGitHubCheckRunCompletion,
};

/** Claim and execute at most one durable GitHub publication operation. */
export async function executeOneGitHubPublicationOperation(
  input: ExecuteGitHubPublicationOperationInput,
): Promise<GitHubPublicationContinuation> {
  validateExecutorInput(input);
  const adapters = input.adapters ?? productionAdapters;
  const now = input.now ?? (() => new Date());
  const ambiguous = await input.store.loadOneAmbiguous();
  if (ambiguous !== null) {
    return reconcileAmbiguousOperation(input, ambiguous, adapters, now);
  }
  const leaseDurationMs = input.leaseDurationMs ?? 60_000;
  const leaseId = input.leaseId?.() ?? randomUUID();
  const claim = await input.store.claimOneEligible({
    claimOwner: input.claimOwner,
    leaseId,
    leaseDurationMs,
  });
  if (claim === null) return { status: "idle", shouldContinue: false };

  let validated: ValidatedClaim;
  try {
    validated = validateClaim(claim, input.claimOwner, leaseId, leaseDurationMs);
  } catch (error) {
    const reason = safeError(error);
    const evidence = terminalEvidence(claim, "validation", "rejected", {
      reason,
      dispatched: false,
    }, now(), { classification: undefined });
    await input.store.finishRejected(claim, evidence);
    throw error;
  }

  let activation: ActivationDecision;
  try {
    activation = await evaluateActivation(
      validated,
      input.token,
      input.appId,
      adapters,
      input.signal,
    );
  } catch (error) {
    if (error instanceof GitHubPublicationOperationValidationError) {
      const evidence = terminalEvidence(claim, "activation", "rejected", {
        reason: safeError(error),
        dispatched: false,
      }, now(), {});
      await input.store.finishRejected(claim, evidence);
      throw error;
    }
    await input.store.finishNotDispatched(claim, {
      ...dispatchEvidence(claim, "activation-observation", now()),
      errorReason: safeError(error),
    });
    return continuation("unknown", claim, false);
  }

  if (!activation.execute) {
    const evidence = terminalEvidence(
      claim,
      activation.variant,
      activation.outcome,
      activation.result,
      now(),
      { remoteId: activation.remoteId, remoteOperationId: activation.remoteId },
    );
    const finished = await input.store.finishNotRequired(claim, evidence);
    if (!finished) {
      await input.store.retainLeaseLossAfterDispatch(claim, {
        ...dispatchEvidence(claim, activation.variant, now()),
        errorReason: "publication lease was lost before no-write finalization",
        observedResult: activation.result,
      });
      return continuation("unknown", claim, false);
    }
    return continuation("skipped", claim, true);
  }

  if (claim.retryAuthorization.kind === "exactAbsence") {
    let retryObservation: AmbiguousRemoteObservation;
    try {
      retryObservation = await observeAmbiguousRemoteState(
        validated,
        input.token,
        input.appId,
        adapters,
        input.signal,
      );
    } catch (error) {
      await input.store.finishNotDispatched(claim, {
        ...dispatchEvidence(claim, "retry-observation", now()),
        errorReason: safeError(error),
      });
      return continuation("unknown", claim, false);
    }
    if (retryObservation.state === "applied") {
      const evidence = terminalEvidence(
        claim,
        "retry-reconciled",
        retryObservation.outcome,
        retryObservation.result,
        now(),
        {
          remoteId: retryObservation.remoteId,
          remoteOperationId: retryObservation.remoteOperationId ?? retryObservation.remoteId,
        },
      );
      const finished = await input.store.finishNotRequired(claim, evidence);
      return continuation(finished ? "skipped" : "unknown", claim, finished);
    }
    if (retryObservation.state === "conflict") {
      await input.store.finishNotDispatched(claim, {
        ...dispatchEvidence(claim, "retry-conflict", now()),
        errorReason: "exact remote state does not permit an automatic retry",
      });
      return continuation("unknown", claim, false);
    }
  }

  const dispatched = dispatchEvidence(claim, activation.variant, now());
  if (!await input.store.recordDispatched(claim, dispatched)) {
    return continuation("unknown", claim, false);
  }

  try {
    const result = await executeMutation(
      validated,
      activation,
      input.token,
      input.appId,
      adapters,
      input.signal,
    );
    const evidence = terminalEvidence(
      claim,
      activation.variant,
      result.outcome,
      result.result,
      now(),
      { remoteId: result.remoteId, remoteOperationId: result.remoteOperationId ?? result.remoteId },
    );
    if (!await input.store.finishApplied(claim, evidence)) {
      await input.store.retainLeaseLossAfterDispatch(claim, {
        ...dispatched,
        observedAt: now(),
        errorReason: "publication lease was lost after an observed forge result",
        observedResult: result.result,
      });
      return continuation("unknown", claim, false);
    }
    return continuation("applied", claim, true);
  } catch (error) {
    if (error instanceof GitHubReviewPlacementRejectedError) {
      const evidence = terminalEvidence(
        claim,
        activation.variant,
        "rejected",
        { classification: "invalidReviewCommentPlacement", httpStatus: 422 },
        now(),
        { httpStatus: 422, classification: "invalidReviewCommentPlacement" },
      );
      if (!await input.store.finishRejected(claim, evidence)) {
        await input.store.retainLeaseLossAfterDispatch(claim, {
          ...dispatched,
          observedAt: now(),
          errorReason: "publication lease was lost after a semantic forge rejection",
          observedResult: evidence.result,
        });
        return continuation("unknown", claim, false);
      }
      return continuation("rejected", claim, true);
    }
    if (error instanceof GitHubPublicationRejectedError && error.status < 500) {
      const evidence = terminalEvidence(
        claim,
        activation.variant,
        "rejected",
        { httpStatus: error.status },
        now(),
        { httpStatus: error.status },
      );
      if (await input.store.finishRejected(claim, evidence)) {
        return continuation("rejected", claim, true);
      }
    }
    const ambiguous = {
      ...dispatched,
      observedAt: now(),
      errorReason: safeError(error),
    };
    if (!await input.store.finishAmbiguous(claim, ambiguous)) {
      await input.store.retainLeaseLossAfterDispatch(claim, ambiguous);
    }
    return continuation("unknown", claim, false);
  }
}

async function reconcileAmbiguousOperation(
  input: ExecuteGitHubPublicationOperationInput,
  ambiguous: AmbiguousGitHubPublicationOperation,
  adapters: GitHubPublicationAdapters,
  now: () => Date,
): Promise<GitHubPublicationContinuation> {
  const validated = validateAmbiguousOperation(ambiguous);
  if (hasDefinitiveRejectedMutation(ambiguous.ambiguityEvidence)) {
    return continuation("unknown", ambiguous, false);
  }
  let observation: AmbiguousRemoteObservation;
  try {
    observation = await observeAmbiguousRemoteState(
      validated,
      input.token,
      input.appId,
      adapters,
      input.signal,
    );
  } catch {
    return continuation("unknown", ambiguous, false);
  }
  if (observation.state === "conflict") {
    return continuation("unknown", ambiguous, false);
  }
  if (observation.state === "applied") {
    const evidence = terminalEvidence(
      ambiguous,
      "ambiguity-reconciliation",
      observation.outcome,
      observation.result,
      now(),
      {
        remoteId: observation.remoteId,
        remoteOperationId: observation.remoteOperationId ?? observation.remoteId,
      },
    );
    const finished = await input.store.finishReconciledApplied(
      ambiguous,
      evidence,
    );
    return continuation(finished ? "applied" : "unknown", ambiguous, finished);
  }
  const result = JSON.parse(JSON.stringify(observation.result)) as JsonObject;
  const evidence = {
    ...dispatchEvidence(ambiguous, "ambiguity-exact-absence", now()),
    result,
    resultDigest: digestPrefixed(Buffer.from(canonicalJson(result))),
  };
  const finished = await input.store.finishReconciledRetry(ambiguous, evidence);
  return continuation("unknown", ambiguous, finished);
}

function hasDefinitiveRejectedMutation(
  evidence: Readonly<JsonObject> | undefined,
): boolean {
  if (evidence === undefined) return false;
  const observed = evidence.observedResult;
  return isObject(observed) &&
    Number.isSafeInteger(observed.httpStatus) &&
    (observed.httpStatus as number) >= 400 &&
    (observed.httpStatus as number) < 500;
}

type AmbiguousRemoteObservation =
  | {
      readonly state: "applied";
      readonly outcome: PublicationTerminalOutcome;
      readonly result: JsonObject;
      readonly remoteId: string;
      readonly remoteOperationId?: string;
    }
  | { readonly state: "retryable"; readonly result: JsonObject }
  | { readonly state: "conflict"; readonly result: JsonObject };

async function observeAmbiguousRemoteState(
  validated: ValidatedClaim,
  token: string,
  appId: number,
  adapters: GitHubPublicationAdapters,
  signal?: AbortSignal,
): Promise<AmbiguousRemoteObservation> {
  const activation = await evaluateActivation(
    validated,
    token,
    appId,
    adapters,
    signal,
  );
  if (!activation.execute) {
    if (
      activation.remoteId !== undefined ||
      activation.outcome === "notRequiredContentExact" ||
      activation.outcome === "notRequiredMarkerPresent"
    ) {
      const remoteId = activation.remoteId ?? exactRemoteId(activation.result);
      if (remoteId === undefined) {
        return { state: "conflict", result: activation.result };
      }
      return {
        state: "applied",
        outcome: activation.outcome,
        result: activation.result,
        remoteId,
      };
    }
    return { state: "conflict", result: activation.result };
  }

  if (validated.kind === "reviewSummaryUpdate") {
    if (
      activation.selectedReview?.remoteId === undefined ||
      activation.selectedBody === undefined
    ) {
      return { state: "conflict", result: { reason: "review identity is unavailable" } };
    }
    const marker = extractMarker(activation.selectedBody, "review");
    const observed = await adapters.observeReview(
      token,
      validated.claim.repositoryFullName,
      validated.claim.pullRequestNumber,
      marker,
      validated.claim.headSha,
      [],
      signal,
    );
    if (observed === null || observed.reviewId !== activation.selectedReview.remoteId) {
      return { state: "conflict", result: { reason: "review identity is unavailable" } };
    }
    if (observed.body === activation.selectedBody) {
      return {
        state: "applied",
        outcome: "applied",
        result: { reviewId: observed.reviewId, body: observed.body },
        remoteId: observed.reviewId,
      };
    }
    return {
      state: "retryable",
      result: {
        desiredState: "absent",
        observedBodyDigest: digestPrefixed(Buffer.from(observed.body)),
      },
    };
  }

  if (
    validated.kind === "advisoryCheckComplete" ||
    validated.kind === "gateCheckComplete"
  ) {
    const createKey = checkCreateDependencyKey(validated.operation);
    const create = dependency(validated, createKey);
    if (create.remoteId === undefined) {
      return { state: "conflict", result: { reason: "check identity is unavailable" } };
    }
    const intent = checkCompletionIntent(
      validated.operation,
      appId,
      create.remoteId,
      immutableCheckCreationExternalId(validated, createKey, appId),
    );
    const observed = await adapters.observeCheckCompletion(
      token,
      validated.claim.repositoryFullName,
      intent,
      signal,
    );
    if (observed.desiredState === "applied") {
      return {
        state: "applied",
        outcome: "applied",
        result: { ...observed },
        remoteId: observed.checkRunId,
      };
    }
    return observed.desiredState === "retryable"
      ? { state: "retryable", result: { ...observed } }
      : { state: "conflict", result: { ...observed } };
  }

  return {
    state: "retryable",
    result: { desiredState: "exactlyAbsent", operationKey: validated.claim.operationKey },
  };
}

function exactRemoteId(result: JsonObject): string | undefined {
  for (const key of ["reviewId", "commentId", "checkRunId"]) {
    const value = result[key];
    if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)) {
      return value;
    }
  }
  return undefined;
}

type GitHubPublicationOperationSnapshot =
  | ClaimedGitHubPublicationOperation
  | AmbiguousGitHubPublicationOperation;

interface ValidatedClaim {
  claim: GitHubPublicationOperationSnapshot;
  operation: JsonObject;
  kind: string;
  manifest: GitHubPublicationControllerManifest;
  plan: GitHubPublicationPlan;
  dependencies: Map<string, DurablePublicationDependencyEvidence>;
}

interface ActivationDecision {
  execute: boolean;
  variant: string;
  outcome: PublicationTerminalOutcome;
  result: JsonObject;
  remoteId?: string;
  selectedReview?: DurablePublicationDependencyEvidence;
  selectedBody?: string;
}

interface MutationResult {
  outcome: PublicationTerminalOutcome;
  result: JsonObject;
  remoteId?: string;
  remoteOperationId?: string;
}

function validateClaim(
  claim: ClaimedGitHubPublicationOperation,
  expectedOwner: string,
  expectedLeaseId: string,
  expectedLeaseDurationMs: number,
): ValidatedClaim {
  if (
    claim.databaseEligibility.currentSealedHighWater !== true ||
    claim.databaseEligibility.dependenciesEligible !== true ||
    claim.databaseEligibility.mutuallyExclusive !== true
  ) reject("database claim did not prove current high-water eligibility");
  if (
    claim.claimOwner !== expectedOwner ||
    claim.leaseId !== expectedLeaseId ||
    !UUID.test(claim.leaseId) ||
    !Number.isSafeInteger(claim.attemptNumber) || claim.attemptNumber < 1 ||
    !Number.isSafeInteger(claim.leaseGeneration) || claim.leaseGeneration < 1 ||
    claim.selectedVariant !== claim.kind
  ) reject("database claim does not match the requested lease identity");
  if (
    !Number.isFinite(claim.claimedAt.getTime()) ||
    claim.leaseExpiresAt.getTime() <= claim.claimedAt.getTime() ||
    claim.leaseExpiresAt.getTime() - claim.claimedAt.getTime() > expectedLeaseDurationMs + 1_000
  ) reject("publication lease is invalid");
  validateRetryAuthorization(claim);
  return validateSnapshot(claim);
}

function validateAmbiguousOperation(
  operation: AmbiguousGitHubPublicationOperation,
): ValidatedClaim {
  if (
    !Number.isSafeInteger(operation.attemptNumber) || operation.attemptNumber < 1 ||
    !Number.isSafeInteger(operation.leaseGeneration) || operation.leaseGeneration < 1 ||
    operation.selectedVariant !== operation.kind ||
    !Number.isFinite(operation.ambiguousObservedAt.getTime()) ||
    operation.errorReason.length === 0
  ) reject("ambiguous operation lineage is invalid");
  return validateSnapshot(operation);
}

function validateSnapshot(
  claim: GitHubPublicationOperationSnapshot,
): ValidatedClaim {
  if (!OPERATION_KEY.test(claim.operationKey) || !SUPPORTED_KINDS.has(claim.kind)) {
    reject("operation key or kind is unsupported");
  }
  if (claim.acceptedPlanBytes.byteLength > MAX_ARTIFACT_BYTES || claim.controllerManifestBytes.byteLength > MAX_ARTIFACT_BYTES) {
    reject("generation artifacts exceed their byte limits");
  }
  if (
    claim.controllerRecordBytes.byteLength < 2 ||
    claim.controllerRecordBytes.byteLength > MAX_CONTROLLER_RECORD_BYTES ||
    claim.operationRecordBytes.byteLength < 2 ||
    claim.operationRecordBytes.byteLength > MAX_OPERATION_RECORD_BYTES ||
    claim.activationBytes.byteLength < 2 ||
    claim.activationBytes.byteLength > MAX_OPERATION_COMPONENT_BYTES ||
    claim.desiredPayloadBytes.byteLength < 2 ||
    claim.desiredPayloadBytes.byteLength > MAX_OPERATION_COMPONENT_BYTES
  ) reject("operation artifacts exceed their byte limits");
  if (!RAW_SHA256.test(claim.acceptedPlanDigest) || digestRaw(claim.acceptedPlanBytes) !== claim.acceptedPlanDigest) {
    reject("accepted plan bytes do not match their digest");
  }
  const accepted = parseGitHubPublicationPlanBytes(claim.acceptedPlanBytes, claim.expectedPlan);
  if (accepted.digest !== claim.acceptedPlanDigest) reject("accepted plan digest changed during validation");

  const manifestValue = parseJsonObject(claim.controllerManifestBytes, "controller manifest");
  const complete = requireObject(
    requireArray(manifestValue.operations, "controller operations").at(-1),
    "gate completion controller record",
  );
  const completeOperation = requireObject(complete.operation, "gate completion operation");
  if (completeOperation.kind !== "gateCheckComplete") reject("controller manifest has no terminal gate completion");
  const gatePayload = requireObject(completeOperation.payload, "gate completion payload");
  const dependencies = requireStringArray(completeOperation.dependencies, "gate completion dependencies");
  const createReference = requireObject(completeOperation.remoteId, "gate completion remote identity");
  const createOperationKey = requireString(createReference.operationKey, "gate creation reference");
  const rebuilt = buildGitHubPublicationControllerManifest({
    acceptedPlan: accepted.value,
    acceptedPlanBytesDigest: `sha256:${accepted.digest}`,
    requiredTerminalOperationKeys: dependencies.filter((key) => key !== createOperationKey),
    gateOutput: {
      conclusion: requireConclusion(gatePayload.conclusion),
      title: requireString(gatePayload.title, "gate title"),
      summary: requireString(gatePayload.summary, "gate summary"),
      detailsUrl: requireString(gatePayload.detailsUrl, "gate details URL"),
    },
  });
  if (!SHA256.test(claim.controllerManifestDigest) || rebuilt.digest !== claim.controllerManifestDigest) {
    reject("controller manifest digest does not match the accepted generation");
  }
  if (!bytesEqual(rebuilt.bytes, claim.controllerManifestBytes)) {
    reject("controller manifest bytes are not the authoritative canonical manifest");
  }
  const manifest = rebuilt.value;
  const record = manifest.operations[claim.operationOrdinal - 1];
  if (record === undefined || record.source !== claim.operationSource) reject("controller operation source or ordinal differs");
  if (!bytesEqual(rebuilt.operationBytes[claim.operationOrdinal - 1]!, claim.controllerRecordBytes)) {
    reject("controller record bytes differ from the sealed manifest");
  }
  const operation = (record.source === "cli"
    ? accepted.value.operations[claim.operationOrdinal - 1]
    : record.operation) as JsonObject;
  if (operation.operationKey !== claim.operationKey || operation.kind !== claim.kind) {
    reject("operation identity differs from the sealed controller record");
  }
  if (!bytesEqual(Buffer.from(JSON.stringify(operation)), claim.operationRecordBytes)) {
    reject("operation record bytes are not exact");
  }
  const activation = requireObject(operation.activation, "operation activation");
  if (!bytesEqual(Buffer.from(JSON.stringify(activation)), claim.activationBytes)) {
    reject("activation bytes are not exact");
  }
  const desired = operationDesired(operation);
  if (!bytesEqual(Buffer.from(JSON.stringify(desired)), claim.desiredPayloadBytes)) {
    reject("desired payload bytes are not exact");
  }
  if (!SHA256.test(claim.desiredPayloadDigest) || digestPrefixed(claim.desiredPayloadBytes) !== claim.desiredPayloadDigest) {
    reject("desired payload digest is invalid");
  }
  if (operation.desiredDigest !== claim.desiredPayloadDigest) reject("operation desired digest differs from stored bytes");
  if (
    manifest.repository.id !== claim.repositoryId ||
    manifest.repository.fullName !== claim.repositoryFullName ||
    Number(manifest.pullRequestNumber) !== claim.pullRequestNumber ||
    manifest.controllerGeneration !== claim.publicationGeneration ||
    manifest.headSha !== claim.headSha ||
    accepted.value.reviewedSnapshot.headSha !== claim.headSha
  ) reject("generation, repository, pull request, or head identity differs");

  const expectedDependencies = requireStringArray(operation.dependencies, "operation dependencies");
  const evidence = new Map<string, DurablePublicationDependencyEvidence>();
  for (const dependency of claim.dependencies) {
    if (evidence.has(dependency.operationKey)) reject("dependency evidence is duplicated");
    if (!expectedDependencies.includes(dependency.operationKey)) reject("undeclared dependency evidence was supplied");
    if (digestPrefixed(Buffer.from(canonicalJson(dependency.result))) !== dependency.resultDigest) {
      reject("dependency result evidence digest is invalid");
    }
    if (
      !SHA256.test(dependency.resultDigest) ||
      !Number.isSafeInteger(dependency.attemptNumber) || dependency.attemptNumber < 0 ||
      !Number.isSafeInteger(dependency.leaseGeneration) || dependency.leaseGeneration < 0 ||
      !Number.isFinite(dependency.observedAt.getTime()) ||
      (dependency.remoteId !== undefined && !REMOTE_ID.test(dependency.remoteId)) ||
      (dependency.remoteOperationId !== undefined && !REMOTE_ID.test(dependency.remoteOperationId)) ||
      (dependency.classification === "invalidReviewCommentPlacement" && dependency.httpStatus !== 422)
    ) reject("dependency lifecycle evidence is invalid");
    evidence.set(dependency.operationKey, dependency);
  }
  if (expectedDependencies.some((key) => !evidence.has(key))) reject("declared dependency evidence is missing");
  return { claim, operation, kind: claim.kind, manifest, plan: accepted.value, dependencies: evidence };
}

async function evaluateActivation(
  validated: ValidatedClaim,
  token: string,
  appId: number,
  adapters: GitHubPublicationAdapters,
  signal?: AbortSignal,
): Promise<ActivationDecision> {
  const conditions = requireArray(
    requireObject(validated.operation.activation, "activation").anyOf,
    "activation alternatives",
  );
  const decisions: ActivationDecision[] = [];
  for (const raw of conditions) {
    const condition = requireObject(raw, "activation condition");
    decisions.push(await evaluateCondition(validated, condition, token, appId, adapters, signal));
  }
  const executable = decisions.filter((decision) => decision.execute);
  if (executable.length > 1) reject("multiple activation alternatives are simultaneously executable");
  if (executable.length === 1) return executable[0]!;
  const observed = decisions.find((decision) => decision.remoteId !== undefined);
  return observed ?? {
    execute: false,
    variant: "not-required",
    outcome: "notRequiredMarkerPresent",
    result: { reason: "no activation alternative is satisfied" },
  };
}

async function evaluateCondition(
  validated: ValidatedClaim,
  condition: JsonObject,
  token: string,
  appId: number,
  adapters: GitHubPublicationAdapters,
  signal?: AbortSignal,
): Promise<ActivationDecision> {
  switch (condition.condition) {
    case "always": {
      const existing = await observeCreateIdentity(validated, token, appId, adapters, signal);
      return existing ?? executeDecision("always");
    }
    case "markerAbsent": {
      const existing = await observeMarkerGuard(validated, requireObject(condition.guard, "marker guard"), token, adapters, signal);
      return existing ?? executeDecision("marker-absent");
    }
    case "semanticPlacementRejected": {
      const dependencyEvidence = dependency(validated, condition.dependencyOperationKey);
      const rejected = dependencyEvidence.outcome === "rejected" && dependencyEvidence.httpStatus === 422 &&
        dependencyEvidence.classification === "invalidReviewCommentPlacement";
      if (!rejected) return notActivated("semantic placement rejection was not proven");
      const existing = await observeMarkerGuard(validated, requireObject(condition.markerAbsence, "placement marker guard"), token, adapters, signal);
      return existing ?? executeDecision("semantic-422-fallback");
    }
    case "partialReviewObserved": {
      const dependencyEvidence = dependency(validated, condition.dependencyOperationKey);
      if (dependencyEvidence.outcome !== "partialObserved" || dependencyEvidence.remoteId === undefined) {
        return notActivated("partial review evidence is absent");
      }
      const reviewMarkers = requireStringArray(condition.reviewMarkers, "review markers");
      const reviewMarker = reviewMarkers.find((marker) => markerKind(marker) === "review");
      if (reviewMarker === undefined) reject("partial review condition has no review marker");
      const guard = requireObject(condition.findingMarkerAbsence, "finding marker guard");
      const findingMarkers = requireStringArray(guard.markers, "finding markers");
      const observation = await adapters.observeReview(
        token,
        validated.claim.repositoryFullName,
        validated.claim.pullRequestNumber,
        reviewMarker,
        validated.claim.headSha,
        findingMarkers,
        signal,
      );
      if (observation === null || observation.reviewId !== dependencyEvidence.remoteId) {
        reject("durable partial-review evidence contradicts the live review identity");
      }
      if (findingMarkers.some((marker) => !observation.missingCommentMarkers.includes(marker))) {
        return {
          execute: false,
          variant: "partial-review-marker-present",
          outcome: "notRequiredMarkerPresent",
          result: { reviewId: observation.reviewId },
          remoteId: observation.reviewId,
        };
      }
      return executeDecision("partial-review-fallback");
    }
    case "findingContentDiffers": {
      const operation = validated.operation;
      const intent = reviewCommentUpdateIntent(operation, validated.claim.headSha, findingPath(validated, operation));
      const observed = await adapters.observeReviewComment(token, validated.claim.repositoryFullName, intent, signal);
      if (observed.commentId !== requireString(condition.observedCommentId, "observed comment identity")) {
        reject("live finding comment identity differs from the activation guard");
      }
      if (observed.body === intent.body) {
        return {
          execute: false,
          variant: "content-already-exact",
          outcome: "notRequiredContentExact",
          result: { commentId: observed.commentId, bodyDigest: digestPrefixed(Buffer.from(observed.body)) },
          remoteId: observed.commentId,
        };
      }
      return executeDecision("finding-content-differs");
    }
    case "reviewSelectionTerminal": {
      const selectedKeys = requireStringArray(condition.selectedReviewOperationKeys, "review selection keys");
      const candidates = selectedKeys.map((key) => dependency(validated, key)).filter((entry) =>
        entry.remoteId !== undefined && ["created", "reconciledExisting", "partialObserved"].includes(entry.outcome)
      );
      if (candidates.length !== 1) reject("review selection does not have one exact terminal review identity");
      const selected = candidates[0]!;
      const operation = validated.operation;
      const cases = requireArray(operation.cases, "review summary cases").map((entry) => requireObject(entry, "review summary case"));
      const fileCount = requireArray(operation.terminalOperations, "summary terminal operations")
        .map((entry) => requireObject(entry, "summary terminal operation"))
        .filter((entry) => entry.findingId !== undefined)
        .filter((entry) => {
          const evidence = dependency(validated, entry.operationKey);
          return (requireStringArray(entry.acceptedOutcomes, "accepted outcomes") as string[]).includes(evidence.outcome);
        }).length;
      const matching = cases.filter((entry) =>
        entry.selectedReviewOperationKey === selected.operationKey &&
        requireStringArray(entry.selectedReviewOutcomes, "selected review outcomes").includes(selected.outcome) &&
        entry.fileCommentCount === fileCount
      );
      if (matching.length !== 1) reject("review summary has no unique case for durable dependency evidence");
      return {
        ...executeDecision("review-selection-terminal"),
        selectedReview: selected,
        selectedBody: requireString(matching[0]!.body, "selected review summary body"),
      };
    }
    case "allDependenciesTerminal":
      if ([...validated.dependencies.values()].some((entry) => !["applied", "skipped", "failed", "superseded"].includes(entry.state))) {
        reject("gate completion dependency is not terminal");
      }
      return executeDecision("all-dependencies-terminal");
    default:
      reject("activation condition is unsupported");
  }
}

async function observeCreateIdentity(
  validated: ValidatedClaim,
  token: string,
  appId: number,
  adapters: GitHubPublicationAdapters,
  signal?: AbortSignal,
): Promise<ActivationDecision | null> {
  if (validated.kind === "reviewCreate") {
    const intent = compositeReviewIntent(validated.operation);
    const observation = await adapters.observeReview(
      token,
      validated.claim.repositoryFullName,
      validated.claim.pullRequestNumber,
      intent.marker,
      intent.commitId,
      intent.comments.map((comment) => comment.marker),
      signal,
    );
    if (observation === null) return null;
    return existingDecision(observation.reviewId, observation);
  }
  if (validated.kind === "fileCommentFallback") {
    const intent = fileCommentIntent(validated.operation);
    const observation = await adapters.observeFileComment(token, validated.claim.repositoryFullName, validated.claim.pullRequestNumber, intent, signal);
    return observation === null ? null : existingDecision(observation.commentId, observation);
  }
  if (validated.kind === "advisoryCheckCreate" || validated.kind === "gateCheckCreate") {
    const intent = checkStartIntent(validated.operation, appId);
    const observation = await adapters.observeCheck(token, validated.claim.repositoryFullName, intent, signal);
    return observation === null ? null : existingDecision(observation.checkRunId, observation);
  }
  return null;
}

async function observeMarkerGuard(
  validated: ValidatedClaim,
  guard: JsonObject,
  token: string,
  adapters: GitHubPublicationAdapters,
  signal?: AbortSignal,
): Promise<ActivationDecision | null> {
  if (guard.required !== true || guard.headSha !== validated.claim.headSha) reject("marker guard identity is invalid");
  const markers = requireStringArray(guard.markers, "marker guard markers");
  if (validated.kind === "reviewCreate") {
    const intent = compositeReviewIntent(validated.operation);
    const reviewMarker = markers.find((marker) => markerKind(marker) === "review") ?? intent.marker;
    const findingMarkers = markers.filter((marker) => markerKind(marker) === "finding");
    const observation = await adapters.observeReview(token, validated.claim.repositoryFullName, validated.claim.pullRequestNumber, reviewMarker, validated.claim.headSha, findingMarkers, signal);
    return observation === null ? null : existingDecision(observation.reviewId, observation);
  }
  if (validated.kind === "fileCommentFallback") {
    const intent = fileCommentIntent(validated.operation);
    if (!markers.includes(intent.marker)) reject("file comment marker guard differs from the immutable intent");
    const observation = await adapters.observeFileComment(token, validated.claim.repositoryFullName, validated.claim.pullRequestNumber, intent, signal);
    return observation === null ? null : existingDecision(observation.commentId, observation);
  }
  reject("marker-absence activation is unsupported for this operation kind");
}

async function executeMutation(
  validated: ValidatedClaim,
  activation: ActivationDecision,
  token: string,
  appId: number,
  adapters: GitHubPublicationAdapters,
  signal?: AbortSignal,
): Promise<MutationResult> {
  const repo = validated.claim.repositoryFullName;
  const pr = validated.claim.pullRequestNumber;
  switch (validated.kind) {
    case "reviewCreate": {
      const intent = compositeReviewIntent(validated.operation);
      const result = await adapters.publishReview(token, repo, pr, intent, signal);
      return {
        outcome: result.missingCommentMarkers.length > 0 ? "partialObserved" : "created",
        remoteId: result.reviewId,
        remoteOperationId: result.reviewId,
        result: {
          reviewId: result.reviewId,
          commentIdsByMarker: result.commentIdsByMarker,
          missingCommentMarkers: result.missingCommentMarkers,
        },
      };
    }
    case "fileCommentFallback": {
      const result = await adapters.publishFileComment(token, repo, pr, fileCommentIntent(validated.operation), signal);
      return { outcome: "created", remoteId: result.commentId, result: { ...result } };
    }
    case "findingCommentUpdate": {
      const result = await adapters.updateReviewComment(
        token,
        repo,
        reviewCommentUpdateIntent(validated.operation, validated.claim.headSha, findingPath(validated, validated.operation)),
        signal,
      );
      return { outcome: "applied", remoteId: result.commentId, result: { ...result } };
    }
    case "reviewSummaryUpdate": {
      if (activation.selectedReview?.remoteId === undefined || activation.selectedBody === undefined) reject("summary execution has no selected review identity");
      const marker = extractMarker(activation.selectedBody, "review");
      const result = await adapters.updateReviewSummary(token, repo, pr, activation.selectedReview.remoteId, validated.claim.headSha, marker, activation.selectedBody, signal);
      return { outcome: "applied", remoteId: result.reviewId, result };
    }
    case "advisoryCheckCreate":
    case "gateCheckCreate": {
      const remoteId = await adapters.createCheck(token, repo, checkStartIntent(validated.operation, appId), signal);
      return { outcome: "created", remoteId, result: { checkRunId: remoteId } };
    }
    case "advisoryCheckComplete":
    case "gateCheckComplete": {
      const createKey = checkCreateDependencyKey(validated.operation);
      const create = dependency(validated, createKey);
      if (create.remoteId === undefined) reject("check completion dependency has no exact remote identity");
      const externalId = immutableCheckCreationExternalId(validated, createKey, appId);
      const intent = checkCompletionIntent(validated.operation, appId, create.remoteId, externalId);
      await adapters.completeCheck(token, repo, intent, signal);
      return { outcome: "applied", remoteId: create.remoteId, result: { checkRunId: create.remoteId, conclusion: intent.conclusion } };
    }
    default:
      reject("operation kind is unsupported");
  }
}

function compositeReviewIntent(operation: JsonObject): GitHubCompositeReviewIntent {
  const payload = requireObject(operation.payload, "review payload");
  const body = requireString(payload.body, "review body");
  const comments = payload.comments === undefined ? [] : requireArray(payload.comments, "review comments").map((entry) => {
    const comment = requireObject(entry, "review comment");
    return {
      path: requireString(comment.path, "review comment path"),
      line: requirePositiveInteger(comment.line, "review comment line"),
      side: requireSide(comment.side),
      ...(comment.startLine === undefined ? {} : { startLine: requirePositiveInteger(comment.startLine, "review start line") }),
      ...(comment.startSide === undefined ? {} : { startSide: requireSide(comment.startSide) }),
      body: requireString(comment.body, "review comment body"),
      marker: extractMarker(requireString(comment.body, "review comment body"), "finding"),
    };
  });
  return {
    commitId: requireString(payload.commitId, "review commit"),
    body,
    marker: extractMarker(body, "review"),
    comments,
  };
}

function fileCommentIntent(operation: JsonObject): GitHubFileCommentIntent {
  const payload = requireObject(operation.payload, "file comment payload");
  const body = requireString(payload.body, "file comment body");
  return {
    commitId: requireString(payload.commitId, "file comment commit"),
    path: requireString(payload.path, "file comment path"),
    body,
    marker: extractMarker(body, "finding"),
  };
}

function reviewCommentUpdateIntent(operation: JsonObject, headSha: string, path: string): GitHubReviewCommentUpdateIntent {
  return {
    commentId: requireString(operation.observedCommentId, "observed comment identity"),
    commitId: headSha,
    path,
    expectedMarkers: requireStringArray(operation.expectedMarkers, "expected finding markers"),
    body: requireString(operation.body, "finding comment body"),
  };
}

function findingPath(validated: ValidatedClaim, operation: JsonObject): string {
  const findingId = requireString(operation.findingId, "finding identity");
  const finding = validated.plan.lifecycleReceipt.findings.find((entry) => entry.findingId === findingId);
  if (finding === undefined) reject("finding operation has no lifecycle receipt path");
  return finding.path;
}

function checkStartIntent(operation: JsonObject, appId: number): GitHubCheckRunStartIntent {
  const value = operation.kind === "gateCheckCreate" ? requireObject(operation.payload, "gate check payload") : operation;
  return {
    appId,
    name: requireCheckName(value.name),
    headSha: requireString(value.headSha, "check head SHA"),
    externalId: requireString(value.externalId ?? requireObject(operation.reconciliation, "check reconciliation").logicalIdentity, "check external identity"),
    ...(value.detailsUrl === undefined ? {} : { detailsUrl: requireString(value.detailsUrl, "check details URL") }),
  };
}

function checkCompletionIntent(
  operation: JsonObject,
  appId: number,
  checkRunId: string,
  externalId: string,
): GitHubCheckRunCompletionIntent {
  const value = operation.kind === "gateCheckComplete" ? requireObject(operation.payload, "gate completion payload") : operation;
  return {
    appId,
    name: requireCheckName(value.name),
    headSha: requireString(value.headSha, "check head SHA"),
    externalId,
    checkRunId,
    conclusion: requireConclusion(value.conclusion),
    title: requireString(value.title, "check title"),
    summary: requireString(value.summary, "check summary"),
    ...(value.detailsUrl === undefined ? {} : { detailsUrl: requireString(value.detailsUrl, "check details URL") }),
    ...(value.annotations === undefined ? {} : {
      annotations: requireArray(value.annotations, "check annotations").map((entry) => {
        const annotation = requireObject(entry, "check annotation");
        return {
          path: requireString(annotation.path, "annotation path"),
          startLine: requirePositiveInteger(annotation.startLine, "annotation start line"),
          endLine: requirePositiveInteger(annotation.endLine, "annotation end line"),
          annotationLevel: requireAnnotationLevel(annotation.annotationLevel),
          title: requireString(annotation.title, "annotation title"),
          message: requireString(annotation.message, "annotation message"),
        };
      }),
    }),
  };
}

function immutableCheckCreationExternalId(
  validated: ValidatedClaim,
  operationKey: string,
  appId: number,
): string {
  const record = validated.manifest.operations.find((entry) => entry.operation.operationKey === operationKey);
  if (record === undefined || (record.operation.kind !== "advisoryCheckCreate" && record.operation.kind !== "gateCheckCreate")) {
    reject("check completion dependency is not an immutable check creation");
  }
  return checkStartIntent(record.operation as JsonObject, appId).externalId;
}

function checkCreateDependencyKey(operation: JsonObject): string {
  if (operation.kind === "advisoryCheckComplete") {
    return requireString(requireObject(operation.createdCheck, "created advisory check").dependencyOperationKey, "advisory create dependency");
  }
  return requireString(requireObject(operation.remoteId, "gate remote identity").operationKey, "gate create dependency");
}

function dependency(validated: ValidatedClaim, value: unknown): DurablePublicationDependencyEvidence {
  const key = requireString(value, "dependency operation key");
  const evidence = validated.dependencies.get(key);
  if (evidence === undefined) reject("activation references missing durable dependency evidence");
  return evidence;
}

function executeDecision(variant: string): ActivationDecision {
  return { execute: true, variant, outcome: "applied", result: { activation: variant } };
}

function notActivated(reason: string): ActivationDecision {
  return { execute: false, variant: "not-activated", outcome: "notRequiredMarkerPresent", result: { reason } };
}

function existingDecision(remoteId: string, observation: object): ActivationDecision {
  return {
    execute: false,
    variant: "reconciled-existing",
    outcome: "reconciledExisting",
    result: JSON.parse(JSON.stringify(observation)) as JsonObject,
    remoteId,
  };
}

function dispatchEvidence(
  claim: GitHubPublicationOperationSnapshot,
  activationVariant: string,
  observedAt: Date,
): PublicationDispatchEvidence {
  return {
    requestDigest: claim.desiredPayloadDigest,
    operationKey: claim.operationKey,
    selectedVariant: claim.selectedVariant,
    activationVariant,
    observedAt,
  };
}

function terminalEvidence(
  claim: GitHubPublicationOperationSnapshot,
  activationVariant: string,
  outcome: PublicationTerminalOutcome,
  result: JsonObject,
  observedAt: Date,
  remote: {
    remoteId?: string;
    remoteOperationId?: string;
    httpStatus?: number;
    classification?: "invalidReviewCommentPlacement";
  },
): PublicationTerminalEvidence {
  const cleanResult = JSON.parse(JSON.stringify(result)) as JsonObject;
  return {
    ...dispatchEvidence(claim, activationVariant, observedAt),
    outcome,
    result: cleanResult,
    resultDigest: digestPrefixed(Buffer.from(canonicalJson(cleanResult))),
    ...(remote.remoteId === undefined ? {} : { remoteId: remote.remoteId }),
    ...(remote.remoteOperationId === undefined ? {} : { remoteOperationId: remote.remoteOperationId }),
    ...(remote.httpStatus === undefined ? {} : { httpStatus: remote.httpStatus }),
    ...(remote.classification === undefined ? {} : { classification: remote.classification }),
  };
}

function continuation(
  status: "applied" | "skipped" | "rejected" | "unknown",
  claim: GitHubPublicationOperationSnapshot,
  shouldContinue: boolean,
): GitHubPublicationContinuation {
  return { status, shouldContinue, operationKey: claim.operationKey, publicationGeneration: claim.publicationGeneration };
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

function parseJsonObject(bytes: Uint8Array, name: string): JsonObject {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject(`${name} is not valid UTF-8`);
  }
  try {
    return requireObject(JSON.parse(text), name);
  } catch (error) {
    if (error instanceof GitHubPublicationOperationValidationError) throw error;
    reject(`${name} is not valid JSON`);
  }
}

function extractMarker(body: string, kind: "review" | "finding"): string {
  const matches = body.match(/<!-- postil-(?:review|finding):v(?:1:[0-9a-f]{12}|2:[0-9a-f]{64}) -->/g) ?? [];
  const selected = matches.filter((marker) => markerKind(marker) === kind);
  if (selected.length !== 1) reject(`${kind} body does not contain one exact marker`);
  return selected[0]!;
}

function markerKind(marker: string): "review" | "finding" {
  const match = MARKER.exec(marker);
  if (match?.[1] !== "review" && match?.[1] !== "finding") reject("publication marker is malformed");
  return match[1];
}

function requireObject(value: unknown, name: string): JsonObject {
  if (!isObject(value)) reject(`${name} must be a plain object`);
  return value;
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) reject(`${name} must be an array`);
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  const array = requireArray(value, name);
  if (array.some((entry) => typeof entry !== "string")) reject(`${name} must contain strings`);
  return array as string[];
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) reject(`${name} must be a non-empty string`);
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) reject(`${name} must be a positive integer`);
  return value as number;
}

function requireSide(value: unknown): "LEFT" | "RIGHT" {
  if (value !== "LEFT" && value !== "RIGHT") reject("review comment side is invalid");
  return value;
}

function requireCheckName(value: unknown): "postil/review" | "postil/gate" {
  if (value !== "postil/review" && value !== "postil/gate") reject("check name is invalid");
  return value;
}

function requireConclusion(value: unknown): "success" | "failure" | "neutral" {
  if (value !== "success" && value !== "failure" && value !== "neutral") reject("check conclusion is invalid");
  return value;
}

function requireAnnotationLevel(value: unknown): "notice" | "warning" | "failure" {
  if (value !== "notice" && value !== "warning" && value !== "failure") reject("annotation level is invalid");
  return value;
}

function isObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("publication evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!isObject(value)) reject("publication evidence contains a non-JSON value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function digestRaw(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestPrefixed(bytes: Uint8Array): string {
  return `sha256:${digestRaw(bytes)}`;
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 4_000);
  return "unknown publication failure";
}

function validateExecutorInput(input: ExecuteGitHubPublicationOperationInput): void {
  if (!input.token || input.token.includes("\0")) throw new Error("GitHub publication token is missing");
  if (!Number.isSafeInteger(input.appId) || input.appId <= 0) throw new Error("GitHub App identity is invalid");
  if (!input.claimOwner || Buffer.byteLength(input.claimOwner) > 200) throw new Error("publication claim owner is invalid");
  const duration = input.leaseDurationMs ?? 60_000;
  if (!Number.isSafeInteger(duration) || duration < 5_000 || duration > 10 * 60_000) {
    throw new Error("publication lease duration is invalid");
  }
}

function validateRetryAuthorization(claim: ClaimedGitHubPublicationOperation): void {
  const authorization = claim.retryAuthorization;
  if (authorization.kind === "initial") {
    if (claim.attemptNumber !== 1 || claim.leaseGeneration !== 1) {
      reject("an initial claim must use the first attempt and lease generation");
    }
    return;
  }
  if (
    authorization.priorAttemptNumber !== claim.attemptNumber - 1 ||
    authorization.priorLeaseGeneration !== claim.leaseGeneration - 1 ||
    !SHA256.test(authorization.evidenceDigest)
  ) reject("retry authorization is not bound to the immediately preceding attempt");
  if (authorization.kind === "notDispatched") return;
  if (
    !Number.isFinite(authorization.observedAt.getTime()) ||
    authorization.observedAt.getTime() > claim.claimedAt.getTime()
  ) reject("exact-absence retry evidence is later than its claim");
}

function reject(reason: string): never {
  throw new GitHubPublicationOperationValidationError(reason);
}
