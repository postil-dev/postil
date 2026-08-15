import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";

import {
  buildGitHubPublicationControllerManifest,
  type BuiltGitHubPublicationControllerManifest,
} from "@/lib/github-publication-controller-manifest";
import {
  deriveGitHubPublicationReceipt,
  GitHubPublicationReceiptDerivationError,
  loadAndDeriveGitHubPublicationReceipt,
  type GitHubPublicationReceiptAttemptSnapshot,
  type GitHubPublicationReceiptEvidenceSnapshot,
  type GitHubPublicationReceiptOperationSnapshot,
  type GitHubPublicationReceiptReconciliationSnapshot,
} from "@/lib/github-publication-receipt-deriver";
import { buildGitHubPublicationInputIdentity } from "@/lib/github-publication-cli-planner";
import {
  executeOneGitHubPublicationOperation,
  type GitHubPublicationAdapters,
} from "@/lib/github-publication-operation-executor";
import { PostgresGitHubPublicationOperationStore } from "@/lib/github-publication-operation-store";
import {
  parseGitHubPublicationPlanBytes,
  type AcceptedGitHubPublicationPlan,
  type ExpectedGitHubPublicationPlan,
} from "@/lib/github-publication-plan";
import { stageGitHubPublicationControllerGeneration } from "@/lib/github-publication-controller-store";
import {
  createEphemeralDatabase,
  type EphemeralDatabase,
} from "./ephemeral-database";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TARGET = "c".repeat(40);
const TITLE = "Derive publication receipts from durable evidence";
const BODY = "The receipt binds only sealed intent and exact terminal observations.";
const NOW = new Date("2026-08-15T03:00:00.000Z");
const LATER = new Date("2026-08-15T03:00:01.000Z");
const TEST_URL = process.env.POSTIL_TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

interface Fixture {
  acceptedPlan: AcceptedGitHubPublicationPlan;
  controllerManifest: BuiltGitHubPublicationControllerManifest;
  snapshot: GitHubPublicationReceiptEvidenceSnapshot;
  operationKeys: Record<string, string>;
  markers: Record<string, string>;
}

