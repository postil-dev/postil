import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { buildGitHubPublicationControllerManifest } from "@/lib/github-publication-controller-manifest";
import { stageGitHubPublicationControllerGeneration } from "@/lib/github-publication-controller-store";
import { buildGitHubPublicationInputIdentity } from "@/lib/github-publication-cli-planner";
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
import { schema } from "@/lib/db";
import { finalizePublicationControllerReview } from "@/lib/review-completion";
import { claimPublicationControllerReviewJob } from "@/lib/queue";
import { publicationControllerRemoteCheckRunId } from "@/worker/review";
import {
  parseGitHubPublicationPlanBytes,
  type ExpectedGitHubPublicationPlan,
} from "@/lib/github-publication-plan";
import {
  GitHubPublicationAmbiguousError,
  GitHubPublicationRejectedError,
  GitHubReviewPlacementRejectedError,
  type GitHubCheckRunCompletionIntent,
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
const DETAILS_URL = "https://postil.dev/orgs/acme/runs/fixture";
const POLICY_SUCCESS_OUTPUT = {
  conclusion: "success" as const,
  title: "Publication complete",
  summary: "Every immutable operation reached a terminal result.",
  detailsUrl: DETAILS_URL,
};
const POLICY_FAILURE_OUTPUT = {
  conclusion: "failure" as const,
  title: "Policy rejected the review",
  summary: "A required policy condition did not pass.",
  detailsUrl: DETAILS_URL,
};
const PUBLICATION_FAILURE_OUTPUT = {
  conclusion: "failure" as const,
  title: "Review publication incomplete",
  summary: "Postil could not publish all required review results. The merge check remains blocked.",
  detailsUrl: DETAILS_URL,
};
const SNAPSHOT_DRIFT_CASES = [
  { name: "head SHA drift", liveSnapshot: { headSha: "d".repeat(40) }, mismatch: "headSha" },
  { name: "target SHA drift", liveSnapshot: { baseSha: "d".repeat(40) }, mismatch: "targetSha" },
  { name: "merge-base SHA drift", liveSnapshot: { mergeBaseSha: "d".repeat(40) }, mismatch: "mergeBaseSha" },
  { name: "target branch drift", liveSnapshot: { targetBranch: "release" }, mismatch: "targetBranch" },
  { name: "title drift", liveSnapshot: { title: "Changed title" }, mismatch: "title" },
  { name: "body drift", liveSnapshot: { body: "Changed body" }, mismatch: "body" },
  { name: "draft pull request", liveSnapshot: { draft: true }, mismatch: "draft" },
  { name: "closed pull request", liveSnapshot: { open: false }, mismatch: "open" },
  { name: "merged pull request", liveSnapshot: { open: false, merged: true }, mismatch: "merged" },
  { name: "updated-at drift", liveSnapshot: { updatedAt: "2026-08-15T00:00:01.000Z" }, mismatch: "updatedAt" },
] as const;

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

  for (const snapshotCase of SNAPSHOT_DRIFT_CASES) {
    test(`supersedes without a mutation on ${snapshotCase.name}`, async () => {
      const fixture = fixtureFor("advisoryCheckCreate");
      const store = new MemoryStore([fixture.claim]);
      const adapters = fakeAdapters({ liveSnapshot: snapshotCase.liveSnapshot });

      await expect(run(store, adapters)).resolves.toMatchObject({
        status: "superseded",
        shouldContinue: true,
      });
      expect(mutationCalls(adapters.calls)).toEqual([]);
      expect(store.ambiguous).toHaveLength(0);
      expect(store.terminal.at(-1)).toMatchObject({
        outcome: "superseded",
        result: {
          dispatched: false,
          mismatches: expect.arrayContaining([snapshotCase.mismatch]),
        },
      });
    });
  }

  test("mutates only after the exact live pull request snapshot is observed", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters({ createdCheckId: "81" });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeCheck",
      "getPullRequestPublicationContext",
      "createCheck",
    ]);
    expect(store.terminal.at(-1)).toMatchObject({ outcome: "created", remoteId: "81" });
  });

  test("reconciles an existing create without issuing a second mutation", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters({ existingCheckId: "71" });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "skipped", shouldContinue: true });
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeCheck",
    ]);
    expect(store.terminal.at(-1)).toMatchObject({ outcome: "reconciledExisting", remoteId: "71" });
  });

  test("records a failed live observation as not dispatched", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters({ failCheckObservation: true });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "unknown", shouldContinue: false });
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeCheck",
    ]);
    expect(store.notDispatched).toHaveLength(1);
  });

  test("records a failed live snapshot read as not dispatched", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters({ failSnapshotObservation: true });

    await expect(run(store, adapters)).resolves.toMatchObject({
      status: "unknown",
      shouldContinue: false,
    });
    expect(adapters.calls).toEqual(["getPullRequestPublicationContext"]);
    expect(mutationCalls(adapters.calls)).toEqual([]);
    expect(store.notDispatched).toHaveLength(1);
    expect(store.ambiguous).toHaveLength(0);
  });

  test("uses the exact gate creation dependency remote ID for completion", async () => {
    const fixture = fixtureFor("gateCheckComplete");
    const store = new MemoryStore([fixture.claim]);
    const gateCreate = fixture.controller.value.operations.find((record) => record.operation.kind === "gateCheckCreate")!;
    const expectedExternalId = (gateCreate.operation.payload as { externalId: string }).externalId;
    const adapters = fakeAdapters({ expectedCompletionExternalId: expectedExternalId });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "getPullRequestPublicationContext",
      "completeCheck:901",
    ]);
    expect(selectedOutput(adapters.completedCheckIntents.at(-1))).toEqual(POLICY_SUCCESS_OUTPUT);
    expect(store.terminal.at(-1)).toMatchObject({ outcome: "applied", remoteId: "901" });
  });

  test("preserves an authoritative policy failure after required publication fails", async () => {
    const fixture = fixtureFor("gateCheckComplete", {
      requiredDependencyState: "failed",
      gateOutput: POLICY_FAILURE_OUTPUT,
    });
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(selectedOutput(adapters.completedCheckIntents.at(-1))).toEqual(POLICY_FAILURE_OUTPUT);
  });

  test("fails the gate when a required publication dependency definitively fails", async () => {
    const fixture = fixtureFor("gateCheckComplete", { requiredDependencyState: "failed" });
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(selectedOutput(adapters.completedCheckIntents.at(-1))).toEqual(PUBLICATION_FAILURE_OUTPUT);
    expect(store.terminal.at(-1)?.activationVariant).toBe(
      "all-dependencies-terminal:publication-failure",
    );
  });

  test("fails the gate when a required publication dependency is superseded", async () => {
    const fixture = fixtureFor("gateCheckComplete", { requiredDependencyState: "superseded" });
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(selectedOutput(adapters.completedCheckIntents.at(-1))).toEqual(PUBLICATION_FAILURE_OUTPUT);
  });

  test("keeps the policy output when a required publication dependency was legitimately skipped", async () => {
    const fixture = fixtureFor("gateCheckComplete", { requiredDependencyState: "skipped" });
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(selectedOutput(adapters.completedCheckIntents.at(-1))).toEqual(POLICY_SUCCESS_OUTPUT);
  });

  test("executes advisory completion and service gate creation as separate immutable mutations", async () => {
    const advisory = fixtureFor("advisoryCheckComplete");
    const advisoryStore = new MemoryStore([advisory.claim]);
    const advisoryAdapters = fakeAdapters();
    await expect(run(advisoryStore, advisoryAdapters)).resolves.toMatchObject({ status: "applied" });
    expect(advisoryAdapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "getPullRequestPublicationContext",
      "completeCheck:801",
    ]);

    const gate = fixtureFor("gateCheckCreate");
    const gateStore = new MemoryStore([gate.claim]);
    const gateAdapters = fakeAdapters({ createdCheckId: "901" });
    await expect(run(gateStore, gateAdapters)).resolves.toMatchObject({ status: "applied" });
    expect(gateAdapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeCheck",
      "getPullRequestPublicationContext",
      "createCheck",
    ]);
    expect(gateStore.terminal.at(-1)).toMatchObject({ outcome: "created", remoteId: "901" });
  });

  test("retains ambiguity and does not dispatch a second write without a new database claim", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters({ ambiguousCreate: true });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "unknown", shouldContinue: false });
    await expect(run(store, adapters)).resolves.toEqual({ status: "idle", shouldContinue: false });
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeCheck",
      "getPullRequestPublicationContext",
      "createCheck",
    ]);
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
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeReview",
      "getPullRequestPublicationContext",
      "publishReview",
    ]);
  });

  test("activates the relocated review only from exact semantic 422 evidence and live marker absence", async () => {
    const fixture = fixtureFor("relocatedReviewCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied", shouldContinue: true });
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeReview",
      "getPullRequestPublicationContext",
      "publishReview",
    ]);
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
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeReview",
      "getPullRequestPublicationContext",
      "publishFileComment",
    ]);
    expect(store.terminal.at(-1)).toMatchObject({ outcome: "created", remoteId: "601" });
  });

  test("updates a finding comment only after an exact live content comparison", async () => {
    const fixture = fixtureFor("findingCommentUpdate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeReviewComment",
      "getPullRequestPublicationContext",
      "updateReviewComment",
    ]);
    expect(store.terminal.at(-1)).toMatchObject({ outcome: "applied", remoteId: "701" });
  });

  test("selects one durable review result before updating its summary", async () => {
    const fixture = fixtureFor("reviewSummaryUpdate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "getPullRequestPublicationContext",
      "updateReviewSummary",
    ]);
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

  test("reconciles an unknown superseded generation before dispatch authorization", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([], [ambiguousFrom(fixture.claim)]);
    const adapters = fakeAdapters({ existingCheckId: "81" });

    await expect(run(store, adapters, async () => false)).resolves.toMatchObject({
      status: "applied",
      shouldContinue: true,
    });
    expect(adapters.calls).toEqual(["observeCheck"]);
    expect(mutationCalls(adapters.calls)).toEqual([]);
    expect(store.reconciled).toHaveLength(1);
  });

  test("returns an expired applying claim to recovery without stale dispatch", async () => {
    const fixture = fixtureFor("advisoryCheckCreate");
    const store = new MemoryStore([fixture.claim]);
    const adapters = fakeAdapters();

    await expect(run(store, adapters, async () => false)).resolves.toMatchObject({
      status: "unknown",
      shouldContinue: false,
    });
    expect(adapters.calls).toEqual([]);
    expect(store.notDispatched).toHaveLength(1);
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
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeCheck",
      "observeCheck",
      "getPullRequestPublicationContext",
      "createCheck",
    ]);
    expect(adapters.calls.filter((call) => call === "createCheck")).toHaveLength(1);
  });

  test("supersedes an exact-absence retry when the live snapshot has drifted", async () => {
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
    const adapters = fakeAdapters({
      liveSnapshots: [{}, { headSha: "d".repeat(40) }],
    });

    await expect(run(store, adapters)).resolves.toMatchObject({
      status: "superseded",
      shouldContinue: true,
    });
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeCheck",
      "observeCheck",
      "getPullRequestPublicationContext",
    ]);
    expect(mutationCalls(adapters.calls)).toEqual([]);
    expect(store.ambiguous).toHaveLength(0);
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

  test("reconciles an ambiguous gate completion against the selected failure output", async () => {
    const fixture = fixtureFor("gateCheckComplete", { requiredDependencyState: "failed" });
    const store = new MemoryStore([], [ambiguousFrom(fixture.claim)]);
    const adapters = fakeAdapters({ checkCompletionState: "applied" });

    await expect(run(store, adapters)).resolves.toMatchObject({
      status: "applied",
      shouldContinue: true,
    });
    expect(selectedOutput(adapters.observedCheckCompletionIntents.at(-1))).toEqual(
      PUBLICATION_FAILURE_OUTPUT,
    );
    expect(store.reconciled.at(-1)?.activationVariant).toBe("ambiguity-reconciliation");
  });

  test("uses the selected failure output for retry observation and dispatch", async () => {
    const fixture = fixtureFor("gateCheckComplete", { requiredDependencyState: "failed" });
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
      evidenceDigest: digest("gate absence evidence"),
    };
    const store = new MemoryStore([claim]);
    const adapters = fakeAdapters({ checkCompletionState: "retryable" });

    await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
    expect(selectedOutput(adapters.observedCheckCompletionIntents.at(-1))).toEqual(
      PUBLICATION_FAILURE_OUTPUT,
    );
    expect(selectedOutput(adapters.completedCheckIntents.at(-1))).toEqual(
      PUBLICATION_FAILURE_OUTPUT,
    );
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
    await pool.query(
      `DELETE FROM jobs
       WHERE locked_by = 'supersession-authority'
          OR payload->>'_postilPublicationControllerReleaseSha' = $1`,
      ["e".repeat(40)],
    );
    await pool.query(
      `DELETE FROM deployment_capabilities
       WHERE name IN ($1, $2)`,
      [
        `publication-controller-release:${"e".repeat(40)}`,
        `publication-controller-consumer-ready:${"e".repeat(40)}`,
      ],
    );
    await pool.query(`DELETE FROM repositories WHERE full_name LIKE 'publication-executor-%'`);
  });

  test("claims only the exact repository and generation assigned to the worker", async () => {
    const unrelated = await stageDatabaseFixture(pool, 106);
    const assigned = await stageDatabaseFixture(pool, 107);
    const store = new PostgresGitHubPublicationOperationStore(pool, assigned);

    const claim = await store.claimOneEligible({
      claimOwner: "scoped-worker",
      leaseId: randomUUID(),
      leaseDurationMs: 60_000,
    });

    expect(claim).toMatchObject({
      databaseRepositoryId: assigned.databaseRepositoryId,
      pullRequestNumber: assigned.pullRequestNumber,
      publicationGeneration: assigned.publicationGeneration,
    });
    expect(claim?.databaseRepositoryId).not.toBe(
      unrelated.databaseRepositoryId,
    );
  });

  test("records each pending supersession as one immutable no-write attempt", async () => {
    const scope = await stageDatabaseFixture(pool, 501);
    await claimControllerSupersessionAuthority(pool, scope);
    const first = new PostgresGitHubPublicationOperationStore(pool, scope);
    const second = new PostgresGitHubPublicationOperationStore(pool, scope);
    const selected = await pool.query<{ operation_key: string }>(
      `SELECT operation_key
         FROM review_publication_operations
        WHERE repository_id = $1::bigint AND pr_number = $2
          AND publication_generation = $3::bigint
        ORDER BY operation_ordinal
        LIMIT 1`,
      [scope.databaseRepositoryId, scope.pullRequestNumber, scope.publicationGeneration],
    );
    const operationKey = selected.rows[0]!.operation_key;

    const raced = await Promise.all([
      first.supersedeOnePending(operationKey),
      second.supersedeOnePending(operationKey),
    ]);
    expect(raced.sort()).toEqual([false, true]);
    expect(await first.supersedeOnePending(operationKey)).toBe(false);

    const stored = await pool.query<{
      operation_key: string;
      state: string;
      attempt_count: number;
      attempt_rows: number;
      distinct_attempt_rows: number;
      phases: string[];
    }>(
      `SELECT operation.operation_key, operation.state,
              operation.attempt_count,
              count(attempt.id)::integer AS attempt_rows,
              count(DISTINCT (
                attempt.attempt_number,
                attempt.lease_generation,
                attempt.phase
              ))::integer AS distinct_attempt_rows,
              array_agg(attempt.phase ORDER BY attempt.id) AS phases
         FROM review_publication_operations operation
         JOIN review_publication_operation_attempts attempt
           ON attempt.repository_id = operation.repository_id
          AND attempt.pr_number = operation.pr_number
          AND attempt.publication_generation = operation.publication_generation
          AND attempt.operation_key = operation.operation_key
        WHERE operation.repository_id = $1::bigint
          AND operation.pr_number = $2
          AND operation.publication_generation = $3::bigint
          AND operation.operation_key = $4
          AND operation.state = 'superseded'
        GROUP BY operation.operation_key, operation.operation_ordinal,
                 operation.state, operation.attempt_count
        ORDER BY operation.operation_ordinal`,
      [
        scope.databaseRepositoryId,
        scope.pullRequestNumber,
        scope.publicationGeneration,
        operationKey,
      ],
    );
    expect(stored.rows).toHaveLength(1);
    for (const row of stored.rows) {
      expect(row.attempt_count).toBe(1);
      expect(row.attempt_rows).toBe(1);
      expect(row.distinct_attempt_rows).toBe(1);
      expect(row.phases).toEqual(["not_dispatched"]);
    }
  });

  test("rejects supersession without exact controller authority", async () => {
    const scope = await stageDatabaseFixture(pool, 519);
    const store = new PostgresGitHubPublicationOperationStore(pool, scope);

    await expect(store.supersedeOnePending()).rejects.toThrow(
      "attempt evidence must match the active publication lease",
    );
  });

  test("loads a reconciled-existing check identity from skipped terminal evidence", async () => {
    const scope = await stageDatabaseFixture(pool, 502);
    await pool.query(
      `UPDATE review_publication_operations
          SET state = 'skipped',
              terminal_evidence =
                '{"outcome":"reconciledExisting","remoteId":"811","remoteOperationId":"811","result":{"checkRunId":"811"}}'::jsonb,
              updated_at = clock_timestamp()
        WHERE repository_id = $1::bigint AND pr_number = $2
          AND publication_generation = $3::bigint
          AND kind = 'advisoryCheckCreate'`,
      [scope.databaseRepositoryId, scope.pullRequestNumber, scope.publicationGeneration],
    );

    await expect(publicationControllerRemoteCheckRunId(
      {
        ...scope,
        reviewId: 1,
        acceptedInputIdentity: `sha256:${"0".repeat(64)}`,
      },
      "advisoryCheckCreate",
      pool,
    )).resolves.toBe(811);
  });

  test("atomically settles an exact receipt, accounting, review, and job", async () => {
    const fixture = await stageFinalizationFixture(pool, 503);
    await terminalizeFinalizationOperations(pool, fixture.scope, "success");

    const result = await finalizePublicationControllerReview(
      drizzle(pool, { schema }),
      fixture.input,
      fixture.orgId,
    );

    expect(result.completed).toBe(true);
    expect(result.superseded).toBeUndefined();
    expect(await finalizationSnapshot(pool, fixture)).toMatchObject({
      reviewStatus: "completed",
      jobStatus: "done",
      receipts: 1,
      usageEvents: 1,
    });
  });

  test("settles required publication failure without inventing a receipt", async () => {
    const fixture = await stageFinalizationFixture(pool, 504);
    await terminalizeFinalizationOperations(pool, fixture.scope, "required-failure");

    const result = await finalizePublicationControllerReview(
      drizzle(pool, { schema }),
      { ...fixture.input, outcome: "definitive-failure", publicationReceipt: undefined },
      fixture.orgId,
    );

    expect(result.completed).toBe(true);
    expect(await finalizationSnapshot(pool, fixture)).toMatchObject({
      reviewStatus: "failed",
      jobStatus: "done",
      receipts: 0,
      usageEvents: 1,
    });
  });

  test("keeps policy failure as a receipt-backed reviewer verdict", async () => {
    const fixture = await stageFinalizationFixture(pool, 505, { gateFailing: true });
    await terminalizeFinalizationOperations(pool, fixture.scope, "success");

    const result = await finalizePublicationControllerReview(
      drizzle(pool, { schema }),
      fixture.input,
      fixture.orgId,
    );

    expect(result).toMatchObject({ completed: true, gateFailing: true });
    expect(await finalizationSnapshot(pool, fixture)).toMatchObject({
      reviewStatus: "completed",
      jobStatus: "done",
      receipts: 1,
    });
  });

  test("accepts a failed placement predecessor when its fallback is terminal", async () => {
    const fixture = await stageFinalizationFixture(pool, 506, {
      placementFallback: true,
    });
    await terminalizeFinalizationOperations(pool, fixture.scope, "placement-fallback");

    const result = await finalizePublicationControllerReview(
      drizzle(pool, { schema }),
      fixture.input,
      fixture.orgId,
    );

    expect(result.completed).toBe(true);
    expect(await finalizationSnapshot(pool, fixture)).toMatchObject({
      reviewStatus: "completed",
      receipts: 1,
    });
  });

  test("refuses active operations and a missing terminal gate", async () => {
    const active = await stageFinalizationFixture(pool, 507);
    await expect(finalizePublicationControllerReview(
      drizzle(pool, { schema }),
      active.input,
      active.orgId,
    )).rejects.toThrow("terminal gate evidence");

    const missingGate = await stageFinalizationFixture(pool, 508);
    await terminalizeFinalizationOperations(pool, missingGate.scope, "missing-gate");
    await expect(finalizePublicationControllerReview(
      drizzle(pool, { schema }),
      missingGate.input,
      missingGate.orgId,
    )).rejects.toThrow("terminal gate evidence");
  });

  test("settles coalesced supersession and promotes exactly one successor", async () => {
    const fixture = await stageFinalizationFixture(pool, 509, { coalesced: true });
    await claimControllerSupersessionAuthority(pool, fixture.scope);
    await terminalizeAllAsSuperseded(pool, fixture.scope);

    const result = await finalizePublicationControllerReview(
      drizzle(pool, { schema }),
      { ...fixture.input, outcome: "superseded", publicationReceipt: undefined },
      fixture.orgId,
    );

    expect(result).toMatchObject({ completed: false, superseded: true, promoted: true });
    expect(await finalizationSnapshot(pool, fixture)).toMatchObject({
      reviewStatus: "stale",
      jobStatus: "done",
      receipts: 0,
      promotedJobs: 1,
    });
  });

  test("does not claim settlement after losing the exact queue lease", async () => {
    const fixture = await stageFinalizationFixture(pool, 510);
    await terminalizeFinalizationOperations(pool, fixture.scope, "success");
    const result = await finalizePublicationControllerReview(
      drizzle(pool, { schema }),
      {
        ...fixture.input,
        reviewJobLease: { ...fixture.input.reviewJobLease, lockGeneration: 2n },
      },
      fixture.orgId,
    );

    expect(result.completed).toBe(false);
    expect(await finalizationSnapshot(pool, fixture)).toMatchObject({
      reviewStatus: "running",
      jobStatus: "running",
      receipts: 0,
      usageEvents: 0,
    });
  });

  test("rejects caller-invented stale and definitive terminal classes", async () => {
    const stale = await stageFinalizationFixture(pool, 511);
    await terminalizeFinalizationOperations(pool, stale.scope, "success");
    await expect(finalizePublicationControllerReview(
      drizzle(pool, { schema }),
      { ...stale.input, outcome: "superseded", publicationReceipt: undefined },
      stale.orgId,
    )).rejects.toThrow("does not match durable evidence");

    const failed = await stageFinalizationFixture(pool, 512);
    await terminalizeFinalizationOperations(pool, failed.scope, "success");
    await expect(finalizePublicationControllerReview(
      drizzle(pool, { schema }),
      {
        ...failed.input,
        outcome: "definitive-failure",
        publicationReceipt: undefined,
      },
      failed.orgId,
    )).rejects.toThrow("does not match durable evidence");

    expect((await finalizationSnapshot(pool, stale)).reviewStatus).toBe("running");
    expect((await finalizationSnapshot(pool, failed)).reviewStatus).toBe("running");
  });

  for (const [index, snapshotCase] of SNAPSHOT_DRIFT_CASES.entries()) {
    test(`stores no-write superseded evidence for ${snapshotCase.name}`, async () => {
      const scope = await stageDatabaseFixture(pool, 201 + index);
      const store = new PostgresGitHubPublicationOperationStore(pool, scope);
      const adapters = fakeAdapters({ liveSnapshot: snapshotCase.liveSnapshot });

      await expect(run(store, adapters)).resolves.toMatchObject({
        status: "superseded",
        shouldContinue: true,
      });
      expect(mutationCalls(adapters.calls)).toEqual([]);

      const stored = await pool.query<{
        state: string;
        phases: string[];
        outcome: string | null;
        dispatched: boolean | null;
        mismatches: string[] | null;
      }>(
        `SELECT operation.state,
                operation.terminal_evidence->>'outcome' AS outcome,
                (operation.terminal_evidence->'result'->>'dispatched')::boolean AS dispatched,
                ARRAY(
                  SELECT jsonb_array_elements_text(
                    operation.terminal_evidence->'result'->'mismatches'
                  )
                ) AS mismatches,
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
           AND operation.state = 'superseded'`,
        [
          scope.databaseRepositoryId,
          scope.pullRequestNumber,
          scope.publicationGeneration,
        ],
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]).toMatchObject({
        state: "superseded",
        phases: ["claimed", "not_dispatched"],
        outcome: "superseded",
        dispatched: false,
        mismatches: expect.arrayContaining([snapshotCase.mismatch]),
      });
    });
  }

  test("executes from the exact PostgreSQL operation snapshot", async () => {
    const scope = await stageDatabaseFixture(pool, 220);
    const store = new PostgresGitHubPublicationOperationStore(pool, scope);
    const adapters = fakeAdapters({ createdCheckId: "81" });

    await expect(run(store, adapters)).resolves.toMatchObject({
      status: "applied",
      shouldContinue: true,
    });
    expect(adapters.calls).toEqual([
      "getPullRequestPublicationContext",
      "observeCheck",
      "getPullRequestPublicationContext",
      "createCheck",
    ]);

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
         AND operation.state = 'applied'`,
      [
        scope.databaseRepositoryId,
        scope.pullRequestNumber,
        scope.publicationGeneration,
      ],
    );
    expect(stored.rows).toEqual([
      { state: "applied", phases: ["claimed", "dispatched", "applied"] },
    ]);
  });

  test("claims one current sealed operation under concurrent workers and appends each phase once", async () => {
    const scope = await stageDatabaseFixture(pool, 101);
    const first = new PostgresGitHubPublicationOperationStore(pool, scope);
    const second = new PostgresGitHubPublicationOperationStore(pool, scope);
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
    const scope = await stageDatabaseFixture(pool, 104);
    const store = new PostgresGitHubPublicationOperationStore(pool, scope);
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
    const scope = await stageDatabaseFixture(pool, 105);
    const store = new PostgresGitHubPublicationOperationStore(pool, scope);
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
    const scope = await stageDatabaseFixture(pool, 102);
    const store = new PostgresGitHubPublicationOperationStore(pool, scope);
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
    const scope = await stageDatabaseFixture(pool, 103);
    const store = new PostgresGitHubPublicationOperationStore(pool, scope);
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

  test("selects terminal gate output from PostgreSQL dependency evidence", async () => {
    const cases = [
      { seed: 108, state: "skipped" as const, policyConclusion: "success" as const, expectedOutput: POLICY_SUCCESS_OUTPUT },
      { seed: 109, state: "skipped" as const, policyConclusion: "failure" as const, expectedOutput: POLICY_FAILURE_OUTPUT },
      { seed: 110, state: "failed" as const, policyConclusion: "success" as const, expectedOutput: PUBLICATION_FAILURE_OUTPUT },
      { seed: 111, state: "superseded" as const, policyConclusion: "success" as const, expectedOutput: PUBLICATION_FAILURE_OUTPUT },
    ];

    for (const scenario of cases) {
      const gateOutput = scenario.policyConclusion === "failure"
        ? POLICY_FAILURE_OUTPUT
        : undefined;
      const scope = await stageDatabaseFixture(pool, scenario.seed, { gateOutput });
      if (scenario.state === "superseded") {
        await claimControllerSupersessionAuthority(pool, scope);
      }
      await terminalizeGateDependencies(pool, scope, scenario.state);
      const store = new PostgresGitHubPublicationOperationStore(pool, scope);
      const adapters = fakeAdapters();

      await expect(run(store, adapters)).resolves.toMatchObject({ status: "applied" });
      expect(selectedOutput(adapters.completedCheckIntents.at(-1))).toEqual(
        scenario.expectedOutput,
      );
    }
  });

  test("reconciles an ambiguous PostgreSQL gate completion against the selected output", async () => {
    const scope = await stageDatabaseFixture(pool, 112);
    await terminalizeGateDependencies(pool, scope, "failed");
    const store = new PostgresGitHubPublicationOperationStore(pool, scope);
    const ambiguousAdapters = fakeAdapters({ ambiguousCompletion: true });

    await expect(run(store, ambiguousAdapters)).resolves.toMatchObject({
      status: "unknown",
      shouldContinue: false,
    });
    expect(selectedOutput(ambiguousAdapters.completedCheckIntents.at(-1))).toEqual(
      PUBLICATION_FAILURE_OUTPUT,
    );

    const reconciliationAdapters = fakeAdapters({ checkCompletionState: "applied" });
    await expect(run(store, reconciliationAdapters)).resolves.toMatchObject({
      status: "applied",
      shouldContinue: true,
    });
    expect(selectedOutput(reconciliationAdapters.observedCheckCompletionIntents.at(-1))).toEqual(
      PUBLICATION_FAILURE_OUTPUT,
    );
  });
});

function run(
  store: GitHubPublicationOperationStore,
  adapters: GitHubPublicationAdapters & { calls: string[] },
  dispatchAuthorized?: () => Promise<boolean>,
) {
  return executeOneGitHubPublicationOperation({
    store,
    token: "test-token",
    appId: 41,
    claimOwner: "test-worker",
    leaseDurationMs: 60_000,
    adapters,
    now: () => NOW,
    leaseId: () => "11111111-1111-4111-8111-111111111111",
    ...(dispatchAuthorized ? { dispatchAuthorized } : {}),
  });
}

function mutationCalls(calls: readonly string[]): string[] {
  return calls.filter((call) =>
    call === "publishReview" ||
    call === "publishFileComment" ||
    call === "updateReviewComment" ||
    call === "updateReviewSummary" ||
    call === "createCheck" ||
    call.startsWith("completeCheck:")
  );
}

function selectedOutput(intent: GitHubCheckRunCompletionIntent | undefined) {
  if (intent === undefined) throw new Error("expected a check completion intent");
  return {
    conclusion: intent.conclusion,
    title: intent.title,
    summary: intent.summary,
    detailsUrl: intent.detailsUrl,
  };
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

  async finishSuperseded(_claim: ClaimedGitHubPublicationOperation, evidence: PublicationTerminalEvidence) {
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

type LiveSnapshotOverride = Partial<{
  headSha: string;
  baseSha: string;
  open: boolean;
  merged: boolean;
  draft: boolean;
  updatedAt: string;
  mergeBaseSha: string;
  targetBranch: string;
  title: string;
  body: string;
}>;

function fakeAdapters(options: {
  existingCheckId?: string;
  createdCheckId?: string;
  ambiguousCreate?: boolean;
  rejectPlacement?: boolean;
  partialReviewId?: string;
  createdCommentId?: string;
  expectedCompletionExternalId?: string;
  failCheckObservation?: boolean;
  failSnapshotObservation?: boolean;
  exactReviewComment?: boolean;
  observedReviewBody?: string;
  checkCompletionState?: "applied" | "retryable" | "conflict";
  liveSnapshot?: LiveSnapshotOverride;
  liveSnapshots?: readonly LiveSnapshotOverride[];
  ambiguousCompletion?: boolean;
} = {}): GitHubPublicationAdapters & {
  calls: string[];
  completedCheckIntents: GitHubCheckRunCompletionIntent[];
  observedCheckCompletionIntents: GitHubCheckRunCompletionIntent[];
} {
  const calls: string[] = [];
  const liveSnapshots = [...(options.liveSnapshots ?? [])];
  const completedCheckIntents: GitHubCheckRunCompletionIntent[] = [];
  const observedCheckCompletionIntents: GitHubCheckRunCompletionIntent[] = [];
  return {
    calls,
    completedCheckIntents,
    observedCheckCompletionIntents,
    async getPullRequestPublicationContext() {
      calls.push("getPullRequestPublicationContext");
      if (options.failSnapshotObservation) {
        throw new Error("pull request snapshot is unavailable");
      }
      const liveSnapshot = liveSnapshots.shift() ?? options.liveSnapshot;
      return {
        headSha: HEAD,
        baseSha: TARGET,
        open: true,
        merged: false,
        draft: false,
        updatedAt: "2026-08-15T00:00:00.000Z",
        mergeBaseSha: BASE,
        targetBranch: "main",
        title: TITLE,
        body: BODY,
        ...liveSnapshot,
      };
    },
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
      completedCheckIntents.push(intent);
      calls.push(`completeCheck:${intent.checkRunId}`);
      if (options.ambiguousCompletion) {
        throw new GitHubPublicationAmbiguousError("check-run completion");
      }
    },
    async observeCheckCompletion(_token, _repo, intent) {
      observedCheckCompletionIntents.push(intent);
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
    databaseRepositoryId: string;
    repositoryId: string;
    repositoryFullName: string;
    pullRequestNumber: string;
    controllerGeneration: string;
    reviewId: string;
    requiredDependencyState: DurablePublicationDependencyEvidence["state"];
    gateOutput: {
      conclusion: "success" | "failure" | "neutral";
      title: string;
      summary: string;
      detailsUrl: string;
    };
  }> = {},
) {
  const inputIdentity = buildGitHubPublicationInputIdentity({
    databaseRepositoryId:
      identity.databaseRepositoryId ?? identity.repositoryId ?? "42",
    githubRepositoryId: identity.repositoryId ?? "42",
    repositoryFullName: identity.repositoryFullName ?? "acme/api",
    pullRequestNumber: identity.pullRequestNumber ?? "7",
    controllerGeneration: identity.controllerGeneration ?? "17",
    reviewId: identity.reviewId ?? "1",
    headSha: HEAD,
    mergeBaseSha: BASE,
    targetSha: TARGET,
    targetBranch: "main",
    pullRequestTitle: TITLE,
    pullRequestBody: BODY,
    expectedPullRequestUpdatedAt: "2026-08-15T00:00:00.000Z",
    cliVersion: "0.8.17",
    cliCommitSha: "d".repeat(40),
    cliArtifactSha256: digest("CLI artifact"),
    configurationSha256: digest("configuration"),
    providerIdentity: "provider:test",
    retryLineage: "initial",
    bounded: false,
    forceFullReview: false,
    detailsUrl: "https://postil.dev/orgs/acme/runs/fixture",
  });
  const expected: ExpectedGitHubPublicationPlan = {
    controllerGeneration: identity.controllerGeneration ?? "17",
    inputIdentity: inputIdentity.digest,
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
    gateOutput: identity.gateOutput ?? {
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
    const evidence = dependencyEvidence(
      key,
      key.includes("gate-create") ? "gateCheckCreate" : key.includes("review-create") ? "reviewCreate" : "advisoryCheckCreate",
      key.includes("gate-create") ? "901" : key.includes("review-create") ? "501" : "801",
      rejectedPlacement ? "rejected" : key.includes("review-create") ? "partialObserved" : "created",
      rejectedPlacement,
    );
    return kind === "gateCheckComplete" && !key.includes("gate-create") && identity.requiredDependencyState !== undefined
      ? { ...evidence, state: identity.requiredDependencyState }
      : evidence;
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
    mergeBaseSha: BASE,
    targetSha: TARGET,
    targetBranch: "main",
    pullRequestTitle: TITLE,
    pullRequestBody: BODY,
    expectedPullRequestUpdatedAt: "2026-08-15T00:00:00.000Z",
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
  return { claim, controller, accepted, inputIdentity };
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

async function stageDatabaseFixture(
  pool: Pool,
  seed: number,
  options: {
    operationKind?: "advisoryCheckCreate" | "relocatedReviewCreate";
    gateOutput?: {
      conclusion: "success" | "failure" | "neutral";
      title: string;
      summary: string;
      detailsUrl: string;
    };
  } = {},
) {
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
  const stagedEnvelope = { fixture: `publication-executor-${seed}` };
  const review = await pool.query<{ id: string }>(
    `INSERT INTO reviews
       (repository_id, pr_number, head_sha, base_sha, status, trigger_source,
        envelope, queued_at)
     VALUES ($1::bigint, 7, $2, $3, 'running', 'unknown', $4::jsonb,
             clock_timestamp())
     RETURNING id`,
    [repositoryId, HEAD, TARGET, JSON.stringify(stagedEnvelope)],
  );
  const fixture = fixtureFor(options.operationKind ?? "advisoryCheckCreate", {
    databaseRepositoryId: repositoryId,
    repositoryId: githubRepositoryId,
    repositoryFullName,
    reviewId: review.rows[0]!.id,
    ...(options.gateOutput === undefined ? {} : { gateOutput: options.gateOutput }),
  });
  await stageGitHubPublicationControllerGeneration({
    database: pool,
    acceptedInput: fixture.inputIdentity,
    acceptedPlan: fixture.accepted,
    controllerManifest: fixture.controller,
    snapshot: {
      repositoryId,
      githubRepositoryId,
      reviewId: review.rows[0]!.id,
      reviewInputSequence: "17",
      expectedPullRequestUpdatedAt: "2026-08-15T00:00:00.000Z",
      envelopeDigest: hex(JSON.stringify(stagedEnvelope)),
      targetBranch: "main",
      pullRequestTitle: TITLE,
      pullRequestBody: BODY,
    },
  });
  return {
    databaseRepositoryId: repositoryId,
    pullRequestNumber: 7,
    publicationGeneration: "17",
    reviewId: review.rows[0]!.id,
  };
}

async function claimControllerSupersessionAuthority(
  pool: Pool,
  scope: {
    databaseRepositoryId: string;
    pullRequestNumber: number;
    publicationGeneration: string;
    reviewId: string;
  },
): Promise<void> {
  const releaseSha = "e".repeat(40);
  await pool.query(
    `INSERT INTO deployment_capabilities (name)
     VALUES ($1), ($2), ('queue-lock-generation-v1')
     ON CONFLICT (name) DO NOTHING`,
    [
      `publication-controller-release:${releaseSha}`,
      `publication-controller-consumer-ready:${releaseSha}`,
    ],
  );
  await pool.query(
    `INSERT INTO jobs
       (kind, payload, status, run_after, attempts, max_attempts)
     VALUES (
       'review',
       jsonb_build_object(
         'recoveryReviewId', $1::bigint,
         'reviewInputSequence', $2::text,
         '_postilCoalescedReviewPayload',
           jsonb_build_object('reviewInputSequence', '18')
       ),
       'queued', clock_timestamp(), 0, 5
     )`,
    [scope.reviewId, scope.publicationGeneration],
  );
  const claimed = await claimPublicationControllerReviewJob(
    pool,
    "supersession-authority",
    releaseSha,
  );
  expect(claimed).not.toBeNull();
}

const finalizationEnvelope = (gateFailing: boolean) => ({
  version: 1,
  summary: "",
  silent: !gateFailing,
  findings: gateFailing
    ? [{
        id: "policy-finding",
        path: "src/policy.ts",
        line: 1,
        severity: "error" as const,
        kind: "risk" as const,
        confidence: 0.9,
        title: "Policy finding",
        body: "A reviewer finding blocks the configured gate.",
      }]
    : [],
  resolved: [],
  counts: { info: 0, warn: 0, error: gateFailing ? 1 : 0, suppressed: 0, ungrounded: 0 },
  confidenceBuckets: [0, 0, 0, 0, gateFailing ? 1 : 0],
  gate: { failOn: "error", failing: gateFailing },
  modelUsed: "test/model",
  usage: { promptTokens: 1, completionTokens: 1 },
  durationMs: 1,
  baseSha: TARGET,
  headSha: HEAD,
  sinceSha: null,
});

async function stageFinalizationFixture(
  pool: Pool,
  seed: number,
  options: {
    gateFailing?: boolean;
    coalesced?: boolean;
    placementFallback?: boolean;
  } = {},
) {
  const scope = await stageDatabaseFixture(pool, seed, {
    operationKind: options.placementFallback
      ? "relocatedReviewCreate"
      : "advisoryCheckCreate",
  });
  const generation = await pool.query<{
    review_id: string;
    accepted_input_digest: string;
    installation_id: string;
    org_id: string;
    github_repo_id: string;
    repository_full_name: string;
  }>(
    `SELECT generation.review_id::text, generation.accepted_input_digest,
            installation.id::text AS installation_id,
            installation.org_id::text,
            repository.github_repo_id::text, repository.full_name AS repository_full_name
       FROM review_publication_generations generation
       JOIN repositories repository ON repository.id = generation.repository_id
       JOIN installations installation ON installation.id = repository.installation_id
      WHERE generation.repository_id = $1::bigint
        AND generation.pr_number = $2
        AND generation.publication_generation = $3::bigint`,
    [scope.databaseRepositoryId, scope.pullRequestNumber, scope.publicationGeneration],
  );
  const row = generation.rows[0]!;
  const expectedReviewInput = {
    installationId: 800_000 + seed,
    sourceInstallationId: Number(row.installation_id),
    sourceOrgId: Number(row.org_id),
    githubRepoId: Number(row.github_repo_id),
    repoFullName: row.repository_full_name,
    prNumber: scope.pullRequestNumber,
    headSha: HEAD,
    baseSha: TARGET,
    expectedPullRequestUpdatedAt: "2026-08-15T00:00:00.000Z",
    reviewInputSequence: scope.publicationGeneration,
    sourceDeliveryId: `finalization-${seed}`,
    recoveryReviewId: Number(row.review_id),
  };
  const coalesced = {
    ...expectedReviewInput,
    headSha: "d".repeat(40),
    reviewInputSequence: String(Number(scope.publicationGeneration) + 1),
    sourceDeliveryId: `finalization-successor-${seed}`,
    recoveryReviewId: undefined,
    providerRetryLineage: `coalesced-finalization-${seed}`,
  };
  const payload = options.coalesced
    ? { ...expectedReviewInput, _postilCoalescedReviewPayload: coalesced }
    : expectedReviewInput;
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs
       (kind, payload, status, attempts, max_attempts, locked_at, locked_by,
        lock_generation)
     VALUES ('review', $1::jsonb, 'running', 1, 5, clock_timestamp(),
             'finalization-worker', 1)
     RETURNING id`,
    [JSON.stringify(payload)],
  );
  await pool.query(
    `UPDATE reviews SET envelope = $2::jsonb
      WHERE id = $1::bigint`,
    [row.review_id, JSON.stringify(finalizationEnvelope(options.gateFailing ?? false))],
  );
  await pool.query(
    `INSERT INTO org_settings (org_id, gate_enabled)
     VALUES ($1::bigint, true)
     ON CONFLICT (org_id) DO UPDATE SET gate_enabled = EXCLUDED.gate_enabled`,
    [row.org_id],
  );
  const input = {
    reviewId: Number(row.review_id),
    reviewJobLease: {
      id: Number(job.rows[0]!.id),
      lockedBy: "finalization-worker",
      lockGeneration: 1n,
    },
    expectedReviewInput,
    databaseRepositoryId: Number(scope.databaseRepositoryId),
    pullRequestNumber: scope.pullRequestNumber,
    publicationGeneration: scope.publicationGeneration,
    acceptedInputIdentity: `sha256:${row.accepted_input_digest}`,
    outcome: "success" as const,
    publicationReceipt: {
      version: 1 as const,
      receiptId: `finalization-${seed}`,
      findings: options.gateFailing
        ? [{
            findingId: "policy-finding",
            stableIdentity: true,
            initialOutcome: "summaryOnly" as const,
            inlineRejected: false,
          }]
        : [],
    },
    usage: [{
      orgId: Number(row.org_id),
      repositoryId: Number(scope.databaseRepositoryId),
      promptTokens: 1,
      completionTokens: 1,
      modelUsed: "test/model",
      costMicros: 1,
      billingScope: "analytics" as const,
    }],
    usageAccountingComplete: true,
  };
  return {
    scope,
    input,
    orgId: Number(row.org_id),
    reviewId: Number(row.review_id),
    jobId: Number(job.rows[0]!.id),
    sourceDeliveryId: `finalization-${seed}`,
    successorLineage: `coalesced-finalization-${seed}`,
    successorSequence: String(Number(scope.publicationGeneration) + 1),
  };
}

