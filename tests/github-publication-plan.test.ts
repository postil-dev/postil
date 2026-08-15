import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  GitHubPublicationPlanRejectedError,
  parseGitHubPublicationPlan,
  parseGitHubPublicationPlanBytes,
  type ExpectedGitHubPublicationPlan,
} from "@/lib/github-publication-plan";

const HEAD = "a".repeat(40);
const MERGE_BASE = "b".repeat(40);
const TARGET = "c".repeat(40);
const INPUT_IDENTITY = digest("accepted review input");
const REVIEW_OUTPUT_DIGEST = digest("accepted review output");

const expected: ExpectedGitHubPublicationPlan = {
  controllerGeneration: 17n,
  inputIdentity: INPUT_IDENTITY,
  reviewOutputDigest: REVIEW_OUTPUT_DIGEST,
  repositoryId: 42n,
  repositoryFullName: "acme/api",
  pullRequestNumber: 7n,
  headSha: HEAD,
  mergeBaseSha: MERGE_BASE,
  targetSha: TARGET,
  pullRequestTitle: "Keep publication durable",
  pullRequestBody: "The service owns every external mutation.",
};

describe("GitHub publication plan", () => {
  test("defers the output digest only for envelope-authenticated planning", () => {
    expect(parseGitHubPublicationPlan(validPlan(), {
      ...expected,
      reviewOutputDigest: undefined,
    }).reviewOutputDigest).toBe(REVIEW_OUTPUT_DIGEST);
  });

  test("accepts one exact canonical no-write plan", () => {
    const plan = validPlan();

    expect(parseGitHubPublicationPlan(plan, expected)).toEqual(plan);
  });

  test("retains the exact bounded stdout artifact identity", () => {
    const plan = validPlan();
    const bytes = Buffer.from(`${JSON.stringify(plan)}\n`, "utf8");

    const accepted = parseGitHubPublicationPlanBytes(bytes, expected);
    expect(accepted.value).toEqual(plan);
    expect(Buffer.from(accepted.bytes)).toEqual(bytes);
    expect(accepted.digest).toBe(createHash("sha256").update(bytes).digest("hex"));

    expect(() => parseGitHubPublicationPlanBytes(Buffer.from(JSON.stringify(plan)), expected))
      .toThrow("one JSON value followed by one newline");
    expect(() => parseGitHubPublicationPlanBytes(Buffer.from([0xff, 0x20, 0x0a]), expected))
      .toThrow("valid UTF-8");
    expect(() => parseGitHubPublicationPlanBytes(Buffer.from(` ${JSON.stringify(plan)}\n`), expected))
      .toThrow("canonical compact JSON");
    expect(() => parseGitHubPublicationPlanBytes(new Uint8Array(8 * 1024 * 1024 + 1), expected))
      .toThrow("3..8388608 bytes");
  });

  test("rejects unknown fields at every trusted boundary", () => {
    const plan = validPlan();
    plan.operations[0]!.reconciliation.untrusted = true;

    expectRejected(plan);
  });

  test("binds the plan to the accepted repository and pull-request snapshot", () => {
    const plan = validPlan();
    plan.reviewedSnapshot.targetSha = "d".repeat(40);
    resign(plan);

    expectRejected(plan, "target SHA");
  });

  test("rejects a lifecycle digest that omits canonical null and empty fields", () => {
    const plan = validPlan();
    plan.lifecycleReceipt.digest = jsonDigest({
      version: plan.lifecycleReceipt.version,
      channel: plan.lifecycleReceipt.channel,
      receiptId: plan.lifecycleReceipt.receiptId,
      duplicateOfBaseline: false,
      findings: [],
    });
    resign(plan);

    expectRejected(plan, "lifecycle receipt digest");
  });

  test("bounds receipt identities to the durable receipt schema", () => {
    const plan = validPlan();
    plan.lifecycleReceipt.receiptId = "r".repeat(201);
    resign(plan);

    expectRejected(plan, "200 UTF-8 bytes");
  });

  test("binds lifecycle state to the service-supplied input identity", () => {
    const plan = validPlan();
    plan.lifecycleReceipt.inputIdentity = digest("different input");
    plan.lifecycleReceipt.digest = lifecycleDigest(plan.lifecycleReceipt);
    resignIntent(plan);

    expectRejected(plan, "lifecycle receipt input identity");
  });

  test("binds advisory creation to its exact run and head identity", () => {
    const plan = validPlan();
    plan.operations[0]!.externalId = `postil:other-run:postil/review:${HEAD}`;
    plan.operations[0]!.reconciliation.logicalIdentity = plan.operations[0]!.externalId;
    resignDesired(plan, 0);
    resignManifestAndIntent(plan);

    expectRejected(plan, "external identity");

    const unsafeUrl = validPlan();
    unsafeUrl.operations[0]!.detailsUrl = "javascript:alert(1)";
    unsafeUrl.operations[1]!.detailsUrl = "javascript:alert(1)";
    resignDesired(unsafeUrl, 0);
    resignDesired(unsafeUrl, 1);
    resignManifestAndIntent(unsafeUrl);
    expectRejected(unsafeUrl, "HTTP or HTTPS");
  });

  test("rejects desired-payload substitution", () => {
    const plan = validPlan();
    plan.operations.at(-1)!.title = "A different result";
    resignManifestAndIntent(plan);

    expectRejected(plan, "operation desired digest");
  });

  test("rejects manifest substitution even when the outer intent is resigned", () => {
    const plan = validPlan();
    plan.operations.at(-1)!.summary = "A different summary";
    plan.operations.at(-1)!.desiredDigest = jsonDigest(operationDesired(plan.operations.at(-1)!));
    resignIntent(plan);

    expectRejected(plan, "operation manifest digest");
  });

  test("rejects operation-key substitution even when every digest is resigned", () => {
    const plan = validPlan();
    plan.operations[0]!.operationKey = plan.operations[0]!.operationKey.replace(/.$/, "0");
    plan.operations[1]!.dependencies = [plan.operations[0]!.operationKey];
    plan.operations[1]!.createdCheck.dependencyOperationKey = plan.operations[0]!.operationKey;
    resign(plan);

    expectRejected(plan, "operation key");
  });

  test("rejects duplicate and forward operation dependencies", () => {
    const duplicate = validTwoOperationPlan();
    duplicate.operations.at(-1)!.dependencies = [
      duplicate.operations[0]!.operationKey,
      duplicate.operations[0]!.operationKey,
    ];
    resign(duplicate);
    expectRejected(duplicate, "dependencies contain duplicates");

    const forward = validTwoOperationPlan();
    forward.operations[0]!.dependencies = [forward.operations[1]!.operationKey];
    resign(forward);
    expectRejected(forward, "missing, forward, or cyclic");
  });

  test("rejects activation references outside declared dependencies", () => {
    const plan = validTwoOperationPlan();
    plan.operations[1]!.dependencies = [];
    plan.operations[1]!.activation = {
      anyOf: [{
        condition: "semanticPlacementRejected",
        dependencyOperationKey: plan.operations[0]!.operationKey,
        httpStatus: 422,
        classification: "invalidReviewCommentPlacement",
        markerAbsence: {
          markers: [reviewMarker("receipt-1")],
          headSha: HEAD,
          required: true,
        },
      }],
    };
    resign(plan);

    expectRejected(plan, "undeclared dependency");
  });

  test("rejects marker guards substituted under valid resigned digests", () => {
    const wrongHead = validTwoOperationPlan();
    wrongHead.operations[1]!.activation.anyOf[0].guard.headSha = "d".repeat(40);
    resign(wrongHead);
    expectRejected(wrongHead, "different head");

    const wrongMarker = validTwoOperationPlan();
    wrongMarker.operations[1]!.activation.anyOf[0].guard.markers = [
      reviewMarker("unrelated"),
    ];
    resign(wrongMarker);
    expectRejected(wrongMarker, "differs from operation reconciliation markers");
  });

  test("rejects advisory publication that is not unique and terminal", () => {
    const plan = validPlan();
    plan.operations.push(structuredClone(plan.operations.at(-1)!));
    plan.operations.at(-1)!.operationKey = computedOperationKey("advisory-check-complete", "second");
    resign(plan);

    expectRejected(plan, "operation key");
  });

  test("rejects a gate mutation hidden under an unrecognized operation kind", () => {
    const plan = validPlan();
    plan.operations.at(-1)!.kind = "gateCheck";

    expectRejected(plan);
  });

  test("rejects reversed annotation and comment ranges", () => {
    const annotations = validPlan();
    annotations.operations.at(-1)!.annotations = [{
      path: "src/controller.ts",
      startLine: 10,
      endLine: 9,
      annotationLevel: "warning",
      title: "Invalid range",
      message: "The final line precedes the first line.",
    }];
    resignDesired(annotations, annotations.operations.length - 1);
    resignManifestAndIntent(annotations);
    expectRejected(annotations, "annotation range");

    const comments = validTwoOperationPlan();
    comments.operations[1]!.payload.comments = [{
      path: "src/controller.ts",
      line: 10,
      side: "RIGHT",
      startLine: 11,
      startSide: "RIGHT",
      body: `Finding body\n\n${findingMarker("one")}`,
    }];
    resignDesired(comments, 1);
    resignManifestAndIntent(comments);
    expectRejected(comments, "starts after");
  });
});

