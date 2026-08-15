import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  buildGitHubPublicationControllerManifest,
  GitHubPublicationControllerManifestRejectedError,
  type AuthoritativeGateOutput,
} from "@/lib/github-publication-controller-manifest";
import {
  parseGitHubPublicationPlan,
  type ExpectedGitHubPublicationPlan,
} from "@/lib/github-publication-plan";

const HEAD = "a".repeat(40);
const INPUT_IDENTITY = digest("accepted review input");
const REVIEW_OUTPUT_DIGEST = digest("accepted review output");

const gateOutput: AuthoritativeGateOutput = {
  conclusion: "success",
  title: "Merge gate passed",
  summary: "All required publication paths reached a terminal outcome.",
  detailsUrl: "https://postil.dev/orgs/acme/runs/run-17",
};

const strictParserExpected: ExpectedGitHubPublicationPlan = {
  controllerGeneration: 17n,
  inputIdentity: INPUT_IDENTITY,
  reviewOutputDigest: REVIEW_OUTPUT_DIGEST,
  repositoryId: 42n,
  repositoryFullName: "acme/api",
  pullRequestNumber: 7n,
  headSha: HEAD,
  mergeBaseSha: "b".repeat(40),
  targetSha: "c".repeat(40),
  pullRequestTitle: "Keep publication durable",
  pullRequestBody: "The service owns every external mutation.",
};

