import { describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";

import { PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS } from "@/lib/release-job-rollout";
import {
  publicationControllerClaimAuthorityFailure,
  probePublicationControllerProductionConsumerNoMutation,
  runExactPublicationControllerRecovery,
  runPublicationControllerRecoveryIfAuthorized,
  runPublicationControllerReviewStateMachine,
} from "@/worker/publication-controller-review";

const RELEASE_SHA = "a".repeat(40);

function readOnlyClient(queries: string[]): Pick<PoolClient, "query"> {
  return {
    query: (async (text: string) => {
      queries.push(text);
      if (!/^SELECT\b/u.test(text.trim())) {
        throw new Error("probe attempted a database mutation");
      }
      return { rows: [], rowCount: 0 };
    }) as PoolClient["query"],
  };
}

describe("publication-controller production consumer probe", () => {
  test("uses the production state-machine and executor construction boundary", async () => {
    const queries: string[] = [];
    let constructions = 0;

    const result = await probePublicationControllerProductionConsumerNoMutation(
      {
        client: readOnlyClient(queries),
        releaseSha: RELEASE_SHA,
        jobKinds: PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
      },
      { onConstruction: () => constructions += 1 },
    );

    expect(constructions).toBe(1);
    expect(queries).toEqual([
      "SELECT 1 AS publication_controller_no_work WHERE false",
    ]);
    expect(result).toEqual({
      releaseSha: RELEASE_SHA,
      mode: "no-mutation",
      observedMutationCount: 0,
      checkedJobKinds: ["review", "gate-state-sync", "check-run-cleanup"],
    });
  });

  test("rejects malformed releases and non-exact fenced kinds", async () => {
    const client = readOnlyClient([]);
    await expect(probePublicationControllerProductionConsumerNoMutation({
      client,
      releaseSha: "a".repeat(39),
      jobKinds: PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
    })).rejects.toThrow("release identity is malformed");

    await expect(probePublicationControllerProductionConsumerNoMutation({
      client,
      releaseSha: RELEASE_SHA,
      jobKinds: [
        "review",
        "check-run-cleanup",
        "gate-state-sync",
      ] as unknown as typeof PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
    })).rejects.toThrow("exact fenced job kinds");
  });

  test("cannot report ready after a forge mutation path is reached", async () => {
    await expect(probePublicationControllerProductionConsumerNoMutation(
      {
        client: readOnlyClient([]),
        releaseSha: RELEASE_SHA,
        jobKinds: PUBLICATION_CONTROLLER_DIRECT_MUTATOR_JOB_KINDS,
      },
      {
        exercise: async (adapters) => {
          await adapters.createCheck(
            "token",
            "probe/no-work",
            {} as Parameters<typeof adapters.createCheck>[2],
          );
        },
      },
    )).rejects.toThrow("reached a write path");
  });
});

describe("publication-controller review state machine", () => {
  test("executes one operation and preserves the durable continuation payload", async () => {
    let operations = 0;
    const durablePayload = {
      installationId: 1,
      githubRepoId: 2,
      repoFullName: "probe/repository",
      prNumber: 3,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      expectedPullRequestUpdatedAt: "2026-08-15T00:00:00.000Z",
      reviewInputSequence: "4",
      recoveryReviewId: 5,
      _postilCoalescedReviewPayload: { reviewInputSequence: "6" },
    };
    const result = await runPublicationControllerReviewStateMachine(
      {
        payload: { ...durablePayload, recoveryReviewId: 99 },
        lease: { id: 1, lockedBy: "worker", lockGeneration: 1n },
      },
      {
        loadIdentity: async () => ({
          databaseRepositoryId: "1",
          pullRequestNumber: 3,
          publicationGeneration: "4",
          reviewId: 5,
          acceptedInputIdentity: `sha256:${"0".repeat(64)}`,
        }),
        inspectGeneration: async () => "work",
        executeOne: async () => {
          operations += 1;
          return { status: "applied" };
        },
        deriveReceipt: async () => { throw new Error("not reached"); },
        finalize: async () => { throw new Error("not reached"); },
        loadContinuationPayload: async () => durablePayload,
      },
    );

    expect(operations).toBe(1);
    expect(result).toEqual({ kind: "continue", payload: durablePayload });
  });

  test("reports settled only after finalization completes", async () => {
    let finalizations = 0;
    const result = await runPublicationControllerReviewStateMachine(
      {
        payload: {} as never,
        lease: { id: 1, lockedBy: "worker", lockGeneration: 1n },
      },
      {
        loadIdentity: async () => ({
          databaseRepositoryId: "1",
          pullRequestNumber: 2,
          publicationGeneration: "3",
          reviewId: 4,
          acceptedInputIdentity: `sha256:${"0".repeat(64)}`,
        }),
        inspectGeneration: async () => "definitive-failure",
        executeOne: async () => ({ status: "idle" }),
        deriveReceipt: async () => { throw new Error("not reached"); },
        finalize: async () => { finalizations += 1; },
        loadContinuationPayload: async () => { throw new Error("not reached"); },
      },
    );

    expect(result).toEqual({ kind: "settled" });
    expect(finalizations).toBe(1);
  });

  test("does not report settled when exact finalization cannot settle", async () => {
    await expect(runPublicationControllerReviewStateMachine(
      {
        payload: {} as never,
        lease: { id: 1, lockedBy: "worker", lockGeneration: 1n },
      },
      {
        loadIdentity: async () => ({
          databaseRepositoryId: "1",
          pullRequestNumber: 2,
          publicationGeneration: "3",
          reviewId: 4,
          acceptedInputIdentity: `sha256:${"0".repeat(64)}`,
        }),
        inspectGeneration: async () => "superseded",
        executeOne: async () => ({ status: "idle" }),
        deriveReceipt: async () => { throw new Error("not reached"); },
        finalize: async () => {
          throw new Error("exact finalization did not settle");
        },
        loadContinuationPayload: async () => { throw new Error("not reached"); },
      },
    )).rejects.toThrow("exact finalization did not settle");
  });
});

describe("publication-controller exact claim authority", () => {
  const payload = {
    installationId: 1,
    githubRepoId: 2,
    repoFullName: "probe/repository",
    prNumber: 3,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    expectedPullRequestUpdatedAt: "2026-08-15T00:00:00.000Z",
    _postilPublicationControllerFence: true,
    _postilPublicationControllerReleaseSha: RELEASE_SHA,
  };

  test("requires a full release identity bound to local and durable authority", () => {
    expect(publicationControllerClaimAuthorityFailure({
      payload,
      claim: { releaseSha: RELEASE_SHA },
      localReleaseSha: RELEASE_SHA,
    })).toBeNull();
    expect(publicationControllerClaimAuthorityFailure({
      payload,
      claim: { releaseSha: "a".repeat(39) },
      localReleaseSha: "a".repeat(39),
    })).toContain("malformed");
    expect(publicationControllerClaimAuthorityFailure({
      payload,
      claim: { releaseSha: RELEASE_SHA },
      localReleaseSha: "b".repeat(40),
    })).toContain("local release");
    expect(publicationControllerClaimAuthorityFailure({
      payload: { ...payload, _postilPublicationControllerFence: false },
      claim: { releaseSha: RELEASE_SHA },
      localReleaseSha: RELEASE_SHA,
    })).toContain("durable queue authority");
    expect(publicationControllerClaimAuthorityFailure({
      payload: {
        ...payload,
        _postilPublicationControllerReleaseSha: "b".repeat(40),
      },
      claim: { releaseSha: RELEASE_SHA },
      localReleaseSha: RELEASE_SHA,
    })).toContain("durable queue authority");
  });
});

describe("publication-controller recovery pointer", () => {
  const payload = {
    installationId: 1,
    githubRepoId: 2,
    repoFullName: "probe/repository",
    prNumber: 3,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    expectedPullRequestUpdatedAt: "2026-08-15T00:00:00.000Z",
    recoveryReviewId: 4,
  };
  const reconcile = (message: string) =>
    Object.assign(new Error(message), { reconciliation: true });
  const base = {
    payload,
    recover: async () => ({ kind: "settled" as const }),
    isShutdownError: () => false,
    isReconciliationError: (error: unknown) =>
      (error as { reconciliation?: boolean }).reconciliation === true,
    reconciliationError: reconcile,
    errorMessage: (error: unknown) => String((error as Error).message),
  };

  test("wraps identity lookup errors after a durable recovery pointer", async () => {
    await expect(runExactPublicationControllerRecovery({
      ...base,
      loadIdentity: async () => { throw new Error("transient SQL failure"); },
    })).rejects.toMatchObject({
      reconciliation: true,
      message: expect.stringContaining("transient SQL failure"),
    });
  });

  test("rejects a recovery pointer without its exact staged generation", async () => {
    await expect(runExactPublicationControllerRecovery({
      ...base,
      loadIdentity: async () => null,
    })).rejects.toMatchObject({
      reconciliation: true,
      message: expect.stringContaining("no exact staged generation"),
    });
  });

  test("does not classify ordinary jobs as controller recovery", async () => {
    let loaded = false;
    await expect(runExactPublicationControllerRecovery({
      ...base,
      payload: { ...payload, recoveryReviewId: undefined },
      loadIdentity: async () => {
        loaded = true;
        return null;
      },
    })).resolves.toBeNull();
    expect(loaded).toBe(false);
  });

  test("does not enter controller recovery without an exact controller claim", async () => {
    let advanced = false;
    await expect(runPublicationControllerRecoveryIfAuthorized({
      payload,
      claim: undefined,
      localReleaseSha: RELEASE_SHA,
      authorityError: (message) => new Error(message),
      recover: async () => {
        advanced = true;
        return { kind: "settled" as const };
      },
    })).resolves.toBeNull();
    expect(advanced).toBe(false);
  });

  test("rejects mismatched authority before reading or advancing recovery", async () => {
    let advanced = false;
    await expect(runPublicationControllerRecoveryIfAuthorized({
      payload: {
        ...payload,
        _postilPublicationControllerFence: true,
        _postilPublicationControllerReleaseSha: RELEASE_SHA,
      },
      claim: { releaseSha: RELEASE_SHA },
      localReleaseSha: "b".repeat(40),
      authorityError: (message) => new Error(message),
      recover: async () => {
        advanced = true;
        return { kind: "settled" as const };
      },
    })).rejects.toThrow("local release");
    expect(advanced).toBe(false);
  });
});