function validPlan(): any {
  const create = advisoryCreateOperation();
  const complete = advisoryCompleteOperation(2, [create.operationKey]);
  const lifecycleReceipt: any = {
    version: 1,
    inputIdentity: INPUT_IDENTITY,
    channel: "reviewComments",
    receiptId: "receipt-1",
    duplicateOfBaseline: false,
    findings: [],
    digest: "",
  };
  lifecycleReceipt.digest = lifecycleDigest(lifecycleReceipt);
  const plan: any = {
    version: 1,
    forge: "github",
    controllerGeneration: "17",
    inputIdentity: INPUT_IDENTITY,
    reviewOutputDigest: REVIEW_OUTPUT_DIGEST,
    repository: { id: "42", fullName: "acme/api" },
    pullRequestNumber: "7",
    reviewedSnapshot: {
      headSha: HEAD,
      mergeBaseSha: MERGE_BASE,
      targetSha: TARGET,
      pullRequestTitleSha256: digest(expected.pullRequestTitle),
      pullRequestBodySha256: digest(expected.pullRequestBody),
    },
    lifecycleReceipt,
    operationCount: 2,
    operationManifestDigest: jsonDigest([create, complete]),
    operations: [create, complete],
    gateAnalysis: {
      ownership: "service",
      authoritative: false,
      organizationGateModeRequired: true,
      name: "postil/gate",
      headSha: HEAD,
      analyzedConclusion: "success",
      title: "Merge gate passed",
      summary: "No configured finding blocks this head.",
    },
    intentDigest: "",
  };
  resignIntent(plan);
  return plan;
}