describe("GitHub publication controller manifest", () => {
  test("seals deterministic bytes without changing the accepted plan", () => {
    const plan = validPlan();
    const before = structuredClone(plan);

    const first = build(plan);
    const second = build(plan);

    expect(plan).toEqual(before);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.value).toEqual(second.value);
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toBe(digestBytes(first.bytes));
    expect(first.value.operationManifestDigest).toBe(digestCanonical(first.value.operations));
    expect(first.value.acceptedPlanBytesDigest).toBe(digestJson(plan));
    expect(first.operationBytes).toEqual(
      first.value.operations.map((operation) => Buffer.from(canonicalJson(operation), "utf8")),
    );
  });

  test("accepts a plan returned by the strict CLI plan parser", () => {
    const rawPlan = strictParserPlan();
    const acceptedPlan = parseGitHubPublicationPlan(rawPlan, strictParserExpected);

    const result = buildGitHubPublicationControllerManifest({
      acceptedPlan,
      acceptedPlanBytesDigest: digestJson(rawPlan),
      requiredTerminalOperationKeys: [acceptedPlan.operations.at(-1)!.operationKey],
      gateOutput,
    });

    expect(result.value.acceptedCliOperationCount).toBe(2);
    expect(result.value.operationCount).toBe(4);
    expect(result.value.acceptedPlanBytesDigest).toBe(digestJson(rawPlan));
  });

  test("adds exactly two service-authored gate mutations after accepted CLI operations", () => {
    const plan = validPlan();
    const result = build(plan);
    const records = result.value.operations as any[];
    const serviceOperations = records
      .filter((record) => record.source === "service")
      .map((record) => record.operation);
    const create = serviceOperations.find((operation) => operation.kind === "gateCheckCreate");
    const complete = serviceOperations.find((operation) => operation.kind === "gateCheckComplete");

    expect(serviceOperations).toHaveLength(2);
    expect(result.value.acceptedCliOperationCount).toBe(plan.operations.length);
    expect(result.value.operationCount).toBe(plan.operations.length + 2);
    expect(records.slice(0, plan.operations.length).map((record) => record.operation.operationKey))
      .toEqual(plan.operations.map((operation: any) => operation.operationKey));
    expect(records.map((record) => record.operation.ordinal)).toEqual([1, 2, 3, 4]);
    expect(create.payload).toEqual({
      name: "postil/gate",
      headSha: HEAD,
      status: "in_progress",
      externalId: create.payload.externalId,
      detailsUrl: gateOutput.detailsUrl,
    });
    expect(complete.dependencies).toEqual([
      create.operationKey,
      plan.operations[1]!.operationKey,
    ]);
    expect(complete.remoteId).toEqual({ source: "operation", operationKey: create.operationKey });
    expect(complete.payload).toEqual({
      name: "postil/gate",
      headSha: HEAD,
      status: "completed",
      conclusion: gateOutput.conclusion,
      title: gateOutput.title,
      summary: gateOutput.summary,
      detailsUrl: gateOutput.detailsUrl,
    });
  });

  test("ignores non-authoritative CLI gate prose and binds service output into gate keys", () => {
    const plan = validPlan();
    const baseline = build(plan);
    const substituted = structuredClone(plan);
    substituted.gateAnalysis.analyzedConclusion = "failure";
    substituted.gateAnalysis.title = "Untrusted gate prose";
    substituted.gateAnalysis.summary = "This cannot affect the service gate.";
    resignPlan(substituted);
    const ignored = build(substituted);
    const changed = build(plan, { ...gateOutput, conclusion: "failure", summary: "A required path failed." });

    expect(gateKeys(ignored)).toEqual(gateKeys(baseline));
    expect(ignored.value.operations.slice(-2)).toEqual(baseline.value.operations.slice(-2));
    expect(ignored.digest).not.toBe(baseline.digest);
    expect(changed.digest).not.toBe(baseline.digest);
    expect(gateKeys(changed)).not.toEqual(gateKeys(baseline));
  });

  test("rejects malformed or internally inconsistent accepted plans", () => {
    const malformedDecimal = validPlan();
    malformedDecimal.repository.id = "00";
    resignPlan(malformedDecimal);
    expectRejected(malformedDecimal, "repository id");

    const malformedSha = validPlan();
    malformedSha.reviewedSnapshot.headSha = "A".repeat(40);
    resignPlan(malformedSha);
    expectRejected(malformedSha, "head SHA");

    const wrongCount = validPlan();
    wrongCount.operationCount = 9;
    resignIntent(wrongCount);
    expectRejected(wrongCount, "operation count");

    const wrongManifest = validPlan();
    wrongManifest.operationManifestDigest = digest("different");
    resignIntent(wrongManifest);
    expectRejected(wrongManifest, "operation manifest digest");

    const wrongIntent = validPlan();
    wrongIntent.intentDigest = digest("different");
    expectRejected(wrongIntent, "intent digest");

    const untrustedGate = validPlan();
    untrustedGate.gateAnalysis.authoritative = true;
    resignPlan(untrustedGate);
    expectRejected(untrustedGate, "non-authoritative service declaration");

    expect(() => buildGitHubPublicationControllerManifest({
      acceptedPlan: validPlan(),
      acceptedPlanBytesDigest: "sha256:UPPERCASE",
      requiredTerminalOperationKeys: [],
      gateOutput,
    })).toThrow("accepted plan byte digest");
  });

  test("rejects duplicate, missing, self, and forward dependencies", () => {
    const duplicate = validPlan();
    duplicate.operations[1]!.dependencies = [
      duplicate.operations[0]!.operationKey,
      duplicate.operations[0]!.operationKey,
    ];
    resignPlan(duplicate);
    expectRejected(duplicate, "dependencies contain duplicates");

    const missing = validPlan();
    missing.operations[1]!.dependencies = [operationKey("missing")];
    resignPlan(missing);
    expectRejected(missing, "dependency is missing");

    const self = validPlan();
    self.operations[1]!.dependencies = [self.operations[1]!.operationKey];
    resignPlan(self);
    expectRejected(self, "self-referential");

    const forward = validPlan();
    forward.operations[0]!.dependencies = [forward.operations[1]!.operationKey];
    resignPlan(forward);
    expectRejected(forward, "forward");
  });

  test("enforces operation, dependency, and manifest-byte bounds", () => {
    const tooManyOperations = planWithOperations(127);
    expectRejected(tooManyOperations, "leave no space");

    const tooManyDependencies = planWithOperations(126, true);
    expectRejected(tooManyDependencies, "dependency graph is too large");

    const oversized = planWithOperations(126);
    for (const operation of oversized.operations) operation.opaquePayload = "x".repeat(70_000);
    resignPlan(oversized);
    expectRejected(oversized, "byte limit");
  });

  test("rejects policy dependencies outside the accepted graph and malformed service output", () => {
    const plan = validPlan();
    expect(() => buildGitHubPublicationControllerManifest({
      acceptedPlan: plan,
      acceptedPlanBytesDigest: digestJson(plan),
      requiredTerminalOperationKeys: [],
      gateOutput,
    })).toThrow("do not transitively seal every accepted CLI operation");
    expect(() => buildGitHubPublicationControllerManifest({
      acceptedPlan: plan,
      acceptedPlanBytesDigest: digestJson(plan),
      requiredTerminalOperationKeys: [operationKey("missing")],
      gateOutput,
    })).toThrow("absent from the accepted plan");
    expect(() => build(plan, { ...gateOutput, conclusion: "cancelled" as never })).toThrow("conclusion");
    expect(() => build(plan, { ...gateOutput, detailsUrl: "javascript:alert(1)" })).toThrow("HTTP URL");
  });
});