describe("GitHub publication receipt derivation", () => {
  test("derives inline, file, summary, carried, resolved, and suppressed outcomes", () => {
    const fixture = reviewFixture();
    const receipt = deriveGitHubPublicationReceipt(fixture.snapshot);

    expect(receipt).toEqual({
      version: 2,
      channel: "reviewComments",
      receiptId: "receipt-review",
      reviewId: "901",
      findings: [
        {
          findingId: "carried-1",
          stableIdentity: true,
          initialOutcome: "carried",
          inlineRejected: false,
        },
        {
          findingId: "file-1",
          stableIdentity: true,
          initialOutcome: "fileComment",
          inlineRejected: false,
          commentId: "1002",
        },
        {
          findingId: "inline-1",
          stableIdentity: true,
          initialOutcome: "inline",
          inlineRejected: false,
          commentId: "1001",
        },
        {
          findingId: "resolved-1",
          stableIdentity: true,
          initialOutcome: "resolved",
          inlineRejected: false,
        },
        {
          findingId: "summary-1",
          stableIdentity: true,
          initialOutcome: "summaryOnly",
          inlineRejected: false,
        },
        {
          findingId: "suppressed-1",
          stableIdentity: true,
          initialOutcome: "suppressed",
          inlineRejected: false,
        },
      ],
    });
  });

  test("derives check annotations without trusting review identities", () => {
    const fixture = checkFixture();
    const receipt = deriveGitHubPublicationReceipt(fixture.snapshot);

    expect(receipt).toEqual({
      version: 2,
      channel: "checkAnnotations",
      receiptId: "receipt-check",
      findings: [
        {
          findingId: "annotation-1",
          stableIdentity: true,
          initialOutcome: "checkAnnotation",
          inlineRejected: false,
        },
        {
          findingId: "resolved-1",
          stableIdentity: true,
          initialOutcome: "resolved",
          inlineRejected: false,
        },
        {
          findingId: "summary-1",
          stableIdentity: true,
          initialOutcome: "summaryOnly",
          inlineRejected: false,
        },
        {
          findingId: "suppressed-1",
          stableIdentity: true,
          initialOutcome: "suppressed",
          inlineRejected: false,
        },
      ],
    });
    expect(receipt.reviewId).toBeUndefined();
  });

  test("normalizes two semantic placement rejections through the sealed summary fallback", () => {
    const fixture = rejectedPlacementFixture();
    const receipt = deriveGitHubPublicationReceipt(fixture.snapshot);

    expect(receipt).toMatchObject({
      version: 2,
      channel: "reviewComments",
      reviewId: "903",
      findings: [{
        findingId: "inline-rejected-1",
        initialOutcome: "summaryOnly",
        inlineRejected: true,
      }],
    });
  });

  test("derives an inline receipt after one semantic rejection relocates successfully", () => {
    const fixture = relocatedPlacementFixture();
    const receipt = deriveGitHubPublicationReceipt(fixture.snapshot);

    expect(receipt).toMatchObject({
      reviewId: "902",
      findings: [{
        findingId: "relocated-1",
        initialOutcome: "inline",
        inlineRejected: false,
        commentId: "1003",
      }],
    });
  });

  test("rejects a definitive non-placement mutation failure", () => {
    const fixture = relocatedPlacementFixture();
    const initial = operation(fixture, fixture.operationKeys.initial!);
    const payload = terminalPayload(
      initial,
      initial.kind,
      "rejected",
      { httpStatus: 403 },
      undefined,
      { httpStatus: 403 },
    );
    initial.terminalEvidence = payload;
    fixture.snapshot.attempts.find((entry) =>
      entry.operationKey === initial.operationKey && entry.phase === "rejected"
    )!.evidencePayload = payload;

    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "failed definitively",
    );
  });

  test("accepts exact terminal reconciliation evidence for an ambiguous review write", () => {
    const fixture = reviewFixture();
    const review = operation(fixture, fixture.operationKeys.review!);
    reconcileApplied(
      fixture,
      review,
      "partialObserved",
      {
        reviewId: "901",
        commentIdsByMarker: { [fixture.markers.inline!]: "1001" },
        missingCommentMarkers: [fixture.markers.file!],
      },
      "901",
    );

    expect(deriveGitHubPublicationReceipt(fixture.snapshot).reviewId).toBe("901");
  });

  test("never trusts a planned observed comment identity without exact terminal evidence", () => {
    const fixture = retainedCommentFixture();
    const update = operation(fixture, fixture.operationKeys.update!);
    skipWithoutRemote(fixture, update);

    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "planned review comment identity has no exact applied evidence",
    );
  });

  test("accepts a retained comment only when exact no-write evidence proves its identity", () => {
    const fixture = retainedCommentFixture();
    const update = operation(fixture, fixture.operationKeys.update!);
    skipWithExistingRemote(
      fixture,
      update,
      "notRequiredContentExact",
      { commentId: "701", bodyDigest: digest("retained-body") },
      "701",
    );

    expect(deriveGitHubPublicationReceipt(fixture.snapshot).findings[0]).toEqual({
      findingId: "retained-1",
      stableIdentity: true,
      initialOutcome: "inline",
      inlineRejected: false,
      commentId: "701",
    });
  });

  test("rejects one remote comment identity assigned to multiple findings", () => {
    const fixture = reviewFixture();
    const fallback = operation(fixture, fixture.operationKeys.file!);
    applyDirect(
      fixture,
      fallback,
      "created",
      { commentId: "1001", commitId: HEAD, path: "src/file.ts", body: "file" },
      "1001",
    );

    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "one remote comment identity is assigned to multiple findings",
    );
  });

  test.each([
    {
      name: "pending required operation",
      mutate: (fixture: Fixture) => {
        const review = operation(fixture, fixture.operationKeys.review!);
        review.state = "pending";
        review.attemptCount = 0;
        review.leaseGeneration = "0";
        review.selectedVariant = null;
        fixture.snapshot.attempts = fixture.snapshot.attempts.filter(
          (entry) => entry.operationKey !== review.operationKey,
        );
      },
      message: "is not terminal",
    },
    {
      name: "stale attempt number",
      mutate: (fixture: Fixture) => {
        fixture.snapshot.attempts.find(
          (entry) => entry.operationKey === fixture.operationKeys.review,
        )!.attemptNumber = 2;
      },
      message: "stale attempt evidence",
    },
    {
      name: "wrong lease generation",
      mutate: (fixture: Fixture) => {
        fixture.snapshot.attempts.find(
          (entry) => entry.operationKey === fixture.operationKeys.review,
        )!.leaseGeneration = "2";
      },
      message: "stale attempt evidence",
    },
    {
      name: "wrong selected variant",
      mutate: (fixture: Fixture) => {
        fixture.snapshot.attempts.find(
          (entry) =>
            entry.operationKey === fixture.operationKeys.review &&
            entry.phase === "claimed",
        )!.selectedVariant = "wrong-variant";
      },
      message: "contradictory variants",
    },
    {
      name: "contradictory activation variant",
      mutate: (fixture: Fixture) => {
        fixture.snapshot.attempts.find(
          (entry) =>
            entry.operationKey === fixture.operationKeys.review &&
            entry.phase === "applied",
        )!.evidencePayload!.activationVariant = "wrong-activation";
      },
      message: "contradictory activation variants",
    },
    {
      name: "contradictory terminal phase",
      mutate: (fixture: Fixture) => {
        const review = operation(fixture, fixture.operationKeys.review!);
        fixture.snapshot.attempts.push(
          evidenceAttempt(
            review,
            review.kind,
            "rejected",
            terminalPayload(
              review,
              review.kind,
              "rejected",
              { httpStatus: 403 },
              undefined,
              { httpStatus: 403 },
            ),
          ),
        );
      },
      message: "contradictory attempt phases",
    },
    {
      name: "claim that follows terminal evidence",
      mutate: (fixture: Fixture) => {
        fixture.snapshot.attempts.find(
          (entry) =>
            entry.operationKey === fixture.operationKeys.review &&
            entry.phase === "claimed",
        )!.observedAt = new Date("2026-08-15T03:00:02.000Z");
      },
      message: "lacks a preceding claimed phase",
    },
    {
      name: "request digest drift",
      mutate: (fixture: Fixture) => {
        fixture.snapshot.attempts.find(
          (entry) =>
            entry.operationKey === fixture.operationKeys.review &&
            entry.phase === "applied",
        )!.evidencePayload!.requestDigest = digest("wrong-request");
      },
      message: "request identity",
    },
    {
      name: "result digest drift",
      mutate: (fixture: Fixture) => {
        fixture.snapshot.attempts.find(
          (entry) =>
            entry.operationKey === fixture.operationKeys.review &&
            entry.phase === "applied",
        )!.evidencePayload!.resultDigest = digest("wrong-result");
      },
      message: "result digest",
    },
    {
      name: "stale evidence timestamp",
      mutate: (fixture: Fixture) => {
        fixture.snapshot.attempts.find(
          (entry) =>
            entry.operationKey === fixture.operationKeys.review &&
            entry.phase === "applied",
        )!.evidencePayload!.observedAt = "2026-08-14T00:00:00.000Z";
      },
      message: "timestamp is stale",
    },
    {
      name: "accepted plan digest drift",
      mutate: (fixture: Fixture) => {
        fixture.snapshot.generation.acceptedPlanDigest = "f".repeat(64);
      },
      message: "accepted plan bytes drifted",
    },
    {
      name: "canonical operation drift",
      mutate: (fixture: Fixture) => {
        operation(fixture, fixture.operationKeys.review!).desiredPayloadDigest =
          digest("wrong-operation");
      },
      message: "desired payload digest drifted",
    },
  ])("rejects $name", ({ mutate, message }) => {
    const fixture = reviewFixture();
    mutate(fixture);
    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(message);
  });
});

