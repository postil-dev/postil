import type { Pool, PoolClient } from "pg";

import type { PublicationReceipt } from "@/lib/publication-receipt";
import type { JobLease, ReviewJobPayload } from "@/lib/queue";
import {
  executeOneGitHubPublicationOperation,
  type ExecuteGitHubPublicationOperationInput,
  type GitHubPublicationAdapters,
  type GitHubPublicationContinuation,
  type GitHubPublicationOperationStore,
} from "@/lib/github-publication-operation-executor";
import {
  PostgresGitHubPublicationOperationStore,
  type GitHubPublicationOperationScope,
} from "@/lib/github-publication-operation-store";
import {
  PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
  type PublicationControllerNoMutationProbe,
} from "@/lib/release-job-rollout";

export interface PublicationControllerClaimAuthority {
  releaseSha: string;
}

export function publicationControllerClaimAuthorityFailure(input: {
  payload: ReviewJobPayload;
  claim: PublicationControllerClaimAuthority;
  localReleaseSha: string | undefined;
}): string | null {
  if (!/^[0-9a-f]{40}$/u.test(input.claim.releaseSha)) {
    return "publication-controller claim release identity is malformed";
  }
  if (input.localReleaseSha !== input.claim.releaseSha) {
    return "publication-controller claim does not match the local release";
  }
  if (
    input.payload._postilPublicationControllerFence !== true ||
    input.payload._postilPublicationControllerReleaseSha !== input.claim.releaseSha
  ) {
    return "publication-controller claim does not match the durable queue authority";
  }
  return null;
}

export async function runPublicationControllerRecoveryIfAuthorized<T>(input: {
  payload: ReviewJobPayload;
  claim: PublicationControllerClaimAuthority | undefined;
  localReleaseSha: string | undefined;
  authorityError: (message: string) => Error;
  recover: () => Promise<T>;
}): Promise<T | null> {
  if (input.claim === undefined) return null;
  const failure = publicationControllerClaimAuthorityFailure({
    payload: input.payload,
    claim: input.claim,
    localReleaseSha: input.localReleaseSha,
  });
  if (failure) throw input.authorityError(failure);
  return input.recover();
}

export interface PublicationControllerReviewIdentity {
  databaseRepositoryId: string;
  pullRequestNumber: number;
  publicationGeneration: string;
  reviewId: number;
  acceptedInputIdentity: string;
}

export type PublicationControllerGenerationState =
  | "work"
  | "success"
  | "definitive-failure"
  | "superseded";

export interface PublicationControllerReviewContinuation {
  kind: "continue";
  payload: ReviewJobPayload;
  runAfter?: Date;
}

export interface PublicationControllerReviewSettled {
  kind: "settled";
}

export type PublicationControllerReviewAction =
  | PublicationControllerReviewContinuation
  | PublicationControllerReviewSettled;

export interface PublicationControllerReviewStateMachineDependencies {
  loadIdentity(input: {
    payload: ReviewJobPayload;
    lease: JobLease;
  }): Promise<PublicationControllerReviewIdentity | null>;
  inspectGeneration(input: {
    identity: PublicationControllerReviewIdentity;
    payload: ReviewJobPayload;
    lease: JobLease;
  }): Promise<PublicationControllerGenerationState>;
  executeOne(input: {
    identity: PublicationControllerReviewIdentity;
    payload: ReviewJobPayload;
    lease: JobLease;
    signal?: AbortSignal;
  }): Promise<{ status: "idle" | "applied" | "skipped" | "rejected" | "superseded" | "unknown" }>;
  deriveReceipt(input: {
    identity: PublicationControllerReviewIdentity;
  }): Promise<PublicationReceipt>;
  finalize(input: {
    identity: PublicationControllerReviewIdentity;
    payload: ReviewJobPayload;
    lease: JobLease;
    outcome: "success" | "definitive-failure" | "superseded";
    receipt?: PublicationReceipt;
  }): Promise<void>;
  loadContinuationPayload(input: {
    identity: PublicationControllerReviewIdentity;
    lease: JobLease;
  }): Promise<ReviewJobPayload>;
  now?: () => Date;
  retryDelayMs?: number;
  throwIfStopping?: (signal?: AbortSignal) => void;
}

export async function runExactPublicationControllerRecovery<T>(input: {
  payload: ReviewJobPayload;
  loadIdentity: () => Promise<PublicationControllerReviewIdentity | null>;
  recover: (identity: PublicationControllerReviewIdentity) => Promise<T>;
  isShutdownError: (error: unknown) => boolean;
  isReconciliationError: (error: unknown) => boolean;
  reconciliationError: (message: string) => Error;
  errorMessage: (error: unknown) => string;
}): Promise<T | null> {
  if (!Number.isSafeInteger(input.payload.recoveryReviewId)) return null;
  try {
    const identity = await input.loadIdentity();
    if (identity === null) {
      throw input.reconciliationError(
        "publication-controller recovery pointer has no exact staged generation",
      );
    }
    return await input.recover(identity);
  } catch (error) {
    if (input.isShutdownError(error) || input.isReconciliationError(error)) {
      throw error;
    }
    throw input.reconciliationError(
      `publication-controller recovery could not advance: ${input.errorMessage(error)}`,
    );
  }
}