function build(plan: any, output = gateOutput) {
  return buildGitHubPublicationControllerManifest({
    acceptedPlan: plan,
    acceptedPlanBytesDigest: digestJson(plan),
    requiredTerminalOperationKeys: [plan.operations[1]!.operationKey],
    gateOutput: output,
  });
}

function validPlan(): any {
  const first = operation(1, "review-create", []);
  const second = operation(2, "advisory-check", [first.operationKey]);
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
      mergeBaseSha: "b".repeat(40),
      targetSha: "c".repeat(40),
      pullRequestTitleSha256: digest("Keep publication durable"),
      pullRequestBodySha256: digest("The service owns every external mutation."),
    },
    lifecycleReceipt: { version: 1, channel: "reviewComments", receiptId: "receipt-1" },
    operationCount: 2,
    operationManifestDigest: "",
    operations: [first, second],
    gateAnalysis: {
      ownership: "service",
      authoritative: false,
      organizationGateModeRequired: true,
      name: "postil/gate",
      headSha: HEAD,
      analyzedConclusion: "success",
      title: "Ignored advisory gate result",
      summary: "The controller takes its gate result from the service.",
    },
    intentDigest: "",
  };
  resignPlan(plan);
  return plan;
}

function strictParserPlan(): any {
  const create: any = {
    ordinal: 1,
    operationKey: strictParserOperationKey("advisory-check-create"),
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
  create.desiredDigest = digestJson(strictParserOperationDesired(create));
  const complete: any = {
    ordinal: 2,
    operationKey: strictParserOperationKey("advisory-check-complete"),
    dependencies: [create.operationKey],
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: {
      logicalIdentity: strictParserOperationKey("advisory-check-complete"),
      exclusive: true,
    },
    desiredDigest: "",
    kind: "advisoryCheckComplete",
    name: "postil/review",
    headSha: HEAD,
    createdCheck: {
      dependencyOperationKey: create.operationKey,
      resultField: "remoteId",
    },
    conclusion: "success",
    title: "Review completed",
    summary: "No advisory findings remain open.",
  };
  complete.desiredDigest = digestJson(strictParserOperationDesired(complete));
  const lifecycleReceipt: any = {
    version: 1,
    inputIdentity: INPUT_IDENTITY,
    channel: "reviewComments",
    receiptId: "receipt-1",
    duplicateOfBaseline: false,
    findings: [],
    digest: "",
  };
  lifecycleReceipt.digest = digestJson({
    version: lifecycleReceipt.version,
    inputIdentity: lifecycleReceipt.inputIdentity,
    channel: lifecycleReceipt.channel,
    receiptId: lifecycleReceipt.receiptId,
    compatibleReceiptIds: [],
    observedReviewId: null,
    duplicateOfBaseline: lifecycleReceipt.duplicateOfBaseline,
    findings: lifecycleReceipt.findings,
  });
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
      mergeBaseSha: "b".repeat(40),
      targetSha: "c".repeat(40),
      pullRequestTitleSha256: digest(strictParserExpected.pullRequestTitle),
      pullRequestBodySha256: digest(strictParserExpected.pullRequestBody),
    },
    lifecycleReceipt,
    operationCount: 2,
    operationManifestDigest: digestJson([create, complete]),
    operations: [create, complete],
    gateAnalysis: {
      ownership: "service",
      authoritative: false,
      organizationGateModeRequired: true,
      name: "postil/gate",
      headSha: HEAD,
      analyzedConclusion: "success",
      title: "Ignored advisory gate result",
      summary: "The controller takes its gate result from the service.",
    },
    intentDigest: "",
  };
  resignIntent(plan);
  return plan;
}

