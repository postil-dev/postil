import { createHash } from "node:crypto";

import { z } from "zod";

const MAX_OPERATIONS = 126;
const MAX_DEPENDENCY_EDGES = 1_024;
const MAX_FINDINGS = 64;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_AGGREGATE_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DECIMAL_IDENTIFIER = /^[1-9][0-9]{0,18}$/;
const OPERATION_KEY = /^github-publication-v1:[a-z-]+:sha256:[0-9a-f]{64}$/;
const MARKER = /^<!-- postil-(?:review|finding):v(?:1:[0-9a-f]{12}|2:[0-9a-f]{64}) -->$/;

const boundedString = (maximum = MAX_TEXT_BYTES) =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maximum, {
    message: `string exceeds ${maximum} UTF-8 bytes`,
  });
const nonEmptyString = (maximum = 2_048) => boundedString(maximum).min(1);
const decimalIdentifier = z.string().regex(DECIMAL_IDENTIFIER).refine(
  (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
  "decimal identifier exceeds signed 64-bit storage",
);
const sha256 = z.string().regex(SHA256);
const gitSha = z.string().regex(GIT_SHA);
const marker = z.string().regex(MARKER);
const operationKey = z.string().regex(OPERATION_KEY);
const positiveLine = z.number().int().min(1).max(2_147_483_647);
const httpUrl = z.string().url().max(2_048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "URL must use HTTP or HTTPS");

const repositorySchema = z.object({
  id: decimalIdentifier,
  fullName: z.string().regex(/^[^/\s]{1,100}\/[^/\s]{1,100}$/),
}).strict();

const snapshotSchema = z.object({
  headSha: gitSha,
  mergeBaseSha: gitSha,
  targetSha: gitSha,
  pullRequestTitleSha256: sha256,
  pullRequestBodySha256: sha256,
}).strict();

const findingOutcomeSchema = z.enum([
  "inline",
  "checkAnnotation",
  "summaryOnly",
  "carried",
  "resolved",
  "suppressed",
  "unknown",
  "fileComment",
]);

const findingSchema = z.object({
  findingId: nonEmptyString(500),
  stableIdentity: z.boolean(),
  path: nonEmptyString(4_096),
  line: positiveLine,
  endLine: positiveLine.optional(),
  initialOutcome: findingOutcomeSchema,
  fallbackIntent: z.array(z.enum([
    "relocatedInline",
    "fileComment",
    "summaryOnly",
  ])).max(3).optional(),
  contentDigest: sha256,
  marker,
  compatibleMarkers: z.array(marker).max(8).optional(),
  desiredBody: boundedString(),
  desiredBodySha256: sha256,
  observedCommentId: decimalIdentifier.optional(),
  observedBodySha256: sha256.optional(),
  observedOutcome: findingOutcomeSchema.optional(),
  reconciliation: z.enum(["create", "retain", "replace", "omit"]),
  suppressionReason: z.enum([
    "nonActionable",
    "ignored",
    "belowSeverity",
    "belowConfidence",
    "maxFindings",
    "anchorMismatch",
    "duplicateRootCause",
    "derivedFromSuppressed",
    "repositoryClaimUnsupported",
  ]).optional(),
  duplicateProvenance: z.enum(["none", "baseline", "suppressedRootCause"]),
}).strict();

const lifecycleReceiptSchema = z.object({
  version: z.literal(1),
  inputIdentity: sha256,
  channel: z.enum(["reviewComments", "checkAnnotations"]),
  receiptId: nonEmptyString(200),
  compatibleReceiptIds: z.array(nonEmptyString(200)).max(16).optional(),
  observedReviewId: decimalIdentifier.optional(),
  duplicateOfBaseline: z.boolean(),
  findings: z.array(findingSchema).max(MAX_FINDINGS),
  digest: sha256,
}).strict();

const markerAbsenceGuardSchema = z.object({
  markers: z.array(marker).min(1).max(16),
  headSha: gitSha,
  required: z.literal(true),
}).strict();

const activationConditionSchema = z.discriminatedUnion("condition", [
  z.object({ condition: z.literal("always") }).strict(),
  z.object({
    condition: z.literal("markerAbsent"),
    guard: markerAbsenceGuardSchema,
  }).strict(),
  z.object({
    condition: z.literal("semanticPlacementRejected"),
    dependencyOperationKey: operationKey,
    httpStatus: z.literal(422),
    classification: z.literal("invalidReviewCommentPlacement"),
    markerAbsence: markerAbsenceGuardSchema,
  }).strict(),
  z.object({
    condition: z.literal("partialReviewObserved"),
    dependencyOperationKey: operationKey,
    reviewMarkers: z.array(marker).min(1).max(16),
    findingMarkerAbsence: markerAbsenceGuardSchema,
  }).strict(),
  z.object({
    condition: z.literal("findingContentDiffers"),
    observedCommentId: decimalIdentifier,
    expectedMarkers: z.array(marker).min(1).max(16),
  }).strict(),
  z.object({
    condition: z.literal("reviewSelectionTerminal"),
    selectedReviewOperationKeys: z.array(operationKey).min(1).max(3),
  }).strict(),
]);

const activationSchema = z.object({
  anyOf: z.array(activationConditionSchema).min(1).max(8),
}).strict();

const reconciliationSchema = z.object({
  logicalIdentity: nonEmptyString(500),
  markers: z.array(marker).max(16).optional(),
  observedRemoteId: decimalIdentifier.optional(),
  exclusive: z.literal(true),
}).strict();

const reviewCommentSchema = z.object({
  path: nonEmptyString(4_096),
  line: positiveLine,
  side: z.enum(["LEFT", "RIGHT"]),
  startLine: positiveLine.optional(),
  startSide: z.enum(["LEFT", "RIGHT"]).optional(),
  body: boundedString(),
}).strict();

const reviewPayloadSchema = z.object({
  commitId: gitSha,
  event: z.literal("COMMENT"),
  body: boundedString(),
  comments: z.array(reviewCommentSchema).max(MAX_FINDINGS).optional(),
}).strict();

const fileCommentPayloadSchema = z.object({
  body: boundedString(),
  commitId: gitSha,
  path: nonEmptyString(4_096),
  subjectType: z.literal("file"),
}).strict();

const terminalOperationSchema = z.object({
  operationKey,
  findingId: nonEmptyString(500).optional(),
  requiresRemoteId: z.boolean(),
  acceptedOutcomes: z.array(z.enum([
    "applied",
    "reconciledExisting",
    "notRequiredMarkerPresent",
  ])).min(1).max(3),
}).strict();

const summaryCaseSchema = z.object({
  selectedReviewOperationKey: operationKey,
  selectedReviewOutcomes: z.array(z.enum([
    "created",
    "reconciledExisting",
    "partialObserved",
  ])).min(1).max(3),
  fileCommentCount: z.number().int().min(0).max(MAX_FINDINGS),
  body: boundedString(),
}).strict();

const annotationSchema = z.object({
  path: nonEmptyString(4_096),
  startLine: positiveLine,
  endLine: positiveLine,
  annotationLevel: z.enum(["notice", "warning", "failure"]),
  title: nonEmptyString(255),
  message: nonEmptyString(65_535),
}).strict();

const operationResultReferenceSchema = z.object({
  dependencyOperationKey: operationKey,
  resultField: z.literal("remoteId"),
}).strict();

const operationBase = {
  ordinal: z.number().int().min(1).max(MAX_OPERATIONS),
  operationKey,
  dependencies: z.array(operationKey).max(MAX_OPERATIONS),
  activation: activationSchema,
  reconciliation: reconciliationSchema,
  desiredDigest: sha256,
};

const operationSchema = z.discriminatedUnion("kind", [
  z.object({
    ...operationBase,
    kind: z.literal("reviewCreate"),
    attempt: z.enum(["initial", "relocatedInline", "summaryOnly"]),
    logicalReviewIdentity: nonEmptyString(500),
    payload: reviewPayloadSchema,
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("fileCommentFallback"),
    findingId: nonEmptyString(500),
    payload: fileCommentPayloadSchema,
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("findingCommentUpdate"),
    findingId: nonEmptyString(500),
    observedCommentId: decimalIdentifier,
    expectedMarkers: z.array(marker).min(1).max(16),
    body: boundedString(),
    bodySha256: sha256,
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("reviewSummaryUpdate"),
    logicalReviewIdentity: nonEmptyString(500),
    terminalOperations: z.array(terminalOperationSchema).max(MAX_OPERATIONS),
    cases: z.array(summaryCaseSchema).min(1).max(MAX_FINDINGS * 4),
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("advisoryCheckCreate"),
    name: z.literal("postil/review"),
    headSha: gitSha,
    status: z.literal("in_progress"),
    externalId: nonEmptyString(500),
    detailsUrl: httpUrl.optional(),
  }).strict(),
  z.object({
    ...operationBase,
    kind: z.literal("advisoryCheckComplete"),
    name: z.literal("postil/review"),
    headSha: gitSha,
    createdCheck: operationResultReferenceSchema,
    conclusion: z.enum(["success", "failure", "neutral"]),
    title: nonEmptyString(255),
    summary: boundedString(),
    annotations: z.array(annotationSchema).max(MAX_FINDINGS).optional(),
    detailsUrl: httpUrl.optional(),
  }).strict(),
]);

const gateAnalysisSchema = z.object({
  ownership: z.literal("service"),
  authoritative: z.literal(false),
  organizationGateModeRequired: z.literal(true),
  name: z.literal("postil/gate"),
  headSha: gitSha,
  analyzedConclusion: z.enum(["success", "failure", "neutral"]),
  title: nonEmptyString(255),
  summary: boundedString(),
  detailsUrl: httpUrl.optional(),
}).strict();

const publicationPlanSchema = z.object({
  version: z.literal(1),
  forge: z.literal("github"),
  controllerGeneration: decimalIdentifier,
  inputIdentity: sha256,
  reviewOutputDigest: sha256,
  repository: repositorySchema,
  pullRequestNumber: decimalIdentifier,
  reviewedSnapshot: snapshotSchema,
  lifecycleReceipt: lifecycleReceiptSchema,
  operationCount: z.number().int().min(0).max(MAX_OPERATIONS),
  operationManifestDigest: sha256,
  operations: z.array(operationSchema).max(MAX_OPERATIONS),
  gateAnalysis: gateAnalysisSchema,
  intentDigest: sha256,
}).strict();

export type GitHubPublicationPlan = z.infer<typeof publicationPlanSchema>;
export type GitHubPublicationOperation = GitHubPublicationPlan["operations"][number];

export interface ExpectedGitHubPublicationPlan {
  controllerGeneration: bigint | string;
  inputIdentity: string;
  /** Omit only while the planner immediately authenticates it against the envelope. */
  reviewOutputDigest?: string;
  repositoryId: bigint | string;
  repositoryFullName: string;
  pullRequestNumber: bigint | string;
  headSha: string;
  mergeBaseSha: string;
  targetSha: string;
  pullRequestTitle: string;
  pullRequestBody: string;
}

export interface AcceptedGitHubPublicationPlan {
  bytes: Uint8Array;
  value: GitHubPublicationPlan;
  digest: string;
}

export class GitHubPublicationPlanRejectedError extends Error {
  override name = "GitHubPublicationPlanRejectedError";

  constructor(reason: string) {
    super(`GitHub publication plan rejected: ${reason}`);
  }
}

/** Parse and authenticate one no-write CLI publication plan against its input. */
export function parseGitHubPublicationPlan(
  value: unknown,
  expected: ExpectedGitHubPublicationPlan,
): GitHubPublicationPlan {
  const result = publicationPlanSchema.safeParse(value);
  if (!result.success) {
    throw new GitHubPublicationPlanRejectedError(z.prettifyError(result.error));
  }
  const plan = result.data;
  validateExpectedIdentity(plan, expected);
  validateLifecycleReceipt(plan);
  validateOperationGraph(plan);
  validateOperationSemantics(plan);
  validateDigests(plan);
  return plan;
}

/** Accept the exact bounded CLI stdout artifact and retain its byte identity. */
export function parseGitHubPublicationPlanBytes(
  source: Uint8Array,
  expected: ExpectedGitHubPublicationPlan,
): AcceptedGitHubPublicationPlan {
  if (source.byteLength < 3 || source.byteLength > MAX_PLAN_BYTES) {
    reject(`plan artifact must contain 3..${MAX_PLAN_BYTES} bytes`);
  }
  const bytes = Uint8Array.from(source);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject("plan artifact is not valid UTF-8");
  }
  if (!text.endsWith("\n") || text.endsWith("\n\n") || text.includes("\0")) {
    reject("plan artifact must be one JSON value followed by one newline");
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    reject("plan artifact is not valid JSON");
  }
  const plan = parseGitHubPublicationPlan(value, expected);
  if (text !== `${JSON.stringify(plan)}\n`) {
    reject("plan artifact is not canonical compact JSON");
  }
  return {
    bytes,
    value: plan,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateExpectedIdentity(
  plan: GitHubPublicationPlan,
  expected: ExpectedGitHubPublicationPlan,
): void {
  const exact: Array<[string, string, string]> = [
    ["controller generation", plan.controllerGeneration, String(expected.controllerGeneration)],
    ["repository id", plan.repository.id, String(expected.repositoryId)],
    ["repository full name", plan.repository.fullName, expected.repositoryFullName],
    ["pull request number", plan.pullRequestNumber, String(expected.pullRequestNumber)],
    ["head SHA", plan.reviewedSnapshot.headSha, expected.headSha],
    ["merge-base SHA", plan.reviewedSnapshot.mergeBaseSha, expected.mergeBaseSha],
    ["target SHA", plan.reviewedSnapshot.targetSha, expected.targetSha],
    ["title digest", plan.reviewedSnapshot.pullRequestTitleSha256, textDigest(expected.pullRequestTitle)],
    ["body digest", plan.reviewedSnapshot.pullRequestBodySha256, textDigest(expected.pullRequestBody)],
  ];
  if (expected.reviewOutputDigest !== undefined) {
    exact.push(["review output digest", plan.reviewOutputDigest, expected.reviewOutputDigest]);
  }
  exact.push(["input identity", plan.inputIdentity, expected.inputIdentity]);
  for (const [name, actual, wanted] of exact) {
    if (actual !== wanted) reject(`${name} does not match the accepted review input`);
  }
  if (plan.gateAnalysis.headSha !== plan.reviewedSnapshot.headSha) {
    reject("gate analysis targets a different head");
  }
}

function validateLifecycleReceipt(plan: GitHubPublicationPlan): void {
  const receipt = plan.lifecycleReceipt;
  if (receipt.inputIdentity !== plan.inputIdentity) {
    reject("lifecycle receipt input identity differs from the plan");
  }
  const findingIds = new Set<string>();
  const commentIds = new Set<string>();
  const compatibleReceiptIds = receipt.compatibleReceiptIds ?? [];
  assertUniqueSorted(compatibleReceiptIds, "compatible receipt identities");
  let precedingFindingId: string | undefined;
  for (const finding of receipt.findings) {
    if (findingIds.has(finding.findingId)) reject("lifecycle receipt repeats a finding identity");
    if (precedingFindingId !== undefined && finding.findingId <= precedingFindingId) {
      reject("lifecycle findings are not strictly sorted by identity");
    }
    precedingFindingId = finding.findingId;
    findingIds.add(finding.findingId);
    assertUnique(finding.compatibleMarkers ?? [], "compatible finding markers");
    if (finding.endLine !== undefined && finding.endLine < finding.line) {
      reject("finding end line precedes its start line");
    }
    if (finding.desiredBodySha256 !== textDigest(finding.desiredBody)) {
      reject("finding desired body digest does not match its body");
    }
    if (!finding.desiredBody.includes(finding.marker)) {
      reject("finding desired body omits its durable marker");
    }
    if (finding.observedCommentId !== undefined) {
      if (commentIds.has(finding.observedCommentId)) {
        reject("lifecycle receipt reuses a GitHub comment identity");
      }
      commentIds.add(finding.observedCommentId);
    }
    if (finding.reconciliation === "replace" && finding.observedCommentId === undefined) {
      reject("finding replacement has no observed comment identity");
    }
    if (finding.reconciliation === "retain" && finding.observedCommentId === undefined) {
      reject("retained finding has no observed comment identity");
    }
    if (receipt.channel === "checkAnnotations" && ["inline", "fileComment"].includes(finding.initialOutcome)) {
      reject("check-annotation receipt contains a review-comment outcome");
    }
    if (receipt.channel === "reviewComments" && finding.initialOutcome === "checkAnnotation") {
      reject("review-comment receipt contains a check-annotation outcome");
    }
  }
  if (receipt.channel === "checkAnnotations" && receipt.observedReviewId !== undefined) {
    reject("check-annotation receipt carries a review identity");
  }
}

function validateOperationGraph(plan: GitHubPublicationPlan): void {
  if (plan.operationCount !== plan.operations.length) {
    reject("operation count does not match the manifest");
  }
  const ordinalByKey = new Map<string, number>();
  let dependencyEdges = 0;
  for (const [index, operation] of plan.operations.entries()) {
    if (operation.ordinal !== index + 1) reject("operation ordinals are not contiguous and one-based");
    if (ordinalByKey.has(operation.operationKey)) reject("operation key is duplicated");
    ordinalByKey.set(operation.operationKey, operation.ordinal);
  }
  for (const operation of plan.operations) {
    dependencyEdges += operation.dependencies.length;
    if (dependencyEdges > MAX_DEPENDENCY_EDGES) reject("operation dependency graph is too large");
    assertUnique(operation.dependencies, "operation dependencies");
    const dependencies = new Set(operation.dependencies);
    for (const dependency of dependencies) {
      const ordinal = ordinalByKey.get(dependency);
      if (ordinal === undefined || ordinal >= operation.ordinal) {
        reject("operation dependency is missing, forward, or cyclic");
      }
    }
    for (const condition of operation.activation.anyOf) {
      for (const referenced of activationReferences(condition)) {
        if (!dependencies.has(referenced)) {
          reject("operation activation references an undeclared dependency");
        }
      }
    }
  }
}

function validateOperationSemantics(plan: GitHubPublicationPlan): void {
  const expectedReviewIdentity = reviewIdentity(plan);
  const findingIds = new Set(plan.lifecycleReceipt.findings.map((finding) => finding.findingId));
  const operationByKey = new Map(plan.operations.map((operation) => [operation.operationKey, operation]));
  let advisoryCreate:
    | Extract<GitHubPublicationOperation, { kind: "advisoryCheckCreate" }>
    | undefined;
  let advisoryComplete:
    | Extract<GitHubPublicationOperation, { kind: "advisoryCheckComplete" }>
    | undefined;
  const reviewAttempts = new Set<string>();
  let aggregateTextBytes = 0;
  for (const operation of plan.operations) {
    const expectedKey = computedOperationKey(plan, operation);
    if (operation.operationKey !== expectedKey) reject("operation key does not match immutable input identity");
    if (operation.kind === "reviewCreate" || operation.kind === "reviewSummaryUpdate") {
      if (operation.logicalReviewIdentity !== expectedReviewIdentity) {
        reject("review operation has the wrong logical identity");
      }
      if (operation.reconciliation.logicalIdentity !== expectedReviewIdentity) {
        reject("review reconciliation has the wrong logical identity");
      }
    } else if (
      operation.kind !== "advisoryCheckCreate" &&
      operation.reconciliation.logicalIdentity !== operation.operationKey
    ) {
      reject("non-review reconciliation has the wrong logical identity");
    }
    if (operation.kind === "reviewCreate") {
      aggregateTextBytes += Buffer.byteLength(operation.payload.body, "utf8");
      if (reviewAttempts.has(operation.attempt)) reject("review attempt kind is duplicated");
      reviewAttempts.add(operation.attempt);
      if (operation.payload.commitId !== plan.reviewedSnapshot.headSha) {
        reject("review operation targets a different head");
      }
      if (!(operation.reconciliation.markers ?? []).some((entry) => operation.payload.body.includes(entry))) {
        reject("review body omits its reconciliation marker");
      }
      for (const comment of operation.payload.comments ?? []) {
        aggregateTextBytes += Buffer.byteLength(comment.body, "utf8");
        if (comment.startLine === undefined !== (comment.startSide === undefined)) {
          reject("review comment range is incomplete");
        }
        if (comment.startLine !== undefined && comment.startLine > comment.line) {
          reject("review comment range starts after its final line");
        }
      }
      const conditions = operation.activation.anyOf.map((condition) => condition.condition);
      if (
        operation.attempt === "initial"
          ? !sameStrings(conditions, ["markerAbsent"])
          : !sameStrings(conditions, ["semanticPlacementRejected"])
      ) {
        reject("review operation has an invalid activation contract");
      }
    }
    if (operation.kind === "fileCommentFallback") {
      aggregateTextBytes += Buffer.byteLength(operation.payload.body, "utf8");
      if (!findingIds.has(operation.findingId)) reject("file-comment operation names an unknown finding");
      if (operation.payload.commitId !== plan.reviewedSnapshot.headSha) {
        reject("file-comment operation targets a different head");
      }
      if (!(operation.reconciliation.markers ?? []).some((entry) => operation.payload.body.includes(entry))) {
        reject("file-comment body omits its reconciliation marker");
      }
      if (operation.reconciliation.observedRemoteId !== undefined) {
        reject("file-comment creation already carries a remote identity");
      }
      if (operation.activation.anyOf.some((condition) =>
        condition.condition !== "semanticPlacementRejected" && condition.condition !== "partialReviewObserved"
      )) {
        reject("file-comment fallback has an invalid activation contract");
      }
    }
    if (operation.kind === "findingCommentUpdate") {
      aggregateTextBytes += Buffer.byteLength(operation.body, "utf8");
      if (!findingIds.has(operation.findingId)) reject("comment update names an unknown finding");
      if (operation.bodySha256 !== textDigest(operation.body)) reject("comment update body digest is invalid");
      if (operation.reconciliation.observedRemoteId !== operation.observedCommentId) {
        reject("comment update remote identity does not match its target");
      }
      if (!sameStrings(operation.reconciliation.markers ?? [], operation.expectedMarkers)) {
        reject("comment update reconciliation markers differ from its expected markers");
      }
      if (
        operation.dependencies.length !== 0 ||
        operation.activation.anyOf.length !== 1 ||
        operation.activation.anyOf[0]?.condition !== "findingContentDiffers" ||
        operation.activation.anyOf[0].observedCommentId !== operation.observedCommentId ||
        !sameStrings(operation.activation.anyOf[0].expectedMarkers, operation.expectedMarkers)
      ) {
        reject("comment update has an invalid activation contract");
      }
    }
    if (operation.kind === "reviewSummaryUpdate") {
      const dependencies = new Set(operation.dependencies);
      for (const terminal of operation.terminalOperations) {
        if (!dependencies.has(terminal.operationKey)) {
          reject("summary terminal operation is not a declared dependency");
        }
        if (terminal.findingId !== undefined && !findingIds.has(terminal.findingId)) {
          reject("summary terminal operation names an unknown finding");
        }
        assertUnique(terminal.acceptedOutcomes, "summary terminal outcomes");
      }
      for (const summaryCase of operation.cases) {
        aggregateTextBytes += Buffer.byteLength(summaryCase.body, "utf8");
        if (!dependencies.has(summaryCase.selectedReviewOperationKey)) {
          reject("summary case selects an undeclared review operation");
        }
        assertUnique(summaryCase.selectedReviewOutcomes, "summary case outcomes");
      }
      if (
        operation.activation.anyOf.length !== 1 ||
        operation.activation.anyOf[0]?.condition !== "reviewSelectionTerminal"
      ) {
        reject("review summary has an invalid activation contract");
      }
    }
    if (operation.kind === "advisoryCheckCreate") {
      if (advisoryCreate !== undefined) reject("advisory check creation is duplicated");
      advisoryCreate = operation;
      if (operation.headSha !== plan.reviewedSnapshot.headSha) {
        reject("advisory check creation targets a different head");
      }
      if ((operation.reconciliation.markers ?? []).length !== 0) {
        reject("advisory check creation unexpectedly carries comment markers");
      }
      if (operation.reconciliation.observedRemoteId !== undefined) {
        reject("advisory check creation already carries a remote identity");
      }
      if (operation.reconciliation.logicalIdentity !== operation.externalId) {
        reject("advisory check creation has the wrong logical identity");
      }
      if (operation.externalId !== expectedAdvisoryExternalId(operation)) {
        reject("advisory check creation has the wrong external identity");
      }
      if (
        operation.dependencies.length !== 0 ||
        operation.activation.anyOf.length !== 1 ||
        operation.activation.anyOf[0]?.condition !== "always"
      ) {
        reject("advisory check creation has an invalid activation contract");
      }
    }
    if (operation.kind === "advisoryCheckComplete") {
      if (advisoryComplete !== undefined) reject("advisory check completion is duplicated");
      advisoryComplete = operation;
      aggregateTextBytes += Buffer.byteLength(operation.title, "utf8") +
        Buffer.byteLength(operation.summary, "utf8");
      if (operation.headSha !== plan.reviewedSnapshot.headSha) {
        reject("advisory check completion targets a different head");
      }
      if ((operation.reconciliation.markers ?? []).length !== 0) {
        reject("advisory check completion unexpectedly carries comment markers");
      }
      if (operation.reconciliation.observedRemoteId !== undefined) {
        reject("advisory completion already carries a remote identity");
      }
      if (operation.createdCheck.resultField !== "remoteId") {
        reject("advisory completion requests an unsupported creation result");
      }
      if (!operation.dependencies.includes(operation.createdCheck.dependencyOperationKey)) {
        reject("advisory completion does not depend on its check creation");
      }
      if (
        operation.activation.anyOf.length !== 1 ||
        operation.activation.anyOf[0]?.condition !== "always"
      ) {
        reject("advisory check has an invalid activation contract");
      }
      for (const annotation of operation.annotations ?? []) {
        aggregateTextBytes += Buffer.byteLength(annotation.title, "utf8") +
          Buffer.byteLength(annotation.message, "utf8");
        if (annotation.endLine < annotation.startLine) reject("check annotation range is reversed");
      }
    }
    validateActivationGuards(plan, operation, operationByKey);
    if (aggregateTextBytes > MAX_AGGREGATE_TEXT_BYTES) {
      reject("publication plan text is too large");
    }
  }
  if (advisoryCreate === undefined || advisoryComplete === undefined) {
    reject("plan must contain one advisory check creation and completion");
  }
  if (advisoryCreate.ordinal !== 1) {
    reject("advisory check creation is not the first operation");
  }
  if (advisoryComplete.ordinal !== plan.operations.length) {
    reject("advisory check completion is not the final operation");
  }
  if (advisoryComplete.createdCheck.dependencyOperationKey !== advisoryCreate.operationKey) {
    reject("advisory completion references a different creation operation");
  }
  if (advisoryCreate.detailsUrl !== advisoryComplete.detailsUrl) {
    reject("advisory check details URL changes between creation and completion");
  }
  {
    const summary = plan.operations.find((operation) => operation.kind === "reviewSummaryUpdate");
    const expectedDependencies = summary === undefined
      ? plan.operations.slice(0, -1).map((operation) => operation.operationKey)
      : [advisoryCreate.operationKey, summary.operationKey];
    if (!sameStrings(advisoryComplete.dependencies, expectedDependencies)) {
      reject("advisory completion does not seal every preceding mutation");
    }
  }
  validateReviewAttemptChain(plan);
}

function validateActivationGuards(
  plan: GitHubPublicationPlan,
  operation: GitHubPublicationOperation,
  operationByKey: ReadonlyMap<string, GitHubPublicationOperation>,
): void {
  const ownMarkers = operation.reconciliation.markers ?? [];
  for (const condition of operation.activation.anyOf) {
    const guard = condition.condition === "markerAbsent"
      ? condition.guard
      : condition.condition === "semanticPlacementRejected"
        ? condition.markerAbsence
        : condition.condition === "partialReviewObserved"
          ? condition.findingMarkerAbsence
          : undefined;
    if (guard !== undefined) {
      if (guard.headSha !== plan.reviewedSnapshot.headSha) {
        reject("marker-absence guard targets a different head");
      }
      if (!sameStrings(guard.markers, ownMarkers)) {
        reject("marker-absence guard differs from operation reconciliation markers");
      }
    }
    if (condition.condition === "partialReviewObserved") {
      const dependency = operationByKey.get(condition.dependencyOperationKey);
      if (
        dependency?.kind !== "reviewCreate" ||
        !sameStrings(condition.reviewMarkers, dependency.reconciliation.markers ?? [])
      ) {
        reject("partial-review guard differs from its review dependency markers");
      }
    }
  }
}

function validateReviewAttemptChain(plan: GitHubPublicationPlan): void {
  const reviews = plan.operations.filter((operation) => operation.kind === "reviewCreate");
  const byAttempt = new Map(reviews.map((operation) => [operation.attempt, operation]));
  const initial = byAttempt.get("initial");
  const relocated = byAttempt.get("relocatedInline");
  const summary = byAttempt.get("summaryOnly");
  if ((relocated !== undefined || summary !== undefined) && initial === undefined) {
    reject("fallback review exists without an initial review attempt");
  }
  if (relocated !== undefined && !sameStrings(relocated.dependencies, [initial!.operationKey])) {
    reject("relocated review does not depend exactly on the initial review");
  }
  if (summary !== undefined) {
    if (relocated === undefined || !sameStrings(summary.dependencies, [relocated.operationKey])) {
      reject("summary-only review does not depend exactly on the relocated review");
    }
  }
}

function validateDigests(plan: GitHubPublicationPlan): void {
  const lifecycle = plan.lifecycleReceipt;
  const lifecycleCanonical = {
    version: lifecycle.version,
    inputIdentity: lifecycle.inputIdentity,
    channel: lifecycle.channel,
    receiptId: lifecycle.receiptId,
    compatibleReceiptIds: lifecycle.compatibleReceiptIds ?? [],
    observedReviewId: lifecycle.observedReviewId ?? null,
    duplicateOfBaseline: lifecycle.duplicateOfBaseline,
    findings: lifecycle.findings,
  };
  if (lifecycle.digest !== jsonDigest(lifecycleCanonical)) {
    reject("lifecycle receipt digest does not match its canonical content");
  }
  for (const operation of plan.operations) {
    if (operation.desiredDigest !== jsonDigest(operationDesired(operation))) {
      reject("operation desired digest does not match its canonical mutation");
    }
  }
  if (plan.operationManifestDigest !== jsonDigest(plan.operations)) {
    reject("operation manifest digest does not match its canonical operations");
  }
  const { intentDigest: _, ...canonicalIntent } = plan;
  if (plan.intentDigest !== jsonDigest(canonicalIntent)) {
    reject("intent digest does not match the canonical publication plan");
  }
}

function operationDesired(operation: GitHubPublicationOperation): Record<string, unknown> {
  const {
    ordinal: _,
    operationKey: __,
    dependencies: ___,
    activation: ____,
    reconciliation: _____,
    desiredDigest: ______,
    ...desired
  } = operation;
  return desired;
}

function activationReferences(
  condition: GitHubPublicationOperation["activation"]["anyOf"][number],
): readonly string[] {
  if (condition.condition === "semanticPlacementRejected" || condition.condition === "partialReviewObserved") {
    return [condition.dependencyOperationKey];
  }
  if (condition.condition === "reviewSelectionTerminal") return condition.selectedReviewOperationKeys;
  return [];
}

function computedOperationKey(
  plan: GitHubPublicationPlan,
  operation: GitHubPublicationOperation,
): string {
  const keyKind = {
    reviewCreate: {
      initial: "initial-review-create",
      relocatedInline: "relocated-review-create",
      summaryOnly: "summary-review-create",
    },
    fileCommentFallback: "file-comment-fallback",
    findingCommentUpdate: "finding-comment-update",
    reviewSummaryUpdate: "review-summary-update",
    advisoryCheckCreate: "advisory-check-create",
    advisoryCheckComplete: "advisory-check-complete",
  } as const;
  const kind = operation.kind === "reviewCreate"
    ? keyKind.reviewCreate[operation.attempt]
    : keyKind[operation.kind];
  const findingId = operation.kind === "fileCommentFallback" || operation.kind === "findingCommentUpdate"
    ? operation.findingId
    : undefined;
  const hash = createHash("sha256").update("github-publication-operation-v1\0");
  for (const value of [
    plan.repository.id,
    plan.pullRequestNumber,
    plan.reviewedSnapshot.headSha,
    plan.controllerGeneration,
    plan.inputIdentity,
    plan.reviewOutputDigest,
    kind,
  ]) hash.update(value).update("\0");
  if (findingId !== undefined) hash.update(findingId);
  return `github-publication-v1:${kind}:sha256:${hash.digest("hex")}`;
}

function reviewIdentity(plan: GitHubPublicationPlan): string {
  const hash = createHash("sha256").update("github-publication-logical-review-v1\0");
  for (const value of [
    plan.repository.id,
    plan.pullRequestNumber,
    plan.reviewedSnapshot.headSha,
    plan.controllerGeneration,
    plan.inputIdentity,
    plan.reviewOutputDigest,
  ]) hash.update(value).update("\0");
  return `github-publication-v1:review:sha256:${hash.digest("hex")}`;
}

function expectedAdvisoryExternalId(
  operation: Extract<GitHubPublicationOperation, { kind: "advisoryCheckCreate" }>,
): string {
  let runIdentity: string | undefined;
  if (operation.detailsUrl !== undefined) {
    const segments = new URL(operation.detailsUrl).pathname.split("/").filter(Boolean);
    const candidate = segments.at(-1);
    if (candidate !== undefined && /^[0-9A-Za-z_-]{1,80}$/.test(candidate)) {
      runIdentity = candidate;
    }
  }
  return runIdentity === undefined
    ? `postil:${operation.name}:${operation.headSha}`
    : `postil:${runIdentity}:${operation.name}:${operation.headSha}`;
}

function textDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function jsonDigest(value: unknown): string {
  return textDigest(JSON.stringify(value));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertUnique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) reject(`${name} contain duplicates`);
}

function assertUniqueSorted(values: readonly string[], name: string): void {
  assertUnique(values, name);
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) reject(`${name} are not strictly sorted`);
  }
}

function reject(reason: string): never {
  throw new GitHubPublicationPlanRejectedError(reason);
}