async function terminalizeFinalizationOperations(
  pool: Pool,
  scope: Awaited<ReturnType<typeof stageDatabaseFixture>>,
  mode: "success" | "required-failure" | "placement-fallback" | "missing-gate",
): Promise<void> {
  await pool.query(
    `UPDATE review_publication_operations operation
        SET state = CASE
              WHEN $4 = 'missing-gate' AND operation.kind = 'gateCheckComplete'
                THEN operation.state
              WHEN $4 = 'required-failure'
                AND operation.operation_key IN (
                  SELECT jsonb_array_elements_text(
                    gate.operation_record #> '{payload,selection,requiredOperationKeys}'
                  )
                ) THEN 'failed'
              WHEN $4 = 'placement-fallback' AND operation.kind = 'reviewCreate'
                AND operation.operation_record->>'attempt' = 'initial'
                THEN 'failed'
              ELSE 'skipped'
            END,
            terminal_evidence = CASE
              WHEN $4 = 'missing-gate' AND operation.kind = 'gateCheckComplete'
                THEN operation.terminal_evidence
              WHEN $4 = 'placement-fallback' AND operation.kind = 'reviewCreate'
                AND operation.operation_record->>'attempt' = 'initial'
                THEN '{"outcome":"rejected","httpStatus":422,"classification":"invalidReviewCommentPlacement","result":{"dispatched":true,"httpStatus":422,"classification":"invalidReviewCommentPlacement"}}'::jsonb
              WHEN $4 = 'required-failure'
                AND operation.operation_key IN (
                  SELECT jsonb_array_elements_text(
                    gate.operation_record #> '{payload,selection,requiredOperationKeys}'
                  )
                ) THEN '{"outcome":"rejected","result":{"reason":"required publication failed"}}'::jsonb
              ELSE '{"outcome":"notRequiredMarkerPresent","result":{"dispatched":false}}'::jsonb
            END,
            last_error = CASE
              WHEN $4 IN ('required-failure', 'placement-fallback') THEN 'fixture rejection'
              ELSE NULL
            END,
            updated_at = clock_timestamp()
       FROM review_publication_operations gate
      WHERE operation.repository_id = $1::bigint
        AND operation.pr_number = $2
        AND operation.publication_generation = $3::bigint
        AND gate.repository_id = operation.repository_id
        AND gate.pr_number = operation.pr_number
        AND gate.publication_generation = operation.publication_generation
        AND gate.kind = 'gateCheckComplete'`,
    [scope.databaseRepositoryId, scope.pullRequestNumber, scope.publicationGeneration, mode],
  );
}

