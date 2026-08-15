import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Pool } from "pg";

import { buildGitHubPublicationControllerManifest } from "@/lib/github-publication-controller-manifest";
import { stageGitHubPublicationControllerGeneration } from "@/lib/github-publication-controller-store";
import {
  type AmbiguousGitHubPublicationOperation,
  executeOneGitHubPublicationOperation,
  GitHubPublicationOperationValidationError,
  type ClaimedGitHubPublicationOperation,
  type DurablePublicationDependencyEvidence,
  type GitHubPublicationAdapters,
  type GitHubPublicationOperationStore,
  type PublicationDispatchEvidence,
  type PublicationTerminalEvidence,
} from "@/lib/github-publication-operation-executor";
import { PostgresGitHubPublicationOperationStore } from "@/lib/github-publication-operation-store";
import {
  parseGitHubPublicationPlanBytes,
  type ExpectedGitHubPublicationPlan,
} from "@/lib/github-publication-plan";
import {
  GitHubPublicationAmbiguousError,
  GitHubPublicationRejectedError,
  GitHubReviewPlacementRejectedError,
} from "@/lib/github/review-publication";
import {
  createEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TARGET = "c".repeat(40);
const TITLE = "Durable publication executor";
const BODY = "Each forge write is represented by one immutable operation.";
const NOW = new Date();

describe("GitHub publication operation executor", () => {
  test("does not call the forge when the database has no current eligible operation", async () => {
    const store = new MemoryStore([]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toEqual({ status: "idle", shouldContinue: false });
    expect(adapters.calls).toEqual([]);
  });

  test("does not compensate for a stale generation rejected by the database claim boundary", async () => {
    const store = new MemoryStore([]);
    const adapters = fakeAdapters();
    await expect(run(store, adapters)).resolves.toEqual({ status: "idle", shouldContinue: false });
    expect(adapters.calls).toEqual([]);
  });

  test("does not compensate for unmet dependencies rejected by the database claim boundary", async () => {
    const store = new MemoryStore([]);
    const adapters = fakeAdapters();
    await expect(run(store, adapters)).resolves.toEqual({ status: "idle", shouldContinue: false });
    expect(adapters.calls).toEqual([]);
  });

  test("revalidates exact immutable artifacts and fails closed before dispatch", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    (fixture.claim as { operationRecordBytes: Uint8Array }).operationRecordBytes = Buffer.from("{}", "utf8");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).rejects.toBeInstanceOf(GitHubPublicationOperationValidationError);
    expect(adapters.calls).toEqual([]);
    expect(store.terminal.at(-1)?.outcome).toBe("rejected");
  });

  test("reconciles an existing create without issuing a second mutation", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters({ existingCheckId: "71" });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "skipped", shouldContinue: true });
    expect(adapters.calls).toEqual(["observeCheck"]);
    expect(store.terminal.at(-1)).toMatchObject({ outcome: "reconciledExisting", remoteId: "71" });
  });

  test("records a failed live observation as not dispatched", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters({ failCheckObservation: true });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "unknown", shouldContinue: false });
    expect(adapters.calls).toEqual(["observeCheck"]);
    expect(store.notDispatched).toHaveLength(1);
  });

  test("uses the exact gate creation dependency remote ID for completion", async () => {
    const fixture = fixtureFor("gateCheckComplete");
    const store = new MemoryStore([fixture.claim]);
    const gateCreate = fixture.controller.value.operations.find((record) => record.operation.kind === "gateCheckCreate")!;
    const expectedExternalId = (gateCreate.operation.payload as { externalId: string }).externalId;
    const adapters = fakeAdapters({ expectedCompletionExternalId: expectedExternalId });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(adapters.calls).toEqual(["completeCheck:901"]);
    expect(store.terminal.at(-1)).toMatchObject({ outcome: "applied", remoteId: "901" });
  });

  test("executes advisory completion and service gate creation as separate immutable mutations", async () => {
    const advisory = fixtureFor("advisoryCheckComplete");
    const advisoryStore = new MemoryStore([advisory.claim]);
    const advisoryAdapters = fakeAdapters();
    await expect(run(advisoryStore, advisoryAdapters)).resolves.toMatchObject({ status: "applied" });
    expect(advisoryAdapters.calls).toEqual(["completeCheck:801"]);

    const gate = fixtureFor("gateCheckCreate");
    const gateStore = new MemoryStore([gate.claim]);
    const gateAdapters = fakeAdapters({ createdCheckId: "901" });
    await expect(run(gateStore, gateAdapters)).resolves.toMatchObject({ status: "applied" });
    expect(gateAdapters.calls).toEqual(["observeCheck", "createCheck"]);
    expect(gateStore.terminal.at(-1)).toMatchObject({ outcome: "created", remoteId: "901" });
  });

  test("retains ambiguity and does not dispatch a second write without a new database claim", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters({ ambiguousCreate: true });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "unknown", shouldContinue: false });
    await expect(run(store, adapters)).resolves.toEqual({ status: "idle", shouldContinue: false });
    expect(adapters.calls).toEqual(["observeCheck", "createCheck"]);
    expect(store.ambiguous).toHaveLength(1);
  });

  test("records semantic 422 rejection for an exact fallback dependency", async () => {
    const fixture = fixtureFor("reviewCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters({ rejectPlacement: true });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "rejected", shouldContinue: true });
    expect(store.terminal.at(-1)).toMatchObject({
      outcome: "rejected",
      httpStatus: 422,
      classification: "invalidReviewCommentPlacement",
    });
  });

  test("activates the relocated review only from exact semantic 422 evidence and live marker absence", async () => {
    const fixture = fixtureFor("relocatedReviewCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied", shouldContinue: true });
    expect(adapters.calls).toEqual(["observeReview", "publishReview"]);
  });

  test("retains observed success as unknown when the exact lease CAS is lost", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([fixture.claim]);
    store.loseFinalLease = true;
    const adapters = fakeAdapters({ createdCheckId: "81" });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "unknown", shouldContinue: false });
    expect(store.leaseLoss).toHaveLength(1);
    expect(store.leaseLoss[0]!.observedResult).toEqual({ checkRunId: "81" });
  });

  test("publishes a file fallback only after exact partial-review live evidence", async () => {
    const fixture = fixtureFor("fileCommentFallback");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters({ partialReviewId: "501", createdCommentId: "601" });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(adapters.calls).toEqual(["observeReview", "publishFileComment"]);
    expect(store.terminal.at(-1)).toMatchObject({ outcome: "created", remoteId: "601" });
  });

  test("updates a finding comment only after an exact live content comparison", async () => {
    const fixture = fixtureFor("findingCommentUpdate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(adapters.calls).toEqual(["observeReviewComment", "updateReviewComment"]);
    expect(store.terminal.at(-1)).toMatchObject({ outcome: "applied", remoteId: "701" });
  });

  test("selects one durable review result before updating its summary", async () => {
    const fixture = fixtureFor("reviewSummaryUpdate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(adapters.calls).toEqual(["updateReviewSummary"]);
    expect(store.terminal.at(-1)).toMatchObject({ outcome: "applied", remoteId: "501" });
  });

  test("reconciles an ambiguous create from exact remote identity without another mutation", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([], [ambiguousFrom(fixture.claim)]);
    const adapters = fakeAdapters({ existingCheckId: "81" });

    await expect(run(store, adapters)).resolves.toMatchObject({
      status: "applied",
      shouldContinue: true,
    });
    expect(adapters.calls).toEqual(["observeCheck"]);
    expect(store.reconciled.at(-1)).toMatchObject({
      outcome: "reconciledExisting",
      remoteId: "81",
    });
  });

  test("authorizes a retry only after an ambiguous create is observed exactly absent", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([], [ambiguousFrom(fixture.claim)]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({
      status: "unknown",
      shouldContinue: true,
    });
    expect(adapters.calls).toEqual(["observeCheck"]);
    expect(store.reconciledRetries).toHaveLength(1);
    expect(store.reconciledRetries[0]!.result).toEqual({
      desiredState: "exactlyAbsent",
      operationKey: fixture.claim.operationKey,
    });
  });

  test("re-observes exact absence under the new lease before issuing one retry mutation", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const claim = fixture.claim as ClaimedGitHubPublicationOperation & {
      attemptNumber: number;
      leaseGeneration: number;
      retryAuthorization: ClaimedGitHubPublicationOperation["retryAuthorization"];
    };
    claim.attemptNumber = 2;
    claim.leaseGeneration = 2;
    claim.retryAuthorization = {
      kind: "exactAbsence",
      priorAttemptNumber: 1,
      priorLeaseGeneration: 1,
      observedAt: NOW,
      evidenceDigest: digest("absence-evidence"),
    };
    const store = new MemoryStore([claim]);
    const adapters = fakeAdapters({ createdCheckId: "81" });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(adapters.calls).toEqual(["observeCheck", "observeCheck", "createCheck"]);
    expect(adapters.calls.filter((call) => call === "createCheck")).toHaveLength(1);
  });

  test("reconciles ambiguous update operations only from exact desired remote state", async () => {
    const finding = fixtureFor("findingCommentUpdate");
    const findingStore = new MemoryStore([], [ambiguousFrom(finding.claim)]);
    const findingAdapters = fakeAdapters({ exactReviewComment: true });
    await expect(run(findingStore, findingAdapters)).resolves.toMatchObject({ status: "applied" });
    expect(findingAdapters.calls).toEqual(["observeReviewComment"]);

    const summary = fixtureFor("reviewSummaryUpdate");
    const summaryOperation = JSON.parse(
      new TextDecoder().decode(summary.claim.operationRecordBytes),
    ) as { cases: Array<{ body: string }> };
    const summaryStore = new MemoryStore([], [ambiguousFrom(summary.claim)]);
    const summaryAdapters = fakeAdapters({
      partialReviewId: "501",
      observedReviewBody: summaryOperation.cases[0]!.body,
    });
    await expect(run(summaryStore, summaryAdapters)).resolves.toMatchObject({ status: "applied" });
    expect(summaryAdapters.calls).toEqual(["observeReview"]);
  });

  test("keeps an ambiguous terminal check unknown when live state conflicts", async () => {
    const fixture = fixtureFor("gateCheckComplete");
    const store = new MemoryStore([], [ambiguousFrom(fixture.claim)]);
    const adapters = fakeAdapters({ checkCompletionState: "conflict" });

    await expect(run(store, adapters)).resolves.toMatchObject({
      status: "unknown",
      shouldContinue: false,
    });
    expect(adapters.calls).toEqual(["observeCheckCompletion"]);
    expect(store.reconciled).toHaveLength(0);
    expect(store.reconciledRetries).toHaveLength(0);
  });

  test("never retries a definitively rejected mutation through ambiguity recovery", async () => {
    const fixture = fixtureFor("reviewCreate");
    const operation: AmbiguousGitHubPublicationOperation = {
      ...ambiguousFrom(fixture.claim),
      ambiguityEvidence: {
        observedResult: {
          httpStatus: 422,
          classification: "invalidReviewCommentPlacement",
        },
      },
    };
    const store = new MemoryStore([], [operation]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({
      status: "unknown",
      shouldContinue: false,
    });
    expect(adapters.calls).toEqual([]);
    expect(store.reconciledRetries).toHaveLength(0);
  });
});