describeDb("GitHub publication receipt PostgreSQL loader", () => {
  let database: EphemeralDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createEphemeralDatabase("publication_receipt_deriver");
    pool = database.pool;
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  test("loads one locked current generation and derives from executor evidence", async () => {
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, github_org_id)
       VALUES ('receipt-deriver', 'Receipt Deriver', 810001) RETURNING id`,
    );
    const installation = await pool.query<{ id: string }>(
      `INSERT INTO installations
         (github_installation_id, account_login, account_type, org_id)
       VALUES (810002, 'receipt-deriver', 'Organization', $1) RETURNING id`,
      [organization.rows[0]!.id],
    );
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories
         (github_repo_id, installation_id, full_name, private, enabled)
       VALUES (42, $1, 'octo/service', false, true) RETURNING id`,
      [installation.rows[0]!.id],
    );
    const stagedEnvelope = { fixture: "receipt-deriver-17" };
    const review = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status,
          trigger_source, envelope, queued_at)
       VALUES ($1, 7, $2, $3, 'running', 'unknown', $4::jsonb, now()) RETURNING id`,
      [repository.rows[0]!.id, HEAD, TARGET, JSON.stringify(stagedEnvelope)],
    );
    const acceptedInput = databaseAcceptedInput({
      databaseRepositoryId: repository.rows[0]!.id,
      reviewId: review.rows[0]!.id,
      generation: "17",
      expectedPullRequestUpdatedAt: "2026-08-15T02:00:00.000Z",
    });
    const fixture = checkFixture("17", acceptedInput.digest);
    await stageGitHubPublicationControllerGeneration({
      acceptedInput,
      acceptedPlan: fixture.acceptedPlan,
      controllerManifest: fixture.controllerManifest,
      snapshot: {
        repositoryId: repository.rows[0]!.id,
        githubRepositoryId: "42",
        reviewId: review.rows[0]!.id,
        reviewInputSequence: "17",
        expectedPullRequestUpdatedAt: "2026-08-15T02:00:00.000Z",
        envelopeDigest: hex(canonicalJson(stagedEnvelope)),
        targetBranch: "main",
        pullRequestTitle: TITLE,
        pullRequestBody: BODY,
      },
      database: pool,
    });

    const store = new PostgresGitHubPublicationOperationStore(pool, {
      databaseRepositoryId: repository.rows[0]!.id,
      pullRequestNumber: 7,
      publicationGeneration: "17",
    });
    for (let index = 0; index < 2; index += 1) {
      const continuation = await executeOneGitHubPublicationOperation({
        store,
        token: "test-token",
        appId: 123,
        claimOwner: "receipt-deriver-test",
        leaseId: () => `11111111-1111-4111-8111-11111111111${index}`,
        now: () => new Date(),
        adapters: databaseAdapters(fixture),
      });
      expect(continuation.status).not.toBe("unknown");
    }

    const before = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM review_publication_receipts
       WHERE review_id = $1`,
      [review.rows[0]!.id],
    );
    const receipt = await loadAndDeriveGitHubPublicationReceipt({
      database: pool,
      repositoryId: repository.rows[0]!.id,
      pullRequestNumber: 7,
      publicationGeneration: "17",
      reviewId: review.rows[0]!.id,
      acceptedInputIdentity: fixture.acceptedPlan.value.inputIdentity,
    });
    const after = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM review_publication_receipts
       WHERE review_id = $1`,
      [review.rows[0]!.id],
    );

    expect(receipt).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          findingId: "annotation-1",
          initialOutcome: "checkAnnotation",
        }),
      ]),
    });
    expect(before.rows[0]!.count).toBe("0");
    expect(after.rows[0]!.count).toBe("0");

    await expect(loadAndDeriveGitHubPublicationReceipt({
      database: pool,
      repositoryId: repository.rows[0]!.id,
      pullRequestNumber: 7,
      publicationGeneration: "17",
      reviewId: "9223372036854775806",
      acceptedInputIdentity: fixture.acceptedPlan.value.inputIdentity,
    })).rejects.toThrow("no longer owns the current publication generation");
    await expect(loadAndDeriveGitHubPublicationReceipt({
      database: pool,
      repositoryId: repository.rows[0]!.id,
      pullRequestNumber: 7,
      publicationGeneration: "17",
      reviewId: review.rows[0]!.id,
      acceptedInputIdentity: digest("wrong-continuation-input"),
    })).rejects.toThrow("no longer owns the current publication generation");

    const supersedingEnvelope = { fixture: "receipt-deriver-18" };
    const supersedingReview = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (repository_id, pr_number, head_sha, base_sha, status,
          trigger_source, envelope, queued_at)
       VALUES ($1, 7, $2, $3, 'running', 'unknown', $4::jsonb, now()) RETURNING id`,
      [repository.rows[0]!.id, HEAD, TARGET, JSON.stringify(supersedingEnvelope)],
    );
    const supersedingInput = databaseAcceptedInput({
      databaseRepositoryId: repository.rows[0]!.id,
      reviewId: supersedingReview.rows[0]!.id,
      generation: "18",
      expectedPullRequestUpdatedAt: "2026-08-15T02:00:01.000Z",
    });
    const superseding = checkFixture("18", supersedingInput.digest);
    await stageGitHubPublicationControllerGeneration({
      acceptedInput: supersedingInput,
      acceptedPlan: superseding.acceptedPlan,
      controllerManifest: superseding.controllerManifest,
      snapshot: {
        repositoryId: repository.rows[0]!.id,
        githubRepositoryId: "42",
        reviewId: supersedingReview.rows[0]!.id,
        reviewInputSequence: "18",
        expectedPullRequestUpdatedAt: "2026-08-15T02:00:01.000Z",
        envelopeDigest: hex(canonicalJson(supersedingEnvelope)),
        targetBranch: "main",
        pullRequestTitle: TITLE,
        pullRequestBody: BODY,
      },
      database: pool,
    });
    await expect(loadAndDeriveGitHubPublicationReceipt({
      database: pool,
      repositoryId: repository.rows[0]!.id,
      pullRequestNumber: 7,
      publicationGeneration: "17",
      reviewId: review.rows[0]!.id,
      acceptedInputIdentity: fixture.acceptedPlan.value.inputIdentity,
    })).rejects.toThrow("no longer owns the current publication generation");
  }, 60_000);
});