async function terminalizeAllAsSuperseded(
  pool: Pool,
  scope: Awaited<ReturnType<typeof stageDatabaseFixture>>,
): Promise<void> {
  const store = new PostgresGitHubPublicationOperationStore(pool, scope);
  while (await store.supersedeOnePending()) {
    // One transaction and one immutable no-write attempt per operation.
  }
}

async function finalizationSnapshot(
  pool: Pool,
  fixture: Awaited<ReturnType<typeof stageFinalizationFixture>>,
) {
  const result = await pool.query<{
    review_status: string;
    job_status: string;
    receipts: number;
    usage_events: number;
    promoted_jobs: number;
  }>(
    `SELECT review.status AS review_status, job.status AS job_status,
            (SELECT count(*)::integer FROM review_publication_receipts receipt
              WHERE receipt.review_id = review.id) AS receipts,
            (SELECT count(*)::integer FROM usage_events usage
              WHERE usage.review_id = review.id) AS usage_events,
            (SELECT count(*)::integer FROM jobs successor
              WHERE successor.id <> $2 AND successor.kind = 'review'
                AND successor.status = 'queued'
                AND successor.payload->>'providerRetryLineage' = $3
                AND successor.payload->>'reviewInputSequence' = $4) AS promoted_jobs
       FROM reviews review
       JOIN jobs job ON job.id = $2
      WHERE review.id = $1`,
    [
      fixture.reviewId,
      fixture.jobId,
      fixture.successorLineage,
      fixture.successorSequence,
    ],
  );
  const row = result.rows[0]!;
  return {
    reviewStatus: row.review_status,
    jobStatus: row.job_status,
    receipts: row.receipts,
    usageEvents: row.usage_events,
    promotedJobs: row.promoted_jobs,
  };
}