function planWithOperations(count: number, allPriorDependencies = false): any {
  const operations: any[] = [];
  for (let index = 0; index < count; index += 1) {
    operations.push(operation(
      index + 1,
      `opaque-${String(index).padStart(3, "0")}`,
      allPriorDependencies ? operations.map((entry) => entry.operationKey) : index === 0 ? [] : [operations[index - 1]!.operationKey],
    ));
  }
  const plan = validPlan();
  plan.operations = operations;
  resignPlan(plan);
  return plan;
}

function operation(ordinal: number, name: string, dependencies: string[]): any {
  return {
    ordinal,
    operationKey: operationKey(name),
    dependencies,
    activation: { anyOf: [{ condition: "always" }] },
    reconciliation: { logicalIdentity: operationKey(name), exclusive: true },
    desiredDigest: digest(`desired ${name}`),
    kind: "opaqueCliOperation",
    opaquePayload: { name },
  };
}

function operationKey(name: string): string {
  return `github-publication-v1:${name.replace(/[0-9]/g, "x")}:sha256:${hex(name)}`;
}

function strictParserOperationKey(
  kind: "advisory-check-create" | "advisory-check-complete",
): string {
  const hash = createHash("sha256").update("github-publication-operation-v1\0");
  for (const value of [
    "42",
    "7",
    HEAD,
    "17",
    INPUT_IDENTITY,
    REVIEW_OUTPUT_DIGEST,
    kind,
  ]) hash.update(value).update("\0");
  return `github-publication-v1:${kind}:sha256:${hash.digest("hex")}`;
}

function strictParserOperationDesired(operation: any): Record<string, unknown> {
  const {
    ordinal: _, operationKey: __, dependencies: ___, activation: ____,
    reconciliation: _____, desiredDigest: ______, ...desired
  } = operation;
  return desired;
}

function resignPlan(plan: any): void {
  plan.operationCount = plan.operations.length;
  for (const [index, operation] of plan.operations.entries()) operation.ordinal = index + 1;
  plan.operationManifestDigest = digestJson(plan.operations);
  resignIntent(plan);
}

function resignIntent(plan: any): void {
  const { intentDigest: _, ...unsignedPlan } = plan;
  plan.intentDigest = digestJson(unsignedPlan);
}

function expectRejected(plan: unknown, message: string): void {
  const requiredTerminalOperationKeys = typeof plan === "object" && plan !== null &&
      Array.isArray((plan as any).operations) && (plan as any).operations.length > 0
    ? [(plan as any).operations.at(-1).operationKey]
    : [];
  expect(() => buildGitHubPublicationControllerManifest({
    acceptedPlan: plan,
    acceptedPlanBytesDigest: typeof plan === "object" && plan !== null ? digestJson(plan) : digest("unknown"),
    requiredTerminalOperationKeys,
    gateOutput,
  })).toThrow(GitHubPublicationControllerManifestRejectedError);
  expect(() => buildGitHubPublicationControllerManifest({
    acceptedPlan: plan,
    acceptedPlanBytesDigest: typeof plan === "object" && plan !== null ? digestJson(plan) : digest("unknown"),
    requiredTerminalOperationKeys,
    gateOutput,
  })).toThrow(message);
}

function gateKeys(result: ReturnType<typeof build>): string[] {
  return (result.value.operations as any[])
    .filter((record) => record.source === "service")
    .map((record) => record.operation.operationKey);
}

function digest(value: string): string {
  return digestBytes(Buffer.from(value, "utf8"));
}

function digestJson(value: unknown): string {
  return digestBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function digestCanonical(value: unknown): string {
  return digestBytes(Buffer.from(canonicalJson(value), "utf8"));
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: any): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