function reviewFixture(generation = "17"): Fixture {
  const expected = expectedPlan(`review-${generation}`, generation);
  const markers = {
    carried: marker("finding", "carried-1"),
    file: marker("finding", "file-1"),
    inline: marker("finding", "inline-1"),
    resolved: marker("finding", "resolved-1"),
    summary: marker("finding", "summary-1"),
    suppressed: marker("finding", "suppressed-1"),
    review: marker("review", "receipt-review"),
  };
  const findings = [
    finding("carried-1", markers.carried, "carried"),
    finding("file-1", markers.file, "inline", ["fileComment"]),
    finding("inline-1", markers.inline, "inline"),
    finding("resolved-1", markers.resolved, "resolved"),
    finding("summary-1", markers.summary, "summaryOnly"),
    finding("suppressed-1", markers.suppressed, "suppressed"),
  ];
  const advisoryCreate = advisoryCreateOperation(expected);
  const review = reviewOperation(expected, "initial", markers.review, [
    { findingId: "inline-1", marker: markers.inline, path: "src/inline.ts" },
    { findingId: "file-1", marker: markers.file, path: "src/file.ts" },
  ]);
  const fallback = operationRecord(expected, "file-comment-fallback", {
    kind: "fileCommentFallback",
    findingId: "file-1",
    payload: {
      body: `File finding\n\n${markers.file}`,
      commitId: HEAD,
      path: "src/file.ts",
      subjectType: "file",
    },
    dependencies: [review.operationKey],
    activation: { anyOf: [{
      condition: "partialReviewObserved",
      dependencyOperationKey: review.operationKey,
      reviewMarkers: [markers.review],
      findingMarkerAbsence: {
        markers: [markers.file],
        headSha: HEAD,
        required: true,
      },
    }] },
    reconciliation: {
      logicalIdentity: "",
      markers: [markers.file],
      exclusive: true,
    },
    findingSalt: "file-1",
  });
  fallback.reconciliation.logicalIdentity = fallback.operationKey;
  resignDesired(fallback);
  const operations = [advisoryCreate, review, fallback];
  operations.push(advisoryCompleteOperation(expected, operations));
  const fixture = buildFixture(expected, "reviewComments", "receipt-review", findings, operations);
  fixture.operationKeys = {
    advisoryCreate: advisoryCreate.operationKey,
    review: review.operationKey,
    file: fallback.operationKey,
    advisoryComplete: operations.at(-1)!.operationKey,
  };
  fixture.markers = markers;

  applyDirect(
    fixture,
    operation(fixture, fixture.operationKeys.advisoryCreate!),
    "created",
    { checkRunId: "801" },
    "801",
  );
  applyDirect(
    fixture,
    operation(fixture, fixture.operationKeys.review!),
    "partialObserved",
    {
      reviewId: "901",
      commentIdsByMarker: { [markers.inline]: "1001" },
      missingCommentMarkers: [markers.file],
    },
    "901",
  );
  applyDirect(
    fixture,
    operation(fixture, fixture.operationKeys.file!),
    "created",
    { commentId: "1002", commitId: HEAD, path: "src/file.ts", body: "file" },
    "1002",
  );
  applyDirect(
    fixture,
    operation(fixture, fixture.operationKeys.advisoryComplete!),
    "applied",
    { checkRunId: "801", conclusion: "success" },
    "801",
  );
  return fixture;
}

function checkFixture(generation = "17", inputIdentity?: string): Fixture {
  const expected = expectedPlan(`check-${generation}`, generation, inputIdentity);
  const markers = {
    annotation: marker("finding", "annotation-1"),
    resolved: marker("finding", "resolved-check"),
    summary: marker("finding", "summary-check"),
    suppressed: marker("finding", "suppressed-check"),
  };
  const findings = [
    finding("annotation-1", markers.annotation, "checkAnnotation"),
    finding("resolved-1", markers.resolved, "resolved"),
    finding("summary-1", markers.summary, "summaryOnly"),
    finding("suppressed-1", markers.suppressed, "suppressed"),
  ];
  const create = advisoryCreateOperation(expected);
  const complete = advisoryCompleteOperation(expected, [create], [{
    path: "src/annotation.ts",
    startLine: 4,
    endLine: 4,
    annotationLevel: "warning",
    title: "Annotation finding",
    message: "Exact annotation evidence.",
  }]);
  const fixture = buildFixture(
    expected,
    "checkAnnotations",
    "receipt-check",
    findings,
    [create, complete],
  );
  fixture.operationKeys = {
    advisoryCreate: create.operationKey,
    advisoryComplete: complete.operationKey,
  };
  fixture.markers = markers;
  applyDirect(fixture, operation(fixture, create.operationKey), "created", { checkRunId: "811" }, "811");
  applyDirect(
    fixture,
    operation(fixture, complete.operationKey),
    "applied",
    { checkRunId: "811", conclusion: "success" },
    "811",
  );
  return fixture;
}

function rejectedPlacementFixture(): Fixture {
  const expected = expectedPlan("rejected");
  const markers = {
    finding: marker("finding", "inline-rejected-1"),
    review: marker("review", "receipt-rejected"),
  };
  const findings = [
    finding(
      "inline-rejected-1",
      markers.finding,
      "inline",
      ["relocatedInline", "summaryOnly"],
    ),
  ];
  const create = advisoryCreateOperation(expected);
  const initial = reviewOperation(expected, "initial", markers.review, [{
    findingId: "inline-rejected-1",
    marker: markers.finding,
    path: "src/rejected.ts",
  }]);
  const relocated = reviewOperation(expected, "relocatedInline", markers.review, [{
    findingId: "inline-rejected-1",
    marker: markers.finding,
    path: "src/rejected.ts",
  }], initial.operationKey);
  const summary = reviewOperation(
    expected,
    "summaryOnly",
    markers.review,
    [],
    relocated.operationKey,
  );
  const operations = [create, initial, relocated, summary];
  operations.push(advisoryCompleteOperation(expected, operations));
  const fixture = buildFixture(
    expected,
    "reviewComments",
    "receipt-rejected",
    findings,
    operations,
  );
  fixture.operationKeys = {
    advisoryCreate: create.operationKey,
    initial: initial.operationKey,
    relocated: relocated.operationKey,
    summary: summary.operationKey,
    advisoryComplete: operations.at(-1)!.operationKey,
  };
  fixture.markers = markers;
  applyDirect(fixture, operation(fixture, create.operationKey), "created", { checkRunId: "821" }, "821");
  rejectPlacement(fixture, operation(fixture, initial.operationKey));
  rejectPlacement(fixture, operation(fixture, relocated.operationKey));
  applyDirect(
    fixture,
    operation(fixture, summary.operationKey),
    "created",
    { reviewId: "903", commentIdsByMarker: {}, missingCommentMarkers: [] },
    "903",
  );
  applyDirect(
    fixture,
    operation(fixture, operations.at(-1)!.operationKey),
    "applied",
    { checkRunId: "821", conclusion: "success" },
    "821",
  );
  return fixture;
}