export interface PublicationControllerOperationExecutorConstruction {
  pool?: Pool;
  scope: GitHubPublicationOperationScope;
  token: string;
  appId: number;
  claimOwner: string;
  leaseDurationMs?: number;
  adapters?: GitHubPublicationAdapters;
  signal?: AbortSignal;
  dispatchAuthorized?: () => Promise<boolean>;
  store?: GitHubPublicationOperationStore;
}

/** Construct the exact-scoped store and executor used by controller recovery. */
export function buildPublicationControllerOperationExecutor(
  input: PublicationControllerOperationExecutorConstruction,
): () => Promise<GitHubPublicationContinuation> {
  const store = input.store ?? (
    input.pool
      ? new PostgresGitHubPublicationOperationStore(input.pool, input.scope)
      : null
  );
  if (store === null) {
    throw new TypeError("publication-controller operation executor requires a store or pool");
  }
  const executorInput: ExecuteGitHubPublicationOperationInput = {
    store,
    token: input.token,
    appId: input.appId,
    claimOwner: input.claimOwner,
    ...(input.leaseDurationMs === undefined
      ? {}
      : { leaseDurationMs: input.leaseDurationMs }),
    ...(input.adapters === undefined ? {} : { adapters: input.adapters }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.dispatchAuthorized === undefined
      ? {}
      : { dispatchAuthorized: input.dispatchAuthorized }),
  };
  return () => executeOneGitHubPublicationOperation(executorInput);
}

/** Construct the dependency boundary shared by production and readiness probes. */
export function buildPublicationControllerReviewStateMachineDependencies(
  dependencies: PublicationControllerReviewStateMachineDependencies,
): PublicationControllerReviewStateMachineDependencies {
  for (const [name, value] of Object.entries(dependencies)) {
    if (name === "retryDelayMs") continue;
    if (value !== undefined && typeof value !== "function") {
      throw new TypeError(`publication-controller dependency ${name} is invalid`);
    }
  }
  return Object.freeze({ ...dependencies });
}

/**
 * Advance one controller-owned review through at most one forge operation.
 * Every return to the queue reloads the payload written by the atomic stage,
 * so an in-memory snapshot cannot erase its recovery pointer or retained input.
 */
export async function runPublicationControllerReviewStateMachine(
  input: {
    payload: ReviewJobPayload;
    lease: JobLease;
    signal?: AbortSignal;
  },
  dependencies: PublicationControllerReviewStateMachineDependencies,
): Promise<PublicationControllerReviewAction | null> {
  dependencies.throwIfStopping?.(input.signal);
  const identity = await dependencies.loadIdentity(input);
  if (identity === null) return null;

  dependencies.throwIfStopping?.(input.signal);
  const state = await dependencies.inspectGeneration({
    identity,
    payload: input.payload,
    lease: input.lease,
  });
  if (state === "superseded") {
    await dependencies.finalize({
      identity,
      payload: input.payload,
      lease: input.lease,
      outcome: "superseded",
    });
    return { kind: "settled" };
  }
  if (state === "definitive-failure") {
    await dependencies.finalize({
      identity,
      payload: input.payload,
      lease: input.lease,
      outcome: "definitive-failure",
    });
    return { kind: "settled" };
  }
  if (state === "success") {
    const receipt = await dependencies.deriveReceipt({ identity });
    dependencies.throwIfStopping?.(input.signal);
    await dependencies.finalize({
      identity,
      payload: input.payload,
      lease: input.lease,
      outcome: "success",
      receipt,
    });
    return { kind: "settled" };
  }

  const operation = await dependencies.executeOne({
    identity,
    payload: input.payload,
    lease: input.lease,
    signal: input.signal,
  });
  dependencies.throwIfStopping?.(input.signal);
  const payload = await dependencies.loadContinuationPayload({
    identity,
    lease: input.lease,
  });
  const retryDelayMs = dependencies.retryDelayMs ?? 1_000;
  const retry = operation.status === "idle" || operation.status === "unknown";
  return {
    kind: "continue",
    payload,
    ...(retry
      ? { runAfter: new Date((dependencies.now?.() ?? new Date()).getTime() + retryDelayMs) }
      : {}),
  };
}

export type NoMutationProbeExercise = (
  adapters: GitHubPublicationAdapters,
) => Promise<void>;

export interface PublicationControllerNoMutationProbeOptions {
  exercise?: NoMutationProbeExercise;
  onConstruction?: () => void;
}

