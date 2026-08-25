import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  buildGitHubPublicationControllerManifest,
  type BuiltGitHubPublicationControllerManifest,
} from "@/lib/github-publication-controller-manifest";
import {
  deriveGitHubPublicationReceipt,
  GitHubPublicationReceiptDerivationError,
  type GitHubPublicationReceiptAttemptSnapshot,
  type GitHubPublicationReceiptEvidenceSnapshot,
  type GitHubPublicationReceiptOperationSnapshot,
  type GitHubPublicationReceiptReconciliationSnapshot,
} from "@/lib/github-publication-receipt-deriver";
import {
  parseGitHubPublicationPlanBytes,
  type AcceptedGitHubPublicationPlan,
  type ExpectedGitHubPublicationPlan,
} from "@/lib/github-publication-plan";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TARGET = "c".repeat(40);
const TITLE = "Derive publication receipts from durable evidence";
const BODY = "The receipt binds only sealed intent and exact terminal observations.";
const NOW = new Date("2026-08-15T03:00:00.000Z");
const LATER = new Date("2026-08-15T03:00:01.000Z");

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
          commentId: "700",
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

  test("requires normalized durable bindings for carried comment identities", () => {
    const missing = reviewFixture();
    missing.snapshot.carriedCommentBindings = [];
    expect(() => deriveGitHubPublicationReceipt(missing.snapshot)).toThrow(
      "carried finding lacks exact durable comment binding evidence",
    );

    const conflicting = reviewFixture();
    conflicting.snapshot.carriedCommentBindings[0]!.commentId = "702";
    expect(() => deriveGitHubPublicationReceipt(conflicting.snapshot)).toThrow(
      "conflicts with the sealed lifecycle identity",
    );

    const duplicate = reviewFixture();
    duplicate.snapshot.carriedCommentBindings.push({
      findingId: "carried-1",
      commentId: "700",
    });
    expect(() => deriveGitHubPublicationReceipt(duplicate.snapshot)).toThrow(
      "carried comment binding is duplicated",
    );

    const extraneous = reviewFixture();
    extraneous.snapshot.carriedCommentBindings.push({
      findingId: "summary-1",
      commentId: "703",
    });
    expect(() => deriveGitHubPublicationReceipt(extraneous.snapshot)).toThrow(
      "carried comment binding is extraneous",
    );

    const unnormalized = reviewFixture();
    unnormalized.snapshot.carriedCommentBindings[0] = {
      findingId: "carried-1",
      commentId: "700",
      source: "untrusted",
    } as never;
    expect(() => deriveGitHubPublicationReceipt(unnormalized.snapshot)).toThrow(
      "carried comment binding is not normalized",
    );
  });

  test("rejects a carried finding without a sealed prior comment identity", () => {
    const fixture = checkCarriedFixture();
    const finding = fixture.acceptedPlan.value.lifecycleReceipt.findings[0] as Record<string, unknown>;
    finding.observedCommentId = undefined;
    finding.reconciliation = "create";
    fixture.snapshot.carriedCommentBindings = [];
    resealLifecycleReceipt(fixture);

    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "carried finding lacks an exact prior comment identity",
    );
  });

  test("rejects carried comment identities shared with current publication evidence", () => {
    const fixture = reviewFixture();
    const fallback = operation(fixture, fixture.operationKeys.file!);
    applyDirect(
      fixture,
      fallback,
      "created",
      { commentId: "700", commitId: HEAD, path: "src/file.ts", body: "file" },
      "700",
    );

    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "one remote comment identity is assigned to multiple findings",
    );
  });

  test("rejects a resealed gate selection that differs from its terminal dependencies", () => {
    const fixture = reviewFixture();
    const completionIndex = fixture.controllerManifest.value.operations.findIndex(
      (record) => record.operation.kind === "gateCheckComplete",
    );
    const completion = fixture.controllerManifest.value.operations[completionIndex]!
      .operation as Record<string, any>;
    completion.payload.selection.requiredOperationKeys = [];
    resealControllerOperation(fixture, completionIndex);

    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "required terminal operation keys do not transitively seal every accepted CLI operation",
    );
  });

  test("does not treat marker-only reconciliation as exact summary evidence", () => {
    const fixture = reviewFixture();
    const review = operation(fixture, fixture.operationKeys.review!);
    fixture.snapshot.attempts = fixture.snapshot.attempts.filter(
      (entry) => entry.operationKey !== review.operationKey,
    );
    skipWithExistingRemote(
      fixture,
      review,
      "reconciledExisting",
      {
        reviewId: "901",
        commentIdsByMarker: { [fixture.markers.inline!]: "1001" },
        missingCommentMarkers: [fixture.markers.file!],
      },
      "901",
    );

    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "summary-only finding lacks exact review summary evidence",
    );
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

  test("requires typed observed check content", () => {
    const fixture = checkFixture();
    const complete = operation(fixture, fixture.operationKeys.advisoryComplete!);
    const evidence = fixture.snapshot.attempts.find(
      (entry) => entry.operationKey === complete.operationKey && entry.phase === "applied",
    )!.evidencePayload!;
    const result = evidence.result as Record<string, any>;
    delete result.observedContent;
    evidence.resultDigest = digestCanonical(result);

    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "observed check content must be an object",
    );
  });

  test.each([
    ["path", "src/wrong.ts"],
    ["startLine", 5],
    ["endLine", 5],
    ["title", "Wrong title"],
    ["message", "Wrong message"],
  ])("rejects a check annotation with an observed %s mismatch", (field, value) => {
    const fixture = checkFixture();
    const complete = operation(fixture, fixture.operationKeys.advisoryComplete!);
    const evidence = fixture.snapshot.attempts.find(
      (entry) => entry.operationKey === complete.operationKey && entry.phase === "applied",
    )!.evidencePayload!;
    const result = evidence.result as Record<string, any>;
    const observed = result.observedContent as Record<string, any>;
    observed.annotations[0]![field] = value;
    evidence.resultDigest = digestCanonical(result);

    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "advisory check evidence does not match the sealed content",
    );
  });

  test("rejects carried review-comment evidence on the check-annotation channel", () => {
    expect(() => deriveGitHubPublicationReceipt(checkCarriedFixture().snapshot)).toThrow(
      "check-annotation publication carries review-comment evidence",
    );
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

  test("carries a partial fallback's review identity without treating it as a comment", () => {
    const fixture = reviewFixture();
    const fallback = operation(fixture, fixture.operationKeys.file!);
    fixture.snapshot.attempts = fixture.snapshot.attempts.filter(
      (entry) => entry.operationKey !== fallback.operationKey,
    );
    skipWithExistingRemote(
      fixture,
      fallback,
      "notRequiredMarkerPresent",
      { reviewId: "901" },
      "901",
    );

    const receipt = deriveGitHubPublicationReceipt(fixture.snapshot);
    expect(receipt.reviewId).toBe("901");
    expect(receipt.findings.find((entry) => entry.findingId === "file-1")).toEqual({
      findingId: "file-1",
      stableIdentity: true,
      initialOutcome: "summaryOnly",
      inlineRejected: true,
    });
  });

  test("uses compatible finding markers for review and fallback derivation", () => {
    const receipt = deriveGitHubPublicationReceipt(
      reviewFixture("18", true).snapshot,
    );
    expect(receipt.findings.find((entry) => entry.findingId === "file-1")).toMatchObject({
      initialOutcome: "fileComment",
      commentId: "1002",
    });
  });

  test("rejects remote identities outside signed int64 storage", () => {
    const fixture = reviewFixture();
    const review = operation(fixture, fixture.operationKeys.review!);
    const applied = fixture.snapshot.attempts.find(
      (entry) => entry.operationKey === review.operationKey && entry.phase === "applied",
    )!;
    const tooLarge = "9223372036854775808";
    applied.remoteIdentity = tooLarge;
    applied.remoteOperationId = tooLarge;
    applied.evidencePayload!.remoteId = tooLarge;
    applied.evidencePayload!.remoteOperationId = tooLarge;
    (applied.evidencePayload!.result as Record<string, unknown>).reviewId = tooLarge;
    applied.evidencePayload!.resultDigest = digestCanonical(applied.evidencePayload!.result);
    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "remote identity is malformed",
    );
  });

  test("binds summary updates to the uniquely selected review and accepts exact reconciliation", () => {
    const fixture = reviewFixture("19", false, true);
    const summary = operation(fixture, fixture.operationKeys.summary!);
    const receipt = deriveGitHubPublicationReceipt(fixture.snapshot);
    expect(receipt.reviewId).toBe("901");

    fixture.snapshot.attempts = fixture.snapshot.attempts.filter(
      (entry) => entry.operationKey !== summary.operationKey,
    );
    skipWithExistingRemote(
      fixture,
      summary,
      "reconciledExisting",
      { reviewId: "901", body: "Summary update\n\n" + fixture.markers.review + "\n\n" + fixture.markers.summary },
      "901",
    );
    expect(deriveGitHubPublicationReceipt(fixture.snapshot).reviewId).toBe("901");

    const wrong = reviewFixture("20", false, true);
    const wrongSummary = operation(wrong, wrong.operationKeys.summary!);
    const applied = wrong.snapshot.attempts.find(
      (entry) => entry.operationKey === wrongSummary.operationKey && entry.phase === "applied",
    )!;
    (applied.evidencePayload!.result as Record<string, any>).reviewId = "904";
    applied.evidencePayload!.remoteId = "904";
    applied.evidencePayload!.remoteOperationId = "904";
    applied.remoteIdentity = "904";
    applied.remoteOperationId = "904";
    applied.evidencePayload!.resultDigest = digestCanonical(applied.evidencePayload!.result);
    expect(() => deriveGitHubPublicationReceipt(wrong.snapshot)).toThrow(
      "review summary evidence targets a different review or body",
    );
  });

  test("binds raw operation and activation bytes instead of semantic JSON", () => {
    const operationDrift = reviewFixture();
    const review = operation(operationDrift, operationDrift.operationKeys.review!);
    operationDrift.snapshot.operations.find((entry) => entry.operationKey === review.operationKey)!
      .operationRecordBytes = Buffer.from(
        `${new TextDecoder().decode(review.operationRecordBytes)} `,
        "utf8",
      );
    expect(() => deriveGitHubPublicationReceipt(operationDrift.snapshot)).toThrow(
      "operation serialized bytes drifted from their sealed records",
    );

    const activationDrift = reviewFixture();
    const activationReview = operation(activationDrift, activationDrift.operationKeys.review!);
    activationDrift.snapshot.operations.find((entry) => entry.operationKey === activationReview.operationKey)!
      .activationBytes = Buffer.from(
        `${new TextDecoder().decode(activationReview.activationBytes)} `,
        "utf8",
      );
    expect(() => deriveGitHubPublicationReceipt(activationDrift.snapshot)).toThrow(
      "operation serialized bytes drifted from their sealed records",
    );
  });

  test("cross-checks semantic 422 metadata against the observed result", () => {
    const fixture = rejectedPlacementFixture();
    const initial = operation(fixture, fixture.operationKeys.initial!);
    const rejected = fixture.snapshot.attempts.find(
      (entry) => entry.operationKey === initial.operationKey && entry.phase === "rejected",
    )!.evidencePayload!;
    (rejected.result as Record<string, any>).httpStatus = 403;
    rejected.resultDigest = digestCanonical(rejected.result);
    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "failed definitively",
    );
  });

  test("rejects duplicate missing markers before converting them to a set", () => {
    const fixture = reviewFixture();
    const evidence = fixture.snapshot.attempts.find(
      (entry) => entry.operationKey === fixture.operationKeys.review && entry.phase === "applied",
    )!.evidencePayload!;
    const missing = (evidence.result as Record<string, any>).missingCommentMarkers as string[];
    missing.push(missing[0]!);
    evidence.resultDigest = digestCanonical(evidence.result);
    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "missing review comment markers contain duplicates",
    );
  });

  test("rejects reconciliation evidence that contradicts failed or skipped state", () => {
    const failed = rejectedPlacementFixture();
    const failedOperation = operation(failed, failed.operationKeys.initial!);
    failed.snapshot.reconciliations.push({
      operationKey: failedOperation.operationKey,
      attemptNumber: 1,
      leaseGeneration: "1",
      phase: "terminal",
      selectedVariant: failedOperation.kind,
      outcome: "applied",
      evidencePayload: failedOperation.terminalEvidence!,
      remoteIdentity: null,
      remoteOperationId: null,
      observedAt: NOW,
    });
    expect(() => deriveGitHubPublicationReceipt(failed.snapshot)).toThrow(
      "failed operation lacks exact rejection state",
    );

    const skipped = reviewFixture();
    const skippedOperation = operation(skipped, skipped.operationKeys.review!);
    skipped.snapshot.attempts = skipped.snapshot.attempts.filter(
      (entry) => entry.operationKey !== skippedOperation.operationKey,
    );
    skipWithoutRemote(skipped, skippedOperation);
    skipped.snapshot.reconciliations.push({
      operationKey: skippedOperation.operationKey,
      attemptNumber: 1,
      leaseGeneration: "1",
      phase: "terminal",
      selectedVariant: skippedOperation.kind,
      outcome: "applied",
      evidencePayload: skippedOperation.terminalEvidence!,
      remoteIdentity: null,
      remoteOperationId: null,
      observedAt: NOW,
    });
    expect(() => deriveGitHubPublicationReceipt(skipped.snapshot)).toThrow(
      "skipped operation has contradictory reconciliation evidence",
    );
  });

  test("binds check-channel summary-only findings to summary evidence", () => {
    expect(() => deriveGitHubPublicationReceipt(checkFixture("21", false).snapshot)).toThrow(
      "check summary-only finding lacks exact summary or finding evidence",
    );
  });

  test("bounds carried bindings and canonical evidence JSON", () => {
    const carried = reviewFixture();
    for (let index = 0; index < 64; index += 1) {
      carried.snapshot.carriedCommentBindings.push({
        findingId: `extra-${index}`,
        commentId: String(10_000 + index),
      });
    }
    expect(() => deriveGitHubPublicationReceipt(carried.snapshot)).toThrow(
      "carried comment bindings exceed their bound",
    );

    const nodes = checkFixture("22");
    const complete = operation(nodes, nodes.operationKeys.advisoryComplete!);
    const evidence = nodes.snapshot.attempts.find(
      (entry) => entry.operationKey === complete.operationKey && entry.phase === "applied",
    )!.evidencePayload!;
    (evidence.result as Record<string, any>).large = Array.from({ length: 10_001 }, (_, index) => index);
    evidence.resultDigest = digestCanonical(evidence.result);
    expect(() => deriveGitHubPublicationReceipt(nodes.snapshot)).toThrow(
      "publication evidence JSON exceeds its node bound",
    );

    const deep = checkFixture("24");
    const deepComplete = operation(deep, deep.operationKeys.advisoryComplete!);
    const deepEvidence = deep.snapshot.attempts.find(
      (entry) => entry.operationKey === deepComplete.operationKey && entry.phase === "applied",
    )!.evidencePayload!;
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) nested = { nested };
    (deepEvidence.result as Record<string, any>).nested = nested;
    deepEvidence.resultDigest = digestCanonical(deepEvidence.result);
    expect(() => deriveGitHubPublicationReceipt(deep.snapshot)).toThrow(
      "publication evidence JSON exceeds its depth bound",
    );
  });

  test("never trusts a planned observed comment identity without exact terminal evidence", () => {
    const fixture = retainedCommentFixture();
    const update = operation(fixture, fixture.operationKeys.update!);
    skipWithoutRemote(fixture, update);

    expect(() => deriveGitHubPublicationReceipt(fixture.snapshot)).toThrow(
      "finding comment update evidence targets a different remote comment",
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
      message: "selected variant differs from its operation kind",
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
      message: "activation variant is not a sealed alternative",
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

function reviewFixture(
  generation = "17",
  compatibleFileMarker = false,
  withSummaryUpdate = false,
): Fixture {
  const expected = expectedPlan(`review-${generation}`, generation);
  const markers = {
    carried: marker("finding", "carried-1"),
    file: marker("finding", "file-1"),
    fileCompatible: marker("finding", "file-1-compatible"),
    inline: marker("finding", "inline-1"),
    resolved: marker("finding", "resolved-1"),
    summary: marker("finding", "summary-1"),
    suppressed: marker("finding", "suppressed-1"),
    review: marker("review", "receipt-review"),
  };
  const findings = [
    {
      findingId: "carried-1",
      stableIdentity: true,
      path: "src/carried-1.ts",
      line: 5,
      initialOutcome: "carried",
      contentDigest: digest("content:carried-1"),
      marker: markers.carried,
      desiredBody: `carried-1\n\n${markers.carried}`,
      desiredBodySha256: digest(`carried-1\n\n${markers.carried}`),
      observedCommentId: "700",
      observedOutcome: "inline",
      reconciliation: "retain",
      duplicateProvenance: "none",
    },
    finding(
      "file-1",
      markers.file,
      "inline",
      ["fileComment", "summaryOnly"],
      compatibleFileMarker ? [markers.fileCompatible] : undefined,
    ),
    finding("inline-1", markers.inline, "inline"),
    finding("resolved-1", markers.resolved, "resolved"),
    finding("summary-1", markers.summary, "summaryOnly"),
    finding("suppressed-1", markers.suppressed, "suppressed"),
  ];
  const fileMarker = compatibleFileMarker ? markers.fileCompatible : markers.file;
  const advisoryCreate = advisoryCreateOperation(expected);
  const review = reviewOperation(expected, "initial", markers.review, [
    { findingId: "inline-1", marker: markers.inline, path: "src/inline.ts" },
    { findingId: "file-1", marker: fileMarker, path: "src/file.ts" },
  ], undefined, [markers.summary]);
  const fallback = operationRecord(expected, "file-comment-fallback", {
    kind: "fileCommentFallback",
    findingId: "file-1",
    payload: {
      body: `File finding\n\n${fileMarker}`,
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
        markers: [fileMarker],
        headSha: HEAD,
        required: true,
      },
    }] },
    reconciliation: {
      logicalIdentity: "",
      markers: [fileMarker],
      exclusive: true,
    },
    findingSalt: "file-1",
  });
  fallback.reconciliation.logicalIdentity = fallback.operationKey;
  resignDesired(fallback);
  const operations = [advisoryCreate, review, fallback];
  const summary = withSummaryUpdate
    ? operationRecord(expected, "review-summary-update", {
        kind: "reviewSummaryUpdate",
        logicalReviewIdentity: logicalReviewIdentity(expected),
        terminalOperations: [{
          operationKey: fallback.operationKey,
          findingId: "file-1",
          requiresRemoteId: true,
          acceptedOutcomes: ["applied", "reconciledExisting", "notRequiredMarkerPresent"],
        }],
        cases: [{
          selectedReviewOperationKey: review.operationKey,
          selectedReviewOutcomes: ["partialObserved"],
          fileCommentCount: 1,
          body: `Summary update\n\n${markers.review}\n\n${markers.summary}`,
        }],
        dependencies: [review.operationKey, fallback.operationKey],
        activation: {
          anyOf: [{
            condition: "reviewSelectionTerminal",
            selectedReviewOperationKeys: [review.operationKey],
          }],
        },
        reconciliation: {
          logicalIdentity: logicalReviewIdentity(expected),
          markers: [markers.review],
          exclusive: true,
        },
      })
    : undefined;
  if (summary !== undefined) operations.push(summary);
  operations.push(
    advisoryCompleteOperation(
      expected,
      summary === undefined ? operations : [advisoryCreate, summary],
    ),
  );
  const fixture = buildFixture(expected, "reviewComments", "receipt-review", findings, operations);
  fixture.snapshot.carriedCommentBindings = [
    { findingId: "carried-1", commentId: "700" },
  ];
  fixture.operationKeys = {
    advisoryCreate: advisoryCreate.operationKey,
    review: review.operationKey,
    file: fallback.operationKey,
    ...(summary === undefined ? {} : { summary: summary.operationKey }),
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
      missingCommentMarkers: [fileMarker],
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
  if (summary !== undefined) {
    applyDirect(
      fixture,
      operation(fixture, summary.operationKey),
      "applied",
      {
        reviewId: "901",
        body: `Summary update\n\n${markers.review}\n\n${markers.summary}`,
      },
      "901",
    );
  }
  applyDirect(
    fixture,
    operation(fixture, fixture.operationKeys.advisoryComplete!),
    "applied",
    { checkRunId: "801", conclusion: "success" },
    "801",
  );
  return fixture;
}

function checkFixture(generation = "17", includeSummaryMarker = true): Fixture {
  const expected = expectedPlan(`check-${generation}`, generation);
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
  }], includeSummaryMarker ? [markers.summary] : []);
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