function relocatedPlacementFixture(): Fixture {
  const expected = expectedPlan("relocated");
  const markers = {
    finding: marker("finding", "relocated-1"),
    review: marker("review", "receipt-relocated"),
  };
  const findings = [
    finding(
      "relocated-1",
      markers.finding,
      "inline",
      ["relocatedInline", "summaryOnly"],
    ),
  ];
  const create = advisoryCreateOperation(expected);
  const initial = reviewOperation(expected, "initial", markers.review, [{
    findingId: "relocated-1",
    marker: markers.finding,
    path: "src/relocated.ts",
  }]);
  const relocated = reviewOperation(expected, "relocatedInline", markers.review, [{
    findingId: "relocated-1",
    marker: markers.finding,
    path: "src/relocated.ts",
  }], initial.operationKey);
  const operations = [create, initial, relocated];
  operations.push(advisoryCompleteOperation(expected, operations));
  const fixture = buildFixture(
    expected,
    "reviewComments",
    "receipt-relocated",
    findings,
    operations,
  );
  fixture.operationKeys = {
    advisoryCreate: create.operationKey,
    initial: initial.operationKey,
    relocated: relocated.operationKey,
    advisoryComplete: operations.at(-1)!.operationKey,
  };
  fixture.markers = markers;
  applyDirect(fixture, operation(fixture, create.operationKey), "created", { checkRunId: "841" }, "841");
  rejectPlacement(fixture, operation(fixture, initial.operationKey));
  applyDirect(
    fixture,
    operation(fixture, relocated.operationKey),
    "created",
    {
      reviewId: "902",
      commentIdsByMarker: { [markers.finding]: "1003" },
      missingCommentMarkers: [],
    },
    "902",
  );
  applyDirect(
    fixture,
    operation(fixture, operations.at(-1)!.operationKey),
    "applied",
    { checkRunId: "841", conclusion: "success" },
    "841",
  );
  return fixture;
}

function retainedCommentFixture(): Fixture {
  const expected = expectedPlan("retained");
  const findingMarker = marker("finding", "retained-1");
  const reviewMarker = marker("review", "receipt-retained");
  const retainedBody = `retained-1\n\n${findingMarker}`;
  const retained = {
    findingId: "retained-1",
    stableIdentity: true,
    path: "src/retained-1.ts",
    line: 5,
    initialOutcome: "inline",
    contentDigest: digest("content:retained-1"),
    marker: findingMarker,
    desiredBody: retainedBody,
    desiredBodySha256: digest(retainedBody),
    observedCommentId: "701",
    observedBodySha256: digest("old-body"),
    observedOutcome: "inline",
    reconciliation: "replace",
    duplicateProvenance: "none",
  };
  const create = advisoryCreateOperation(expected);
  const review = reviewOperation(expected, "initial", reviewMarker, []);
  const update = operationRecord(expected, "finding-comment-update", {
    kind: "findingCommentUpdate",
    findingId: "retained-1",
    observedCommentId: "701",
    expectedMarkers: [findingMarker],
    body: `Retained finding\n\n${findingMarker}`,
    bodySha256: digest(`Retained finding\n\n${findingMarker}`),
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
    findingSalt: "retained-1",
  });
  update.reconciliation.logicalIdentity = update.operationKey;
  resignDesired(update);
  const operations = [create, review, update];
  operations.push(advisoryCompleteOperation(expected, operations));
  const fixture = buildFixture(
    expected,
    "reviewComments",
    "receipt-retained",
    [retained],
    operations,
  );
  fixture.operationKeys = {
    advisoryCreate: create.operationKey,
    review: review.operationKey,
    update: update.operationKey,
    advisoryComplete: operations.at(-1)!.operationKey,
  };
  fixture.markers = { finding: findingMarker, review: reviewMarker };
  applyDirect(fixture, operation(fixture, create.operationKey), "created", { checkRunId: "831" }, "831");
  applyDirect(
    fixture,
    operation(fixture, review.operationKey),
    "created",
    { reviewId: "904", commentIdsByMarker: {}, missingCommentMarkers: [] },
    "904",
  );
  applyDirect(
    fixture,
    operation(fixture, operations.at(-1)!.operationKey),
    "applied",
    { checkRunId: "831", conclusion: "success" },
    "831",
  );
  return fixture;
}

function buildFixture(
  expected: ExpectedGitHubPublicationPlan,
  channel: "reviewComments" | "checkAnnotations",
  receiptId: string,
  findings: Record<string, any>[],
  operations: Record<string, any>[],
): Fixture {
  operations.forEach((operation, index) => {
    operation.ordinal = index + 1;
  });
  const lifecycleReceipt: Record<string, any> = {
    version: 1,
    inputIdentity: expected.inputIdentity,
    channel,
    receiptId,
    duplicateOfBaseline: false,
    findings,
    digest: "",
  };
  lifecycleReceipt.digest = digestJson({
    version: 1,
    inputIdentity: lifecycleReceipt.inputIdentity,
    channel,
    receiptId,
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
    lifecycleReceipt,
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
      title: "Advisory analysis complete",
      summary: "The service owns the authoritative gate.",
    },
    intentDigest: "",
  };
  const { intentDigest: _intentDigest, ...intent } = plan;
  plan.intentDigest = digestJson(intent);
  const acceptedPlan = parseGitHubPublicationPlanBytes(
    Buffer.from(`${JSON.stringify(plan)}\n`, "utf8"),
    expected,
  );
  const controllerManifest = buildGitHubPublicationControllerManifest({
    acceptedPlan: acceptedPlan.value,
    acceptedPlanBytesDigest: `sha256:${acceptedPlan.digest}`,
    requiredTerminalOperationKeys: [operations.at(-1)!.operationKey],
    gateOutput: {
      conclusion: "success",
      title: "Publication gate complete",
      summary: "Every required publication operation reached a terminal state.",
      detailsUrl: "https://postil.dev/orgs/octo/runs/receipt-deriver",
    },
  });
  const snapshotOperations = controllerManifest.value.operations.map((record, index) => {
    const operation = (
      record.source === "cli"
        ? acceptedPlan.value.operations[index]
        : record.operation
    ) as Record<string, unknown>;
    const desired = desiredPayload(operation);
    return {
      operationKey: String(operation.operationKey),
      operationOrdinal: index + 1,
      operationSource: record.source,
      kind: String(operation.kind),
      controllerRecord: structuredClone(record) as Record<string, unknown>,
      controllerRecordBytes: Uint8Array.from(controllerManifest.operationBytes[index]!),
      operationRecord: structuredClone(operation),
      operationRecordBytes: Buffer.from(JSON.stringify(operation), "utf8"),
      activation: structuredClone(operation.activation) as Record<string, unknown>,
      activationBytes: Buffer.from(JSON.stringify(operation.activation), "utf8"),
      desiredPayload: desired,
      desiredPayloadBytes: Buffer.from(JSON.stringify(desired), "utf8"),
      desiredPayloadDigest: String(operation.desiredDigest),
      state: "pending",
      attemptCount: 0,
      leaseGeneration: "0",
      selectedVariant: null,
      terminalEvidence: null,
      updatedAt: LATER,
    } satisfies GitHubPublicationReceiptOperationSnapshot;
  });
  return {
    acceptedPlan,
    controllerManifest,
    snapshot: {
      generation: {
        databaseRepositoryId: "1",
        githubRepositoryId: "42",
        repositoryFullName: "octo/service",
        pullRequestNumber: 7,
        publicationGeneration: String(expected.controllerGeneration),
        reviewId: "71",
        acceptedReviewId: "71",
        acceptedInputDigest: expected.inputIdentity.slice("sha256:".length),
        highWaterInputDigest: expected.inputIdentity.slice("sha256:".length),
        headSha: HEAD,
        highWaterHeadSha: HEAD,
        mergeBaseSha: BASE,
        targetSha: TARGET,
        pullRequestTitle: TITLE,
        pullRequestBody: BODY,
        acceptedPlanBytes: acceptedPlan.bytes,
        acceptedPlanDigest: acceptedPlan.digest,
        planSemanticDigest: acceptedPlan.value.intentDigest.slice("sha256:".length),
        operationCount: acceptedPlan.value.operationCount,
        operationManifestDigest: acceptedPlan.value.operationManifestDigest,
        controllerOperationCount: controllerManifest.value.operationCount,
        controllerOperationManifestDigest:
          controllerManifest.value.operationManifestDigest,
        controllerManifestBytes: controllerManifest.bytes,
        controllerManifestDigest: controllerManifest.digest,
        sealedAt: NOW,
      },
      operations: snapshotOperations,
      attempts: [],
      reconciliations: [],
    },
    operationKeys: {},
    markers: {},
  };
}