function createReadOnlyNoWorkStore(
  client: Pick<PoolClient, "query">,
  rejectMutation: () => Promise<never>,
): GitHubPublicationOperationStore {
  return {
    async loadOneAmbiguous() {
      await client.query("SELECT 1 AS publication_controller_no_work WHERE false");
      return null;
    },
    async claimOneEligible() {
      return null;
    },
    recordDispatched: rejectMutation,
    finishNotDispatched: rejectMutation,
    finishApplied: rejectMutation,
    finishNotRequired: rejectMutation,
    finishRejected: rejectMutation,
    finishSuperseded: rejectMutation,
    finishAmbiguous: rejectMutation,
    retainLeaseLossAfterDispatch: rejectMutation,
    finishReconciledApplied: rejectMutation,
    finishReconciledRetry: rejectMutation,
  } as GitHubPublicationOperationStore;
}

/** Build the production-consumer readiness probe with an optional test exercise. */
export function createPublicationControllerConsumerNoMutationProbe(
  options: PublicationControllerNoMutationProbeOptions = {},
): PublicationControllerNoMutationProbe {
  return async ({ client, releaseSha, jobKinds }) => {
    if (!/^[0-9a-f]{40}$/u.test(releaseSha)) {
      throw new Error("publication-controller probe release identity is malformed");
    }
    if (
      jobKinds.length !== PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS.length ||
      jobKinds.some((kind, index) =>
        kind !== PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS[index]
      )
    ) {
      throw new Error(
        "publication-controller probe does not recognize the exact fenced job kinds",
      );
    }

    let mutationCount = 0;
    const rejectMutation = async (): Promise<never> => {
      mutationCount += 1;
      throw new Error(
        "publication-controller no-mutation probe reached a write path",
      );
    };
    const rejectRead = async (): Promise<never> => {
      throw new Error(
        "publication-controller no-mutation probe reached a forge read path",
      );
    };
    const adapters = {
      getPullRequestPublicationContext: rejectRead,
      observeReview: rejectRead,
      publishReview: rejectMutation,
      observeFileComment: rejectRead,
      publishFileComment: rejectMutation,
      observeReviewComment: rejectRead,
      updateReviewComment: rejectMutation,
      updateReviewSummary: rejectMutation,
      observeCheck: rejectRead,
      createCheck: rejectMutation,
      completeCheck: rejectMutation,
      observeCheckCompletion: rejectRead,
    } as unknown as GitHubPublicationAdapters;

    const identity: PublicationControllerReviewIdentity = {
      databaseRepositoryId: "1",
      pullRequestNumber: 1,
      publicationGeneration: "1",
      reviewId: 1,
      acceptedInputIdentity: `sha256:${"0".repeat(64)}`,
    };
    const executeOne = buildPublicationControllerOperationExecutor({
      scope: {
        databaseRepositoryId: identity.databaseRepositoryId,
        pullRequestNumber: identity.pullRequestNumber,
        publicationGeneration: identity.publicationGeneration,
      },
      store: createReadOnlyNoWorkStore(client, rejectMutation),
      token: "publication-controller-no-mutation-probe",
      appId: 1,
      claimOwner: "publication-controller-no-mutation-probe",
      adapters,
      dispatchAuthorized: async () => true,
    });
    options.onConstruction?.();
    const dependencies = buildPublicationControllerReviewStateMachineDependencies({
      loadIdentity: async () => identity,
      inspectGeneration: async () => "work",
      executeOne: async () => executeOne(),
      deriveReceipt: async () => {
        throw new Error("no-mutation probe unexpectedly reached receipt derivation");
      },
      finalize: async () => {
        throw new Error("no-mutation probe unexpectedly reached finalization");
      },
      loadContinuationPayload: async ({ lease }) => ({
        installationId: 1,
        githubRepoId: 1,
        repoFullName: "probe/no-work",
        prNumber: 1,
        headSha: "0".repeat(40),
        baseSha: "0".repeat(40),
        expectedPullRequestUpdatedAt: "1970-01-01T00:00:00.000Z",
        recoveryReviewId: identity.reviewId,
        reviewInputSequence: identity.publicationGeneration,
        _postilPublicationControllerProbeLease: `${lease.id}:${lease.lockGeneration}`,
      }),
    });
    await runPublicationControllerReviewStateMachine(
      {
        payload: {} as ReviewJobPayload,
        lease: {
          id: 1,
          lockedBy: "publication-controller-readiness",
          lockGeneration: 1n,
        },
      },
      dependencies,
    );
    await options.exercise?.(adapters);
    if (mutationCount !== 0) {
      throw new Error(
        "publication-controller no-mutation probe observed a forge write",
      );
    }
    return {
      releaseSha,
      mode: "no-mutation",
      observedMutationCount: 0,
      checkedJobKinds: [...jobKinds],
    };
  };
}

export async function probePublicationControllerProductionConsumerNoMutation(
  input: Parameters<PublicationControllerNoMutationProbe>[0],
  options: PublicationControllerNoMutationProbeOptions = {},
): ReturnType<PublicationControllerNoMutationProbe> {
  return createPublicationControllerConsumerNoMutationProbe(options)(input);
}