function checkCarriedFixture(): Fixture {
  const expected = expectedPlan("check-carried");
  const findingMarker = marker("finding", "check-carried-1");
  const desiredBody = `check-carried-1\n\n${findingMarker}`;
  const findings = [{
    findingId: "check-carried-1",
    stableIdentity: true,
    path: "src/check-carried-1.ts",
    line: 5,
    initialOutcome: "carried",
    contentDigest: digest("content:check-carried-1"),
    marker: findingMarker,
    desiredBody,
    desiredBodySha256: digest(desiredBody),
    observedCommentId: "712",
    observedOutcome: "inline",
    reconciliation: "retain",
    duplicateProvenance: "none",
  }];
  const create = advisoryCreateOperation(expected);
  const complete = advisoryCompleteOperation(expected, [create]);
  const fixture = buildFixture(
    expected,
    "checkAnnotations",
    "receipt-check-carried",
    findings,
    [create, complete],
  );
  fixture.snapshot.carriedCommentBindings = [{
    findingId: "check-carried-1",
    commentId: "712",
  }];
  applyDirect(
    fixture,
    operation(fixture, create.operationKey),
    "created",
    { checkRunId: "812" },
    "812",
  );
  applyDirect(
    fixture,
    operation(fixture, complete.operationKey),
    "applied",
    { checkRunId: "812", conclusion: "success" },
    "812",
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
    [markers.finding],
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
      carriedCommentBindings: [],
    },
    operationKeys: {},
    markers: {},
  };
}