function operation(fixture: Fixture, operationKey: string) {
  return fixture.snapshot.operations.find((entry) => entry.operationKey === operationKey)!;
}

function applyDirect(
  fixture: Fixture,
  operation: GitHubPublicationReceiptOperationSnapshot,
  outcome: string,
  result: Record<string, unknown>,
  remoteIdentity: string,
): void {
  const selectedVariant = operation.kind;
  const terminal = terminalPayload(operation, selectedVariant, outcome, result, remoteIdentity);
  operation.state = "applied";
  operation.attemptCount = 1;
  operation.leaseGeneration = "1";
  operation.selectedVariant = selectedVariant;
  operation.terminalEvidence = null;
  operation.updatedAt = LATER;
  fixture.snapshot.attempts = [
    ...fixture.snapshot.attempts.filter((entry) => entry.operationKey !== operation.operationKey),
    claimedAttempt(operation, selectedVariant),
    evidenceAttempt(operation, selectedVariant, "dispatched", dispatchPayload(operation, selectedVariant)),
    evidenceAttempt(operation, selectedVariant, "applied", terminal, remoteIdentity),
  ];
  fixture.snapshot.reconciliations = fixture.snapshot.reconciliations.filter(
    (entry) => entry.operationKey !== operation.operationKey,
  );
}

function reconcileApplied(
  fixture: Fixture,
  operation: GitHubPublicationReceiptOperationSnapshot,
  outcome: string,
  result: Record<string, unknown>,
  remoteIdentity: string,
): void {
  const selectedVariant = operation.kind;
  const terminal = terminalPayload(operation, selectedVariant, outcome, result, remoteIdentity);
  operation.state = "applied";
  operation.attemptCount = 1;
  operation.leaseGeneration = "1";
  operation.selectedVariant = selectedVariant;
  operation.terminalEvidence = null;
  operation.updatedAt = LATER;
  fixture.snapshot.attempts = [
    ...fixture.snapshot.attempts.filter((entry) => entry.operationKey !== operation.operationKey),
    claimedAttempt(operation, selectedVariant),
    evidenceAttempt(operation, selectedVariant, "dispatched", dispatchPayload(operation, selectedVariant)),
    evidenceAttempt(operation, selectedVariant, "ambiguous", {
      ...dispatchPayload(operation, selectedVariant),
      outcome: "ambiguous",
    }),
  ];
  fixture.snapshot.reconciliations = [
    ...fixture.snapshot.reconciliations.filter((entry) => entry.operationKey !== operation.operationKey),
    {
      operationKey: operation.operationKey,
      attemptNumber: 1,
      leaseGeneration: "1",
      phase: "terminal",
      selectedVariant,
      outcome: "applied",
      evidencePayload: terminal,
      remoteIdentity,
      remoteOperationId: remoteIdentity,
      observedAt: NOW,
    } satisfies GitHubPublicationReceiptReconciliationSnapshot,
  ];
}

function rejectPlacement(
  fixture: Fixture,
  operation: GitHubPublicationReceiptOperationSnapshot,
): void {
  const selectedVariant = operation.kind;
  const terminal = terminalPayload(
    operation,
    selectedVariant,
    "rejected",
    { classification: "invalidReviewCommentPlacement", httpStatus: 422 },
    undefined,
    { httpStatus: 422, classification: "invalidReviewCommentPlacement" },
  );
  operation.state = "failed";
  operation.attemptCount = 1;
  operation.leaseGeneration = "1";
  operation.selectedVariant = selectedVariant;
  operation.terminalEvidence = terminal;
  fixture.snapshot.attempts.push(
    claimedAttempt(operation, selectedVariant),
    evidenceAttempt(operation, selectedVariant, "dispatched", dispatchPayload(operation, selectedVariant)),
    evidenceAttempt(operation, selectedVariant, "rejected", terminal),
  );
}

function skipWithoutRemote(
  fixture: Fixture,
  operation: GitHubPublicationReceiptOperationSnapshot,
): void {
  skipTerminal(
    fixture,
    operation,
    "notRequiredMarkerPresent",
    { reason: "no activation alternative is satisfied" },
  );
}