const describeDb = process.env.POSTIL_TEST_DATABASE_URL ? describe : describe.skip;

describeDb("PostgreSQL publication operation store", () => {
  let database: EphemeralDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createEphemeralDatabase("publication_operation_executor");
    pool = database.pool;
  }, 30_000);

  afterAll(async () => {
    await database.drop();
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM repositories WHERE full_name LIKE 'publication-executor-%'`);
  });

  test("claims one current sealed operation under concurrent workers and appends each phase once", async () => {
    await stageDatabaseFixture(pool, 101);
    const first = new PostgresGitHubPublicationOperationStore(pool);
    const second = new PostgresGitHubPublicationOperationStore(pool);
    const [left, right] = await Promise.all([
      first.claimOneEligible({ claimOwner: "worker-left", leaseId: randomUUID(), leaseDurationMs: 60_000 }),
      second.claimOneEligible({ claimOwner: "worker-right", leaseId: randomUUID(), leaseDurationMs: 60_000 }),
    ]);
    const claims = [left, right].filter((claim): claim is ClaimedGitHubPublicationOperation => claim !== null);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.databaseEligibility).toEqual({
      currentSealedHighWater: true,
      dependenciesEligible: true,
      mutuallyExclusive: true,
    });
    expect(claim.retryAuthorization).toEqual({ kind: "initial" });
    const observedLeaseDuration = claim.leaseExpiresAt.getTime() - claim.claimedAt.getTime();
    expect(observedLeaseDuration).toBeGreaterThanOrEqual(59_000);
    expect(observedLeaseDuration).toBeLessThanOrEqual(60_000);

    const dispatched = dispatchFixture(claim);
    expect(await first.recordDispatched(claim, dispatched)).toBe(true);
    expect(await first.recordDispatched(claim, dispatched)).toBe(false);
    expect(await first.finishApplied(claim, terminalFixture(claim, dispatched))).toBe(true);

    const stored = await pool.query<{
      state: string;
      phases: string[];
      pending_siblings: string;
    }>(
      `SELECT operation.state,
              ARRAY(
                SELECT phase FROM review_publication_operation_attempts attempt
                WHERE attempt.repository_id = operation.repository_id
                  AND attempt.pr_number = operation.pr_number
                  AND attempt.publication_generation = operation.publication_generation
                  AND attempt.operation_key = operation.operation_key
                ORDER BY attempt.id
              ) AS phases,
              (SELECT count(*)::text FROM review_publication_operations sibling
               WHERE sibling.repository_id = operation.repository_id
                 AND sibling.pr_number = operation.pr_number
                 AND sibling.publication_generation = operation.publication_generation
                 AND sibling.operation_key <> operation.operation_key
                 AND sibling.state = 'pending') AS pending_siblings
       FROM review_publication_operations operation
       WHERE operation.repository_id = $1::bigint
         AND operation.pr_number = $2
         AND operation.publication_generation = $3::bigint
         AND operation.operation_key = $4`,
      [
        claim.databaseRepositoryId,
        claim.pullRequestNumber,
        claim.publicationGeneration,
        claim.operationKey,
      ],
    );
    expect(stored.rows[0]).toEqual({
      state: "applied",
      phases: ["claimed", "dispatched", "applied"],
      pending_siblings: "4",
    });
  });

  test("records definitive remote rejection as terminal append-only evidence", async () => {
    await stageDatabaseFixture(pool, 104);
    const store = new PostgresGitHubPublicationOperationStore(pool);
    const claim = (await store.claimOneEligible({
      claimOwner: "rejection-worker",
      leaseId: randomUUID(),
      leaseDurationMs: 60_000,
    }))!;
    const dispatched = dispatchFixture(claim);
    expect(await store.recordDispatched(claim, dispatched)).toBe(true);
    const result = { httpStatus: 422, classification: "invalidReviewCommentPlacement" };
    expect(await store.finishRejected(claim, {
      ...dispatched,
      outcome: "rejected",
      result,
      resultDigest: digestJson(result),
      httpStatus: 422,
      classification: "invalidReviewCommentPlacement",
    })).toBe(true);

    const stored = await pool.query<{
      state: string;
      phases: string[];
      last_error: string | null;
      terminal_evidence: Record<string, unknown> | null;
    }>(
      `SELECT operation.state, operation.last_error, operation.terminal_evidence,
              ARRAY(
                SELECT phase FROM review_publication_operation_attempts attempt
                WHERE attempt.repository_id = operation.repository_id
                  AND attempt.pr_number = operation.pr_number
                  AND attempt.publication_generation = operation.publication_generation
                  AND attempt.operation_key = operation.operation_key
                ORDER BY attempt.id
              ) AS phases
       FROM review_publication_operations operation
       WHERE operation.repository_id = $1::bigint
         AND operation.pr_number = $2
         AND operation.publication_generation = $3::bigint
         AND operation.operation_key = $4`,
      [claim.databaseRepositoryId, claim.pullRequestNumber, claim.publicationGeneration, claim.operationKey],
    );
    expect(stored.rows[0]).toMatchObject({
      state: "failed",
      phases: ["claimed", "dispatched", "rejected"],
      last_error: "GitHub publication rejected with outcome rejected",
      terminal_evidence: {
        outcome: "rejected",
        httpStatus: 422,
        classification: "invalidReviewCommentPlacement",
      },
    });
  });

  test("terminalizes pre-dispatch validation rejection without dispatch evidence", async () => {
    await stageDatabaseFixture(pool, 105);
    const store = new PostgresGitHubPublicationOperationStore(pool);
    const claim = (await store.claimOneEligible({
      claimOwner: "validation-worker",
      leaseId: randomUUID(),
      leaseDurationMs: 60_000,
    }))!;
    const result = { reason: "immutable operation validation failed", dispatched: false };
    expect(await store.finishRejected(claim, {
      ...dispatchFixture(claim),
      outcome: "rejected",
      result,
      resultDigest: digestJson(result),
    })).toBe(true);

    const stored = await pool.query<{ state: string; phases: string[] }>(
      `SELECT operation.state,
              ARRAY(
                SELECT phase FROM review_publication_operation_attempts attempt
                WHERE attempt.repository_id = operation.repository_id
                  AND attempt.pr_number = operation.pr_number
                  AND attempt.publication_generation = operation.publication_generation
                  AND attempt.operation_key = operation.operation_key
                ORDER BY attempt.id
              ) AS phases
       FROM review_publication_operations operation
       WHERE operation.repository_id = $1::bigint
         AND operation.pr_number = $2
         AND operation.publication_generation = $3::bigint
         AND operation.operation_key = $4`,
      [claim.databaseRepositoryId, claim.pullRequestNumber, claim.publicationGeneration, claim.operationKey],
    );
    expect(stored.rows[0]).toEqual({
      state: "failed",
      phases: ["claimed", "not_dispatched"],
    });
  });

  test("retries only from exact append-only not-dispatched lineage", async () => {
    await stageDatabaseFixture(pool, 102);
    const store = new PostgresGitHubPublicationOperationStore(pool);
    const first = await store.claimOneEligible({
      claimOwner: "retry-worker-one",
      leaseId: randomUUID(),
      leaseDurationMs: 60_000,
    });
    expect(first).not.toBeNull();
    const firstClaim = first!;
    await skipSiblingOperations(pool, firstClaim);
    expect(await store.finishNotDispatched(firstClaim, {
      ...dispatchFixture(firstClaim),
      errorReason: "activation observation failed before mutation",
    })).toBe(true);
    const second = await store.claimOneEligible({
      claimOwner: "retry-worker-two",
      leaseId: randomUUID(),
      leaseDurationMs: 60_000,
    });
    expect(second).toMatchObject({
      operationKey: firstClaim.operationKey,
      attemptNumber: 2,
      leaseGeneration: 2,
      retryAuthorization: {
        kind: "notDispatched",
        priorAttemptNumber: 1,
        priorLeaseGeneration: 1,
      },
    });
  });

  test("serializes ambiguity reconciliation before allowing a retry", async () => {
    await stageDatabaseFixture(pool, 103);
    const store = new PostgresGitHubPublicationOperationStore(pool);
    const claim = (await store.claimOneEligible({
      claimOwner: "ambiguity-worker",
      leaseId: randomUUID(),
      leaseDurationMs: 60_000,
    }))!;
    await skipSiblingOperations(pool, claim);
    const dispatched = dispatchFixture(claim);
    expect(await store.recordDispatched(claim, dispatched)).toBe(true);
    expect(await store.finishAmbiguous(claim, {
      ...dispatched,
      errorReason: "forge response ended before a terminal result was observed",
    })).toBe(true);
    expect(await store.finishApplied(claim, terminalFixture(claim, dispatched))).toBe(false);

    const ambiguous = await store.loadOneAmbiguous();
    expect(ambiguous).toMatchObject({
      operationKey: claim.operationKey,
      attemptNumber: 1,
      leaseGeneration: 1,
    });
    const absence = {
      ...dispatchFixture(ambiguous!),
      result: { desiredState: "exactlyAbsent" },
      resultDigest: digestJson({ desiredState: "exactlyAbsent" }),
    };
    const [left, right] = await Promise.all([
      store.finishReconciledRetry(ambiguous!, absence),
      store.finishReconciledRetry(ambiguous!, absence),
    ]);
    expect([left, right].filter(Boolean)).toHaveLength(1);

    const retry = await store.claimOneEligible({
      claimOwner: "ambiguity-retry-worker",
      leaseId: randomUUID(),
      leaseDurationMs: 60_000,
    });
    expect(retry).toMatchObject({
      operationKey: claim.operationKey,
      attemptNumber: 2,
      leaseGeneration: 2,
      retryAuthorization: {
        kind: "exactAbsence",
        priorAttemptNumber: 1,
        priorLeaseGeneration: 1,
      },
    });
    const evidence = await pool.query<{ attempts: string; reconciliations: string }>(
      `SELECT
         (SELECT count(*)::text FROM review_publication_operation_attempts
          WHERE repository_id = $1::bigint AND pr_number = $2
            AND publication_generation = $3::bigint AND operation_key = $4) AS attempts,
         (SELECT count(*)::text FROM review_publication_operation_reconciliations
          WHERE repository_id = $1::bigint AND pr_number = $2
            AND publication_generation = $3::bigint AND operation_key = $4) AS reconciliations`,
      [claim.databaseRepositoryId, claim.pullRequestNumber, claim.publicationGeneration, claim.operationKey],
    );
    expect(evidence.rows[0]).toEqual({ attempts: "4", reconciliations: "1" });
  });
});

function run(store: GitHubPublicationOperationStore, adapters: GitHubPublicationAdapters & { calls: string[] }) {
  return executeOneGitHubPublicationOperation({
    store,
    token: "test-token",
    appId: 41,
    claimOwner: "test-worker",
    leaseDurationMs: 60_000,
    adapters,
    now: () => NOW,
    leaseId: () => "11111111-1111-4111-8111-111111111111",
  });
}

class MemoryStore implements GitHubPublicationOperationStore {
  terminal: PublicationTerminalEvidence[] = [];
  ambiguous: Array<PublicationDispatchEvidence & { errorReason: string }> = [];
  notDispatched: Array<PublicationDispatchEvidence & { errorReason: string }> = [];
  leaseLoss: Array<PublicationDispatchEvidence & { errorReason: string; observedResult?: Readonly<Record<string, unknown>> }> = [];
  reconciled: PublicationTerminalEvidence[] = [];
  reconciledRetries: Array<PublicationDispatchEvidence & {
    result: Readonly<Record<string, unknown>>;
    resultDigest: string;
  }> = [];
  loseFinalLease = false;

  constructor(
    private readonly claims: ClaimedGitHubPublicationOperation[],
    private readonly ambiguousOperations: AmbiguousGitHubPublicationOperation[] = [],
  ) {}

  async loadOneAmbiguous() {
    return this.ambiguousOperations.shift() ?? null;
  }

  async claimOneEligible() {
    return this.claims.shift() ?? null;
  }

  async recordDispatched() {
    return true;
  }

  async finishNotDispatched(
    _claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & { errorReason: string },
  ) {
    this.notDispatched.push(evidence);
    return true;
  }

  async finishApplied(_claim: ClaimedGitHubPublicationOperation, evidence: PublicationTerminalEvidence) {
    if (this.loseFinalLease) return false;
    this.terminal.push(evidence);
    return true;
  }

  async finishNotRequired(_claim: ClaimedGitHubPublicationOperation, evidence: PublicationTerminalEvidence) {
    this.terminal.push(evidence);
    return true;
  }

  async finishRejected(_claim: ClaimedGitHubPublicationOperation, evidence: PublicationTerminalEvidence) {
    this.terminal.push(evidence);
    return true;
  }

  async finishAmbiguous(
    _claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & { errorReason: string },
  ) {
    this.ambiguous.push(evidence);
    return true;
  }

  async retainLeaseLossAfterDispatch(
    _claim: ClaimedGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & { errorReason: string; observedResult?: Readonly<Record<string, unknown>> },
  ) {
    this.leaseLoss.push(evidence);
  }

  async finishReconciledApplied(
    _operation: AmbiguousGitHubPublicationOperation,
    evidence: PublicationTerminalEvidence,
  ) {
    this.reconciled.push(evidence);
    return true;
  }

  async finishReconciledRetry(
    _operation: AmbiguousGitHubPublicationOperation,
    evidence: PublicationDispatchEvidence & {
      result: Readonly<Record<string, unknown>>;
      resultDigest: string;
    },
  ) {
    this.reconciledRetries.push(evidence);
    return true;
  }
}

function fakeAdapters(options: {
  existingCheckId?: string;
  createdCheckId?: string;
  ambiguousCreate?: boolean;
  rejectPlacement?: boolean;
  partialReviewId?: string;
  createdCommentId?: string;
  expectedCompletionExternalId?: string;
  failCheckObservation?: boolean;
  exactReviewComment?: boolean;
  observedReviewBody?: string;
  checkCompletionState?: "applied" | "retryable" | "conflict";
} = {}): GitHubPublicationAdapters & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async observeReview(_token, _repo, _pr, _marker, headSha, commentMarkers) {
      calls.push("observeReview");
      if (!options.partialReviewId) return null;
      return {
        reviewId: options.partialReviewId,
        commitId: headSha,
        body: options.observedReviewBody ?? "review",
        commentIdsByMarker: {},
        missingCommentMarkers: commentMarkers,
      };
    },
    async publishReview(_token, _repo, _pr, intent) {
      calls.push("publishReview");
      if (options.rejectPlacement) throw new GitHubReviewPlacementRejectedError();
      return {
        reviewId: "501",
        commitId: intent.commitId,
        body: intent.body,
        commentIdsByMarker: {},
        missingCommentMarkers: intent.comments.map((comment) => comment.marker),
      };
    },
    async observeFileComment() {
      calls.push("observeFileComment");
      return null;
    },
    async publishFileComment(_token, _repo, _pr, intent) {
      calls.push("publishFileComment");
      return {
        commentId: options.createdCommentId ?? "601",
        commitId: intent.commitId,
        path: intent.path,
        body: intent.body,
      };
    },
    async observeReviewComment(_token, _repo, intent) {
      calls.push("observeReviewComment");
      return {
        commentId: intent.commentId,
        commitId: intent.commitId,
        path: intent.path,
        body: options.exactReviewComment ? intent.body : "old",
      };
    },
    async updateReviewComment(_token, _repo, intent) {
      calls.push("updateReviewComment");
      return { commentId: intent.commentId, commitId: intent.commitId, path: intent.path, body: intent.body };
    },
    async updateReviewSummary(_token, _repo, _pr, reviewId, commitId, _marker, body) {
      calls.push("updateReviewSummary");
      return { reviewId, commitId, body };
    },
    async observeCheck() {
      calls.push("observeCheck");
      if (options.failCheckObservation) throw new GitHubPublicationRejectedError("check observation", 503);
      return options.existingCheckId
        ? { checkRunId: options.existingCheckId, status: "in_progress", conclusion: null }
        : null;
    },
    async createCheck() {
      calls.push("createCheck");
      if (options.ambiguousCreate) throw new GitHubPublicationAmbiguousError("check-run creation");
      return options.createdCheckId ?? "81";
    },
    async completeCheck(_token, _repo, intent) {
      if (options.expectedCompletionExternalId !== undefined) {
        expect(intent.externalId).toBe(options.expectedCompletionExternalId);
      }
      calls.push(`completeCheck:${intent.checkRunId}`);
    },
    async observeCheckCompletion(_token, _repo, intent) {
      calls.push("observeCheckCompletion");
      return {
        checkRunId: intent.checkRunId,
        status: options.checkCompletionState === "applied" ? "completed" : "in_progress",
        conclusion: options.checkCompletionState === "applied" ? intent.conclusion : null,
        desiredState: options.checkCompletionState ?? "retryable",
      };
    },
  };
}

function fixtureFor(kind:
  | "advisoryCheckCreate"
  | "advisoryCheckComplete"
  | "reviewCreate"
  | "relocatedReviewCreate"
  | "fileCommentFallback"
  | "findingCommentUpdate"
  | "reviewSummaryUpdate"
  | "gateCheckCreate"
  | "gateCheckComplete",
  identity: Partial<{
    repositoryId: string;
    repositoryFullName: string;
    pullRequestNumber: string;
    controllerGeneration: string;
    reviewId: string;
  }> = {},
) {
  const expected: ExpectedGitHubPublicationPlan = {
    controllerGeneration: identity.controllerGeneration ?? "17",
    inputIdentity: digest("input"),
    reviewOutputDigest: digest("output"),
    repositoryId: identity.repositoryId ?? "42",
    repositoryFullName: identity.repositoryFullName ?? "acme/api",
    pullRequestNumber: identity.pullRequestNumber ?? "7",
    headSha: HEAD,
    mergeBaseSha: BASE,
    targetSha: TARGET,
    pullRequestTitle: TITLE,
    pullRequestBody: BODY,
  };
  const plan = buildPlan(
    expected,
    kind === "fileCommentFallback",
    kind === "relocatedReviewCreate",
    kind === "findingCommentUpdate",
    kind === "reviewSummaryUpdate",
  );
  const bytes = Buffer.from(`${JSON.stringify(plan)}\n`, "utf8");
  const accepted = parseGitHubPublicationPlanBytes(bytes, expected);
  const required = [accepted.value.operations.at(-1)!.operationKey];
  const controller = buildGitHubPublicationControllerManifest({
    acceptedPlan: accepted.value,
    acceptedPlanBytesDigest: `sha256:${accepted.digest}`,
    requiredTerminalOperationKeys: required,
    gateOutput: {
      conclusion: "success",
      title: "Publication complete",
      summary: "Every immutable operation reached a terminal result.",
      detailsUrl: "https://postil.dev/orgs/acme/runs/fixture",
    },
  });
  const index = kind === "gateCheckComplete"
    ? controller.value.operations.length - 1
    : kind === "gateCheckCreate"
      ? controller.value.operations.length - 2
    : controller.value.operations.findIndex((record) =>
        record.operation.kind === (kind === "relocatedReviewCreate" ? "reviewCreate" : kind) &&
        (kind !== "relocatedReviewCreate" || record.operation.attempt === "relocatedInline")
      );
  const record = controller.value.operations[index]!;
  const operation = (record.source === "cli"
    ? accepted.value.operations[index]
    : record.operation) as Record<string, any>;
  const dependencies = operation.dependencies.map((key: string) => {
    const rejectedPlacement = kind === "relocatedReviewCreate" && key.includes("initial-review-create");
    return dependencyEvidence(
      key,
      key.includes("gate-create") ? "gateCheckCreate" : key.includes("review-create") ? "reviewCreate" : "advisoryCheckCreate",
      key.includes("gate-create") ? "901" : key.includes("review-create") ? "501" : "801",
      rejectedPlacement ? "rejected" : key.includes("review-create") ? "partialObserved" : "created",
      rejectedPlacement,
    );
  });
  const desired = desiredPayload(operation);
  const claim: ClaimedGitHubPublicationOperation = {
    databaseEligibility: { currentSealedHighWater: true, dependenciesEligible: true, mutuallyExclusive: true },
    repositoryId: String(expected.repositoryId),
    databaseRepositoryId: String(expected.repositoryId),
    reviewId: identity.reviewId ?? "1",
    repositoryFullName: expected.repositoryFullName,
    pullRequestNumber: Number(expected.pullRequestNumber),
    publicationGeneration: String(expected.controllerGeneration),
    headSha: HEAD,
    operationKey: operation.operationKey,
    operationOrdinal: index + 1,
    operationSource: record.source,
    kind: operation.kind,
    acceptedPlanBytes: accepted.bytes,
    acceptedPlanDigest: accepted.digest,
    expectedPlan: expected,
    controllerManifestBytes: controller.bytes,
    controllerManifestDigest: controller.digest,
    controllerRecordBytes: controller.operationBytes[index]!,
    operationRecordBytes: Buffer.from(JSON.stringify(operation)),
    activationBytes: Buffer.from(JSON.stringify(operation.activation)),
    desiredPayloadBytes: Buffer.from(JSON.stringify(desired)),
    desiredPayloadDigest: operation.desiredDigest,
    dependencies,
    attemptNumber: 1,
    leaseGeneration: 1,
    leaseId: "11111111-1111-4111-8111-111111111111",
    claimedAt: NOW,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    claimOwner: "test-worker",
    retryAuthorization: { kind: "initial" },
    selectedVariant: operation.kind,
  };
  return { claim, controller, accepted };
}

function ambiguousFrom(
  claim: ClaimedGitHubPublicationOperation,
): AmbiguousGitHubPublicationOperation {
  const {
    databaseEligibility: _databaseEligibility,
    claimedAt: _claimedAt,
    leaseExpiresAt: _leaseExpiresAt,
    leaseId: _leaseId,
    claimOwner: _claimOwner,
    retryAuthorization: _retryAuthorization,
    ...snapshot
  } = claim;
  return {
    ...snapshot,
    ambiguousObservedAt: NOW,
    errorReason: "remote response was ambiguous",
  };
}

function buildPlan(
  expected: ExpectedGitHubPublicationPlan,
  withFallback: boolean,
  withRelocatedReview: boolean,
  withFindingUpdate: boolean,
  withSummary: boolean,
): Record<string, any> {
  const reviewMarker = marker("review", "receipt");
  const findingMarker = marker("finding", "finding-1");
  const create = operation(expected, "advisory-check-create", {
    kind: "advisoryCheckCreate",
    name: "postil/review",
    headSha: HEAD,
    status: "in_progress",
    externalId: `postil:postil/review:${HEAD}`,
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: { logicalIdentity: `postil:postil/review:${HEAD}`, exclusive: true },
  });
  const reviewIdentity = logicalReviewIdentity(expected);
  const review = operation(expected, "initial-review-create", {
    kind: "reviewCreate",
    attempt: "initial",
    logicalReviewIdentity: reviewIdentity,
    payload: {
      commitId: HEAD,
      event: "COMMENT",
      body: `Review summary\n\n${reviewMarker}`,
      ...(withFallback ? { comments: [{ path: "src/a.ts", line: 1, side: "RIGHT", body: `Finding\n\n${findingMarker}` }] } : {}),
    },
    activation: { anyOf: [{ condition: "markerAbsent", guard: { markers: [reviewMarker], headSha: HEAD, required: true } }] },
    reconciliation: { logicalIdentity: reviewIdentity, markers: [reviewMarker], exclusive: true },
  });
  const operations: Record<string, any>[] = [create, review];
  if (withRelocatedReview) {
    operations.push(operation(expected, "relocated-review-create", {
      kind: "reviewCreate",
      attempt: "relocatedInline",
      logicalReviewIdentity: reviewIdentity,
      payload: {
        commitId: HEAD,
        event: "COMMENT",
        body: `Relocated review summary\n\n${reviewMarker}`,
      },
      dependencies: [review.operationKey],
      activation: { anyOf: [{
        condition: "semanticPlacementRejected",
        dependencyOperationKey: review.operationKey,
        httpStatus: 422,
        classification: "invalidReviewCommentPlacement",
        markerAbsence: { markers: [reviewMarker], headSha: HEAD, required: true },
      }] },
      reconciliation: { logicalIdentity: reviewIdentity, markers: [reviewMarker], exclusive: true },
    }));
  }
  if (withFallback) {
    operations.push(operation(expected, "file-comment-fallback", {
      kind: "fileCommentFallback",
      findingId: "finding-1",
      payload: { body: `Finding\n\n${findingMarker}`, commitId: HEAD, path: "src/a.ts", subjectType: "file" },
      dependencies: [review.operationKey],
      activation: { anyOf: [{
        condition: "partialReviewObserved",
        dependencyOperationKey: review.operationKey,
        reviewMarkers: [reviewMarker],
        findingMarkerAbsence: { markers: [findingMarker], headSha: HEAD, required: true },
      }] },
      reconciliation: { logicalIdentity: "", markers: [findingMarker], exclusive: true },
      findingSalt: "finding-1",
    }));
    operations.at(-1)!.reconciliation.logicalIdentity = operations.at(-1)!.operationKey;
    operations.at(-1)!.desiredDigest = digestJson(desiredPayload(operations.at(-1)!));
  }
  if (withFindingUpdate) {
    operations.push(operation(expected, "finding-comment-update", {
      kind: "findingCommentUpdate",
      findingId: "finding-1",
      observedCommentId: "701",
      expectedMarkers: [findingMarker],
      body: `Updated finding\n\n${findingMarker}`,
      bodySha256: digest(`Updated finding\n\n${findingMarker}`),
      dependencies: [],
      activation: { anyOf: [{
        condition: "findingContentDiffers",
        observedCommentId: "701",
        expectedMarkers: [findingMarker],
      }] },
      reconciliation: {
        logicalIdentity: "",
        markers: [findingMarker],
        observedRemoteId: "701",
        exclusive: true,
      },
      findingSalt: "finding-1",
    }));
    operations.at(-1)!.reconciliation.logicalIdentity = operations.at(-1)!.operationKey;
    operations.at(-1)!.desiredDigest = digestJson(desiredPayload(operations.at(-1)!));
  }
  if (withSummary) {
    operations.push(operation(expected, "review-summary-update", {
      kind: "reviewSummaryUpdate",
      logicalReviewIdentity: reviewIdentity,
      terminalOperations: [],
      cases: [{
        selectedReviewOperationKey: review.operationKey,
        selectedReviewOutcomes: ["partialObserved"],
        fileCommentCount: 0,
        body: `Updated review summary\n\n${reviewMarker}`,
      }],
      dependencies: [review.operationKey],
      activation: { anyOf: [{
        condition: "reviewSelectionTerminal",
        selectedReviewOperationKeys: [review.operationKey],
      }] },
      reconciliation: { logicalIdentity: reviewIdentity, markers: [reviewMarker], exclusive: true },
    }));
  }
  const complete = operation(expected, "advisory-check-complete", {
    kind: "advisoryCheckComplete",
    name: "postil/review",
    headSha: HEAD,
    createdCheck: { dependencyOperationKey: create.operationKey, resultField: "remoteId" },
    conclusion: "success",
    title: "Review completed",
    summary: "Publication complete.",
    dependencies: withSummary
      ? [create.operationKey, operations.at(-1)!.operationKey]
      : operations.map((entry) => entry.operationKey),
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: { logicalIdentity: "", exclusive: true },
  });
  complete.reconciliation.logicalIdentity = complete.operationKey;
  complete.desiredDigest = digestJson(desiredPayload(complete));
  operations.push(complete);
  operations.forEach((entry, index) => { entry.ordinal = index + 1; });

  const findings = withFallback || withFindingUpdate ? [{
    findingId: "finding-1",
    stableIdentity: true,
    path: "src/a.ts",
    line: 1,
    initialOutcome: "inline",
    fallbackIntent: ["fileComment"],
    contentDigest: digest("finding-content"),
    marker: findingMarker,
    desiredBody: `Finding\n\n${findingMarker}`,
    desiredBodySha256: digest(`Finding\n\n${findingMarker}`),
    ...(withFindingUpdate ? {
      observedCommentId: "701",
      observedBodySha256: digest("old finding body"),
      observedOutcome: "fileComment",
      reconciliation: "replace",
    } : { reconciliation: "create" }),
    duplicateProvenance: "none",
  }] : [];
  const lifecycle: Record<string, any> = {
    version: 1,
    inputIdentity: expected.inputIdentity,
    channel: "reviewComments",
    receiptId: "receipt-1",
    duplicateOfBaseline: false,
    findings,
    digest: "",
  };
  lifecycle.digest = digestJson({
    version: 1,
    inputIdentity: lifecycle.inputIdentity,
    channel: lifecycle.channel,
    receiptId: lifecycle.receiptId,
    compatibleReceiptIds: [],
    observedReviewId: null,
    duplicateOfBaseline: false,
    findings,
  });
  const plan: Record<string, any> = {
    version: 1,
    forge: "github",
    controllerGeneration: String(expected.controllerGeneration),
    inputIdentity: expected.inputIdentity,
    reviewOutputDigest: expected.reviewOutputDigest,
    repository: {
      id: String(expected.repositoryId),
      fullName: expected.repositoryFullName,
    },
    pullRequestNumber: String(expected.pullRequestNumber),
    reviewedSnapshot: {
      headSha: HEAD,
      mergeBaseSha: BASE,
      targetSha: TARGET,
      pullRequestTitleSha256: digest(TITLE),
      pullRequestBodySha256: digest(BODY),
    },
    lifecycleReceipt: lifecycle,
    operationCount: operations.length,
    operationManifestDigest: digestJson(operations),
    operations,
    gateAnalysis: {
      ownership: "service",
      authoritative: false,
      organizationGateModeRequired: true,
      name: "postil/gate",
      headSha: HEAD,
      analyzedConclusion: "success",
      title: "Advisory analysis",
      summary: "The service owns the authoritative gate.",
    },
    intentDigest: "",
  };
  const { intentDigest: _, ...intent } = plan;
  plan.intentDigest = digestJson(intent);
  return plan;
}

function operation(expected: ExpectedGitHubPublicationPlan, keyKind: string, input: Record<string, any>) {
  const dependencies = input.dependencies ?? [];
  const findingSalt = input.findingSalt;
  const value: Record<string, any> = {
    ordinal: 0,
    operationKey: operationKey(expected, keyKind, findingSalt),
    dependencies,
    activation: input.activation,
    reconciliation: input.reconciliation,
    desiredDigest: "",
    ...Object.fromEntries(Object.entries(input).filter(([key]) => !["dependencies", "activation", "reconciliation", "findingSalt"].includes(key))),
  };
  value.desiredDigest = digestJson(desiredPayload(value));
  return value;
}

function operationKey(expected: ExpectedGitHubPublicationPlan, kind: string, findingId?: string): string {
  if (expected.reviewOutputDigest === undefined) throw new Error("review output digest is required");
  const hash = createHash("sha256").update("github-publication-operation-v1\0");
  for (const value of [
    String(expected.repositoryId),
    String(expected.pullRequestNumber),
    HEAD,
    String(expected.controllerGeneration),
    expected.inputIdentity,
    expected.reviewOutputDigest,
    kind,
  ]) hash.update(value).update("\0");
  if (findingId) hash.update(findingId);
  return `github-publication-v1:${kind}:sha256:${hash.digest("hex")}`;
}

function logicalReviewIdentity(expected: ExpectedGitHubPublicationPlan): string {
  if (expected.reviewOutputDigest === undefined) throw new Error("review output digest is required");
  const hash = createHash("sha256").update("github-publication-logical-review-v1\0");
  for (const value of [
    String(expected.repositoryId),
    String(expected.pullRequestNumber),
    HEAD,
    String(expected.controllerGeneration),
    expected.inputIdentity,
    expected.reviewOutputDigest,
  ]) hash.update(value).update("\0");
  return `github-publication-v1:review:sha256:${hash.digest("hex")}`;
}

function dependencyEvidence(
  operationKey: string,
  kind: string,
  remoteId: string,
  outcome: DurablePublicationDependencyEvidence["outcome"],
  rejectedPlacement = false,
): DurablePublicationDependencyEvidence {
  const result = { remoteId };
  return {
    operationKey,
    kind,
    state: "applied",
    outcome,
    remoteId,
    remoteOperationId: remoteId,
    result,
    resultDigest: digestJson(result),
    attemptNumber: 1,
    leaseGeneration: 1,
    observedAt: NOW,
    ...(rejectedPlacement ? { httpStatus: 422, classification: "invalidReviewCommentPlacement" as const } : {}),
  };
}

function desiredPayload(operation: Record<string, unknown>) {
  const { ordinal: _, operationKey: __, dependencies: ___, activation: ____, reconciliation: _____, desiredDigest: ______, ...desired } = operation;
  return desired;
}

function marker(kind: "review" | "finding", seed: string) {
  return `<!-- postil-${kind}:v2:${hex(seed)} -->`;
}

function digest(value: string) {
  return `sha256:${hex(value)}`;
}

function digestJson(value: unknown) {
  return digest(JSON.stringify(value));
}

function hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dispatchFixture(
  operation: Pick<
    ClaimedGitHubPublicationOperation,
    "desiredPayloadDigest" | "operationKey" | "selectedVariant"
  >,
): PublicationDispatchEvidence {
  return {
    requestDigest: operation.desiredPayloadDigest,
    operationKey: operation.operationKey,
    selectedVariant: operation.selectedVariant,
    activationVariant: "always",
    observedAt: NOW,
  };
}

async function skipSiblingOperations(
  pool: Pool,
  operation: Pick<
    ClaimedGitHubPublicationOperation,
    "databaseRepositoryId" | "pullRequestNumber" | "publicationGeneration" | "operationKey"
  >,
): Promise<void> {
  await pool.query(
    `UPDATE review_publication_operations
     SET state = 'skipped', terminal_evidence = '{"reason":"test sibling isolation"}'::jsonb
     WHERE repository_id = $1::bigint AND pr_number = $2
       AND publication_generation = $3::bigint AND operation_key <> $4
       AND state = 'pending'`,
    [
      operation.databaseRepositoryId,
      operation.pullRequestNumber,
      operation.publicationGeneration,
      operation.operationKey,
    ],
  );
}

function terminalFixture(
  operation: ClaimedGitHubPublicationOperation,
  dispatched: PublicationDispatchEvidence,
): PublicationTerminalEvidence {
  const result = { checkRunId: "81" };
  return {
    ...dispatched,
    outcome: "created",
    result,
    resultDigest: digestJson(result),
    remoteId: "81",
    remoteOperationId: "81",
  };
}

async function stageDatabaseFixture(pool: Pool, seed: number) {
  const organization = await pool.query<{ id: string }>(
    `INSERT INTO organizations (slug, name, github_org_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`publication-executor-${seed}`, `Publication executor ${seed}`, 700_000 + seed],
  );
  const installation = await pool.query<{ id: string }>(
    `INSERT INTO installations
       (github_installation_id, account_login, account_type, org_id)
     VALUES ($1, $2, 'Organization', $3) RETURNING id`,
    [800_000 + seed, `publication-executor-${seed}`, organization.rows[0]!.id],
  );
  const repositoryFullName = `publication-executor-${seed}/repository`;
  const repository = await pool.query<{ id: string }>(
    `INSERT INTO repositories
       (github_repo_id, installation_id, full_name, private, enabled)
     VALUES ($1, $2, $3, false, true) RETURNING id`,
    [900_000 + seed, installation.rows[0]!.id, repositoryFullName],
  );
  const repositoryId = repository.rows[0]!.id;
  const githubRepositoryId = String(900_000 + seed);
  const review = await pool.query<{ id: string }>(
    `INSERT INTO reviews
       (repository_id, pr_number, head_sha, base_sha, status, trigger_source, queued_at)
     VALUES ($1::bigint, 7, $2, $3, 'running', 'unknown', clock_timestamp())
     RETURNING id`,
    [repositoryId, HEAD, TARGET],
  );
  const fixture = fixtureFor("advisoryCheckCreate", {
    repositoryId: githubRepositoryId,
    repositoryFullName,
    reviewId: review.rows[0]!.id,
  });
  await stageGitHubPublicationControllerGeneration({
    database: pool,
    acceptedPlan: fixture.accepted,
    controllerManifest: fixture.controller,
    snapshot: {
      repositoryId,
      githubRepositoryId,
      reviewId: review.rows[0]!.id,
      reviewInputSequence: "1",
      expectedPullRequestUpdatedAt: "2026-08-15T00:00:00.000Z",
      envelopeDigest: hex(`envelope-${seed}`),
      targetBranch: "main",
      pullRequestTitle: TITLE,
      pullRequestBody: BODY,
    },
  });
  return fixture;
}