function operation(fixture: Fixture, operationKey: string) {
  return fixture.snapshot.operations.find((entry) => entry.operationKey === operationKey)!;
}

function resealControllerOperation(fixture: Fixture, index: number): void {
  const manifest = fixture.controllerManifest.value;
  const record = manifest.operations[index]!;
  const operation = record.operation as Record<string, any>;
  operation.desiredDigest = digestCanonical(desiredPayload(operation));
  manifest.operationManifestDigest = digestCanonical(manifest.operations);

  const recordBytes = Buffer.from(canonicalJson(record), "utf8");
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  fixture.controllerManifest.operationBytes[index] = recordBytes;
  fixture.controllerManifest.bytes = manifestBytes;
  fixture.controllerManifest.digest = digestCanonical(manifest);

  const snapshotOperation = fixture.snapshot.operations[index]!;
  const desired = desiredPayload(operation);
  snapshotOperation.controllerRecord = structuredClone(record);
  snapshotOperation.controllerRecordBytes = recordBytes;
  snapshotOperation.operationRecord = structuredClone(operation);
  snapshotOperation.operationRecordBytes = Buffer.from(JSON.stringify(operation), "utf8");
  snapshotOperation.desiredPayload = desired;
  snapshotOperation.desiredPayloadBytes = Buffer.from(JSON.stringify(desired), "utf8");
  snapshotOperation.desiredPayloadDigest = operation.desiredDigest;

  fixture.snapshot.generation.controllerOperationManifestDigest =
    manifest.operationManifestDigest;
  fixture.snapshot.generation.controllerManifestBytes = manifestBytes;
  fixture.snapshot.generation.controllerManifestDigest = digestCanonical(manifest);
}