function skipWithExistingRemote(
  fixture: Fixture,
  operation: GitHubPublicationReceiptOperationSnapshot,
  outcome: string,
  result: Record<string, unknown>,
  remoteIdentity: string,
): void {
  skipTerminal(fixture, operation, outcome, result, remoteIdentity);
}

function skipTerminal(
  fixture: Fixture,
  operation: GitHubPublicationReceiptOperationSnapshot,
  outcome: string,
  result: Record<string, unknown>,
  remoteIdentity?: string,
): void {
  const selectedVariant = operation.kind;
  const terminal = terminalPayload(
    operation,
    selectedVariant,
    outcome,
    result,
    remoteIdentity,
  );
  operation.state = "skipped";
  operation.attemptCount = 1;
  operation.leaseGeneration = "1";
  operation.selectedVariant = null;
  operation.terminalEvidence = terminal;
  fixture.snapshot.attempts.push(
    claimedAttempt(operation, selectedVariant),
    evidenceAttempt(operation, selectedVariant, "not_dispatched", {
      ...terminal,
      outcome: "notDispatched",
    }),
  );
}

function claimedAttempt(
  operation: GitHubPublicationReceiptOperationSnapshot,
  selectedVariant: string,
): GitHubPublicationReceiptAttemptSnapshot {
  return {
    operationKey: operation.operationKey,
    attemptNumber: 1,
    leaseGeneration: "1",
    phase: "claimed",
    selectedVariant,
    evidencePayload: null,
    remoteIdentity: null,
    remoteOperationId: null,
    observedAt: NOW,
  };
}

function evidenceAttempt(
  operation: GitHubPublicationReceiptOperationSnapshot,
  selectedVariant: string,
  phase: GitHubPublicationReceiptAttemptSnapshot["phase"],
  evidencePayload: Record<string, unknown>,
  remoteIdentity?: string,
): GitHubPublicationReceiptAttemptSnapshot {
  return {
    operationKey: operation.operationKey,
    attemptNumber: 1,
    leaseGeneration: "1",
    phase,
    selectedVariant,
    evidencePayload,
    remoteIdentity: remoteIdentity ?? null,
    remoteOperationId: remoteIdentity ?? null,
    observedAt: NOW,
  };
}

function dispatchPayload(
  operation: GitHubPublicationReceiptOperationSnapshot,
  selectedVariant: string,
) {
  return {
    requestDigest: operation.desiredPayloadDigest,
    operationKey: operation.operationKey,
    selectedVariant,
    activationVariant: operation.kind,
    observedAt: NOW.toISOString(),
  };
}

function terminalPayload(
  operation: GitHubPublicationReceiptOperationSnapshot,
  selectedVariant: string,
  outcome: string,
  result: Record<string, unknown>,
  remoteIdentity?: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ...dispatchPayload(operation, selectedVariant),
    outcome,
    result,
    resultDigest: digestCanonical(result),
    ...(remoteIdentity === undefined
      ? {}
      : { remoteId: remoteIdentity, remoteOperationId: remoteIdentity }),
    ...extra,
  };
}

function databaseAcceptedInput(input: {
  databaseRepositoryId: string;
  reviewId: string;
  generation: string;
  expectedPullRequestUpdatedAt: string;
}) {
  return buildGitHubPublicationInputIdentity({
    databaseRepositoryId: input.databaseRepositoryId,
    githubRepositoryId: "42",
    repositoryFullName: "octo/service",
    pullRequestNumber: "7",
    controllerGeneration: input.generation,
    reviewId: input.reviewId,
    headSha: HEAD,
    mergeBaseSha: BASE,
    targetSha: TARGET,
    targetBranch: "main",
    pullRequestTitle: TITLE,
    pullRequestBody: BODY,
    expectedPullRequestUpdatedAt: input.expectedPullRequestUpdatedAt,
    cliVersion: "0.8.17",
    cliCommitSha: "d".repeat(40),
    cliArtifactSha256: digest("CLI artifact"),
    configurationSha256: digest("configuration"),
    providerIdentity: "receipt-deriver-test-provider",
    retryLineage: `receipt-deriver:${input.reviewId}:${input.generation}`,
    bounded: false,
    forceFullReview: false,
  });
}

function expectedPlan(
  seed = "review",
  generation = "17",
  inputIdentity = digest(`input:${seed}`),
): ExpectedGitHubPublicationPlan {
  return {
    controllerGeneration: generation,
    inputIdentity,
    reviewOutputDigest: digest(`output:${seed}`),
    repositoryId: "42",
    repositoryFullName: "octo/service",
    pullRequestNumber: "7",
    headSha: HEAD,
    mergeBaseSha: BASE,
    targetSha: TARGET,
    pullRequestTitle: TITLE,
    pullRequestBody: BODY,
  };
}

function advisoryCreateOperation(expected: ExpectedGitHubPublicationPlan) {
  return operationRecord(expected, "advisory-check-create", {
    kind: "advisoryCheckCreate",
    name: "postil/review",
    headSha: HEAD,
    status: "in_progress",
    externalId: `postil:postil/review:${HEAD}`,
    dependencies: [],
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: {
      logicalIdentity: `postil:postil/review:${HEAD}`,
      exclusive: true,
    },
  });
}

function advisoryCompleteOperation(
  expected: ExpectedGitHubPublicationPlan,
  preceding: Record<string, any>[],
  annotations?: Record<string, unknown>[],
) {
  const create = preceding.find((entry) => entry.kind === "advisoryCheckCreate")!;
  return operationRecord(expected, "advisory-check-complete", {
    kind: "advisoryCheckComplete",
    name: "postil/review",
    headSha: HEAD,
    createdCheck: {
      dependencyOperationKey: create.operationKey,
      resultField: "remoteId",
    },
    conclusion: "success",
    title: "Review completed",
    summary: "Publication complete.",
    ...(annotations === undefined ? {} : { annotations }),
    dependencies: preceding.map((entry) => entry.operationKey),
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: { logicalIdentity: "", exclusive: true },
  }, true);
}