async function terminalizeGateDependencies(
  pool: Pool,
  scope: {
    databaseRepositoryId: string;
    pullRequestNumber: number;
    publicationGeneration: string;
  },
  requiredState: "skipped" | "failed" | "superseded",
): Promise<void> {
  const gateIdentity = {
    outcome: "reconciledExisting",
    result: { checkRunId: "901" },
    remoteId: "901",
    remoteOperationId: "901",
  };
  const requiredEvidence = requiredState === "failed"
    ? { outcome: "rejected", result: { reason: "required publication failed" } }
    : {
        outcome: "notRequiredMarkerPresent",
        result: {
          reason: requiredState === "superseded"
            ? "required publication was superseded"
            : "required publication was already satisfied",
        },
      };
  const incidentalEvidence = {
    outcome: "notRequiredMarkerPresent",
    result: { reason: "operation is not required for this gate test" },
  };
  await pool.query(
    `UPDATE review_publication_operations
     SET state = CASE
           WHEN kind = 'advisoryCheckComplete' AND $4 = 'superseded'
             THEN state
           WHEN kind = 'advisoryCheckComplete' THEN $4
           ELSE 'skipped'
         END,
         last_error = CASE
           WHEN kind = 'advisoryCheckComplete' AND $4 = 'failed'
             THEN 'required publication failed'
           ELSE NULL
         END,
         terminal_evidence = CASE
           WHEN kind = 'gateCheckCreate' THEN $5::jsonb
           WHEN kind = 'advisoryCheckComplete' AND $4 = 'superseded'
             THEN terminal_evidence
           WHEN kind = 'advisoryCheckComplete' THEN $6::jsonb
           ELSE $7::jsonb
         END,
         updated_at = clock_timestamp()
     WHERE repository_id = $1::bigint
       AND pr_number = $2
       AND publication_generation = $3::bigint
       AND kind <> 'gateCheckComplete'`,
    [
      scope.databaseRepositoryId,
      scope.pullRequestNumber,
      scope.publicationGeneration,
      requiredState,
      JSON.stringify(gateIdentity),
      JSON.stringify(requiredEvidence),
      JSON.stringify(incidentalEvidence),
    ],
  );
  if (requiredState === "superseded") {
    const required = await pool.query<{ operation_key: string }>(
      `SELECT operation_key
         FROM review_publication_operations
        WHERE repository_id = $1::bigint AND pr_number = $2
          AND publication_generation = $3::bigint
          AND kind = 'advisoryCheckComplete'`,
      [scope.databaseRepositoryId, scope.pullRequestNumber, scope.publicationGeneration],
    );
    const store = new PostgresGitHubPublicationOperationStore(pool, scope);
    expect(await store.supersedeOnePending(required.rows[0]!.operation_key)).toBe(true);
  }
}