function resealLifecycleReceipt(fixture: Fixture): void {
  const plan = fixture.acceptedPlan.value as Record<string, any>;
  const lifecycle = plan.lifecycleReceipt as Record<string, any>;
  lifecycle.digest = digestJson({
    version: lifecycle.version,
    inputIdentity: lifecycle.inputIdentity,
    channel: lifecycle.channel,
    receiptId: lifecycle.receiptId,
    compatibleReceiptIds: lifecycle.compatibleReceiptIds ?? [],
    observedReviewId: lifecycle.observedReviewId ?? null,
    duplicateOfBaseline: lifecycle.duplicateOfBaseline,
    findings: lifecycle.findings,
  });
  const { intentDigest: _intentDigest, ...intent } = plan;
  plan.intentDigest = digestJson(intent);
  const bytes = Buffer.from(`${JSON.stringify(plan)}\n`, "utf8");
  fixture.acceptedPlan.bytes = bytes;
  fixture.acceptedPlan.digest = digestBytes(bytes);
  fixture.snapshot.generation.acceptedPlanBytes = bytes;
  fixture.snapshot.generation.acceptedPlanDigest = fixture.acceptedPlan.digest;
  fixture.snapshot.generation.planSemanticDigest = plan.intentDigest.slice("sha256:".length);

  const manifest = buildGitHubPublicationControllerManifest({
    acceptedPlan: fixture.acceptedPlan.value,
    acceptedPlanBytesDigest: `sha256:${fixture.acceptedPlan.digest}`,
    requiredTerminalOperationKeys: [fixture.acceptedPlan.value.operations.at(-1)!.operationKey],
    gateOutput: {
      conclusion: "success",
      title: "Publication gate complete",
      summary: "Every required publication operation reached a terminal state.",
      detailsUrl: "https://postil.dev/orgs/octo/runs/receipt-deriver",
    },
  });
  fixture.controllerManifest = manifest;
  fixture.snapshot.generation.controllerOperationManifestDigest =
    manifest.value.operationManifestDigest;
  fixture.snapshot.generation.controllerManifestBytes = manifest.bytes;
  fixture.snapshot.generation.controllerManifestDigest = manifest.digest;
  fixture.snapshot.operations.forEach((operation, index) => {
    operation.controllerRecord = structuredClone(manifest.value.operations[index]!) as Record<string, unknown>;
    operation.controllerRecordBytes = Uint8Array.from(manifest.operationBytes[index]!);
  });
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
  activationVariant = activationVariantFor(operation),
) {
  return {
    requestDigest: operation.desiredPayloadDigest,
    operationKey: operation.operationKey,
    selectedVariant,
    activationVariant,
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
  activationVariant = terminalActivationVariant(operation, outcome),
) {
  const observedResult = withObservedContent(operation, result);
  return {
    ...dispatchPayload(operation, selectedVariant, activationVariant),
    outcome,
    result: observedResult,
    resultDigest: digestCanonical(observedResult),
    ...(remoteIdentity === undefined
      ? {}
      : { remoteId: remoteIdentity, remoteOperationId: remoteIdentity }),
    ...extra,
  };
}

function withObservedContent(
  operation: GitHubPublicationReceiptOperationSnapshot,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const planned = operation.operationRecord as Record<string, any>;
  switch (operation.kind) {
    case "reviewCreate": {
      const commentIds = result.commentIdsByMarker as Record<string, string> | undefined;
      if (commentIds === undefined) return result;
      const comments = (planned.payload.comments ?? []).flatMap((comment: Record<string, any>) => {
        const marker = Object.keys(commentIds).find((candidate) => comment.body.includes(candidate));
        return marker === undefined
          ? []
          : [{
              commentId: commentIds[marker],
              path: comment.path,
              line: comment.line,
              side: comment.side,
              ...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
              ...(comment.startSide === undefined ? {} : { startSide: comment.startSide }),
              body: comment.body,
            }];
      });
      return {
        ...result,
        observedContent: { body: planned.payload.body, comments },
      };
    }
    case "fileCommentFallback":
      if (result.commentId === undefined) return result;
      return {
        ...result,
        observedContent: {
          body: planned.payload.body,
          commitId: planned.payload.commitId,
          path: planned.payload.path,
          subjectType: planned.payload.subjectType,
        },
      };
    case "findingCommentUpdate":
      if (result.commentId === undefined) return result;
      return {
        ...result,
        observedContent: { body: planned.body },
      };
    case "reviewSummaryUpdate":
      if (result.body === undefined) return result;
      return {
        ...result,
        observedContent: { body: result.body },
      };
    case "advisoryCheckComplete":
      return {
        ...result,
        observedContent: {
          name: planned.name,
          headSha: planned.headSha,
          conclusion: planned.conclusion,
          title: planned.title,
          summary: planned.summary,
          annotations: (planned.annotations ?? []).map((annotation: Record<string, any>) => ({
            path: annotation.path,
            startLine: annotation.startLine,
            endLine: annotation.endLine,
            annotationLevel: annotation.annotationLevel,
            title: annotation.title,
            message: annotation.message,
          })),
          ...(planned.detailsUrl === undefined ? {} : { detailsUrl: planned.detailsUrl }),
        },
      };
    default:
      return result;
  }
}

function activationVariantFor(operation: GitHubPublicationReceiptOperationSnapshot): string {
  const condition = (operation.operationRecord as any).activation.anyOf[0].condition;
  switch (condition) {
    case "always":
      return "always";
    case "markerAbsent":
      return "marker-absent";
    case "semanticPlacementRejected":
      return "semantic-422-fallback";
    case "partialReviewObserved":
      return "partial-review-fallback";
    case "findingContentDiffers":
      return "finding-content-differs";
    case "reviewSelectionTerminal":
      return "review-selection-terminal";
    default:
      return "always";
  }
}

function terminalActivationVariant(
  operation: GitHubPublicationReceiptOperationSnapshot,
  outcome: string,
): string {
  if (outcome === "reconciledExisting") return "reconciled-existing";
  if (outcome === "notRequiredContentExact") return "content-already-exact";
  if (outcome === "notRequiredMarkerPresent") {
    return operation.kind === "fileCommentFallback"
      ? "partial-review-marker-present"
      : "not-activated";
  }
  return activationVariantFor(operation);
}

function expectedPlan(seed = "review", generation = "17"): ExpectedGitHubPublicationPlan {
  return {
    controllerGeneration: generation,
    inputIdentity: digest(`input:${seed}`),
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
  summaryMarkers: string[] = [],
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
    summary: `Publication complete.${summaryMarkers.length === 0 ? "" : `\n\n${summaryMarkers.join("\n")}`}`,
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
  bodyMarkers: string[] = [],
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
      body: `${attempt} review summary\n\n${reviewMarker}${bodyMarkers.length === 0 ? "" : `\n\n${bodyMarkers.join("\n")}`}`,
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
  compatibleMarkers?: string[],
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
    ...(compatibleMarkers === undefined ? {} : { compatibleMarkers }),
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

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