function validTwoOperationPlan(): any {
  const plan = validPlan();
  const marker = reviewMarker("receipt-1");
  const reviewIdentity = computedReviewIdentity();
  const review: any = {
    ordinal: 1,
    operationKey: computedOperationKey("initial-review-create"),
    dependencies: [],
    activation: {
      anyOf: [{
        condition: "markerAbsent",
        guard: { markers: [marker], headSha: HEAD, required: true },
      }],
    },
    reconciliation: {
      logicalIdentity: reviewIdentity,
      markers: [marker],
      exclusive: true,
    },
    desiredDigest: "",
    kind: "reviewCreate",
    attempt: "initial",
    logicalReviewIdentity: reviewIdentity,
    payload: {
      commitId: HEAD,
      event: "COMMENT",
      body: `Review summary\n\n${marker}`,
    },
  };
  review.desiredDigest = jsonDigest(operationDesired(review));
  const create = advisoryCreateOperation();
  const advisory = advisoryCompleteOperation(3, [create.operationKey, review.operationKey]);
  plan.operations = [create, review, advisory];
  resign(plan);
  return plan;
}

function advisoryCreateOperation(): any {
  const operation: any = {
    ordinal: 1,
    operationKey: computedOperationKey("advisory-check-create"),
    dependencies: [],
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: {
      logicalIdentity: `postil:postil/review:${HEAD}`,
      exclusive: true,
    },
    desiredDigest: "",
    kind: "advisoryCheckCreate",
    name: "postil/review",
    headSha: HEAD,
    status: "in_progress",
    externalId: `postil:postil/review:${HEAD}`,
  };
  operation.desiredDigest = jsonDigest(operationDesired(operation));
  return operation;
}