function reviewOperation(
  expected: ExpectedGitHubPublicationPlan,
  attempt: "initial" | "relocatedInline" | "summaryOnly",
  reviewMarker: string,
  comments: Array<{ findingId: string; marker: string; path: string }>,
  dependencyOperationKey?: string,
) {
  const keyKind = attempt === "initial"
    ? "initial-review-create"
    : attempt === "relocatedInline"
      ? "relocated-review-create"
      : "summary-review-create";
  const dependencies = dependencyOperationKey === undefined ? [] : [dependencyOperationKey];
  const activation = attempt === "initial"
    ? {
        anyOf: [{
          condition: "markerAbsent",
          guard: { markers: [reviewMarker], headSha: HEAD, required: true },
        }],
      }
    : {
        anyOf: [{
          condition: "semanticPlacementRejected",
          dependencyOperationKey,
          httpStatus: 422,
          classification: "invalidReviewCommentPlacement",
          markerAbsence: { markers: [reviewMarker], headSha: HEAD, required: true },
        }],
      };
  return operationRecord(expected, keyKind, {
    kind: "reviewCreate",
    attempt,
    logicalReviewIdentity: logicalReviewIdentity(expected),
    payload: {
      commitId: HEAD,
      event: "COMMENT",
      body: `${attempt} review summary\n\n${reviewMarker}`,
      ...(comments.length === 0
        ? {}
        : {
            comments: comments.map((comment) => ({
              path: comment.path,
              line: 5,
              side: "RIGHT",
              body: `${comment.findingId}\n\n${comment.marker}`,
            })),
          }),
    },
    dependencies,
    activation,
    reconciliation: {
      logicalIdentity: logicalReviewIdentity(expected),
      markers: [reviewMarker],
      exclusive: true,
    },
  });
}

function operationRecord(
  expected: ExpectedGitHubPublicationPlan,
  keyKind: string,
  input: Record<string, any>,
  setLogicalIdentity = false,
) {
  const findingSalt = input.findingSalt;
  const record: Record<string, any> = {
    ordinal: 0,
    operationKey: operationKey(expected, keyKind, findingSalt),
    dependencies: input.dependencies,
    activation: input.activation,
    reconciliation: input.reconciliation,
    desiredDigest: "",
    ...Object.fromEntries(
      Object.entries(input).filter(([key]) =>
        !["dependencies", "activation", "reconciliation", "findingSalt"].includes(key)
      ),
    ),
  };
  if (setLogicalIdentity) record.reconciliation.logicalIdentity = record.operationKey;
  resignDesired(record);
  return record;
}

function finding(
  findingId: string,
  findingMarker: string,
  initialOutcome: string,
  fallbackIntent?: string[],
) {
  const body = `${findingId}\n\n${findingMarker}`;
  return {
    findingId,
    stableIdentity: true,
    path: `src/${findingId}.ts`,
    line: 5,
    initialOutcome,
    ...(fallbackIntent === undefined ? {} : { fallbackIntent }),
    contentDigest: digest(`content:${findingId}`),
    marker: findingMarker,
    desiredBody: body,
    desiredBodySha256: digest(body),
    reconciliation: "create",
    duplicateProvenance: "none",
  };
}

function resignDesired(operation: Record<string, any>): void {
  operation.desiredDigest = digestJson(desiredPayload(operation));
}

function desiredPayload(operation: Record<string, unknown>) {
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

function operationKey(
  expected: ExpectedGitHubPublicationPlan,
  kind: string,
  findingId?: string,
): string {
  const hash = createHash("sha256").update("github-publication-operation-v1\0");
  for (const value of [
    String(expected.repositoryId),
    String(expected.pullRequestNumber),
    HEAD,
    String(expected.controllerGeneration),
    expected.inputIdentity,
    expected.reviewOutputDigest!,
    kind,
  ]) hash.update(value).update("\0");
  if (findingId !== undefined) hash.update(findingId);
  return `github-publication-v1:${kind}:sha256:${hash.digest("hex")}`;
}

function logicalReviewIdentity(expected: ExpectedGitHubPublicationPlan): string {
  const hash = createHash("sha256").update("github-publication-logical-review-v1\0");
  for (const value of [
    String(expected.repositoryId),
    String(expected.pullRequestNumber),
    HEAD,
    String(expected.controllerGeneration),
    expected.inputIdentity,
    expected.reviewOutputDigest!,
  ]) hash.update(value).update("\0");
  return `github-publication-v1:review:sha256:${hash.digest("hex")}`;
}

function marker(kind: "review" | "finding", seed: string): string {
  return `<!-- postil-${kind}:v2:${hex(seed)} -->`;
}

function digest(value: string): string {
  return `sha256:${hex(value)}`;
}

function digestJson(value: unknown): string {
  return digest(JSON.stringify(value));
}

function digestCanonical(value: unknown): string {
  return digest(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function databaseAdapters(fixture: Fixture): GitHubPublicationAdapters {
  return {
    getPullRequestPublicationContext: async () => ({
      headSha: HEAD,
      baseSha: TARGET,
      open: true,
      merged: false,
      draft: false,
      updatedAt: "2026-08-15T02:00:00.000Z",
      mergeBaseSha: BASE,
      targetBranch: "main",
      title: TITLE,
      body: BODY,
    }),
    observeReview: async () => null,
    publishReview: async (_token, _repo, _pr, intent) => ({
      reviewId: "901",
      commitId: HEAD,
      body: intent.body,
      commentIdsByMarker: { [fixture.markers.inline!]: "1001" },
      missingCommentMarkers: [fixture.markers.file!],
    }),
    observeFileComment: async () =>
      null as unknown as Awaited<
        ReturnType<GitHubPublicationAdapters["observeFileComment"]>
      >,
    publishFileComment: async (_token, _repo, _pr, intent) => ({
      commentId: "1002",
      commitId: HEAD,
      path: intent.path,
      body: intent.body,
    }),
    observeReviewComment: async () =>
      null as unknown as Awaited<
        ReturnType<GitHubPublicationAdapters["observeReviewComment"]>
      >,
    updateReviewComment: async (_token, _repo, intent) => ({
      commentId: intent.commentId,
      commitId: HEAD,
      path: intent.path,
      body: intent.body,
    }),
    updateReviewSummary: async (_token, _repo, _pr, reviewId, _head, _marker, body) => ({
      reviewId,
      commitId: HEAD,
      body,
    }),
    observeCheck: async () => null,
    createCheck: async (_token, _repo, intent) =>
      intent.name === "postil/review" ? "801" : "802",
    completeCheck: async () => undefined,
    observeCheckCompletion: async (_token, _repo, intent) => ({
      checkRunId: intent.checkRunId,
      status: "completed",
      conclusion: intent.conclusion,
      desiredState: "applied",
    }),
  };
}