function advisoryCompleteOperation(ordinal: number, dependencies: string[]): any {
  const operation: any = {
    ordinal,
    operationKey: computedOperationKey("advisory-check-complete"),
    dependencies,
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: {
      logicalIdentity: computedOperationKey("advisory-check-complete"),
      exclusive: true,
    },
    desiredDigest: "",
    kind: "advisoryCheckComplete",
    name: "postil/review",
    headSha: HEAD,
    createdCheck: {
      dependencyOperationKey: computedOperationKey("advisory-check-create"),
      resultField: "remoteId",
    },
    conclusion: "success",
    title: "Review completed",
    summary: "No advisory findings remain open.",
  };
  operation.desiredDigest = jsonDigest(operationDesired(operation));
  return operation;
}

function resign(plan: any): void {
  plan.operationCount = plan.operations.length;
  for (const [index, operation] of plan.operations.entries()) operation.ordinal = index + 1;
  resignManifestAndIntent(plan);
}

function resignDesired(plan: any, index: number): void {
  plan.operations[index].desiredDigest = jsonDigest(operationDesired(plan.operations[index]));
}

function resignManifestAndIntent(plan: any): void {
  plan.operationManifestDigest = jsonDigest(plan.operations);
  resignIntent(plan);
}

function resignIntent(plan: any): void {
  const { intentDigest: _, ...canonical } = plan;
  plan.intentDigest = jsonDigest(canonical);
}

function lifecycleDigest(receipt: any): string {
  return jsonDigest({
    version: receipt.version,
    inputIdentity: receipt.inputIdentity,
    channel: receipt.channel,
    receiptId: receipt.receiptId,
    compatibleReceiptIds: receipt.compatibleReceiptIds ?? [],
    observedReviewId: receipt.observedReviewId ?? null,
    duplicateOfBaseline: receipt.duplicateOfBaseline,
    findings: receipt.findings,
  });
}

function operationDesired(operation: any): Record<string, unknown> {
  const {
    ordinal: _, operationKey: __, dependencies: ___, activation: ____,
    reconciliation: _____, desiredDigest: ______, ...desired
  } = operation;
  return desired;
}

function computedOperationKey(kind: string, salt = ""): string {
  const hash = createHash("sha256").update("github-publication-operation-v1\0");
  for (const value of [
    "42",
    "7",
    HEAD,
    "17",
    INPUT_IDENTITY,
    REVIEW_OUTPUT_DIGEST,
    kind,
  ]) {
    hash.update(value).update("\0");
  }
  if (salt) hash.update(salt);
  return `github-publication-v1:${kind}:sha256:${hash.digest("hex")}`;
}

function computedReviewIdentity(): string {
  const hash = createHash("sha256").update("github-publication-logical-review-v1\0");
  for (const value of [
    "42",
    "7",
    HEAD,
    "17",
    INPUT_IDENTITY,
    REVIEW_OUTPUT_DIGEST,
  ]) {
    hash.update(value).update("\0");
  }
  return `github-publication-v1:review:sha256:${hash.digest("hex")}`;
}

function reviewMarker(receiptId: string): string {
  return `<!-- postil-review:v2:${hex(receiptId)} -->`;
}

function findingMarker(findingId: string): string {
  return `<!-- postil-finding:v2:${hex(findingId)} -->`;
}

function digest(value: string): string {
  return `sha256:${hex(value)}`;
}

function jsonDigest(value: unknown): string {
  return digest(JSON.stringify(value));
}

function hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectRejected(value: unknown, message?: string): void {
  expect(() => parseGitHubPublicationPlan(value, expected)).toThrow(
    message ?? GitHubPublicationPlanRejectedError,
  );
}
