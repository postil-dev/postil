import { createHash } from "node:crypto";

const MAX_OPERATIONS = 128;
const MAX_DEPENDENCY_EDGES = 1_024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_TITLE_BYTES = 255;
const MAX_SUMMARY_BYTES = 128 * 1024;
const MAX_URL_BYTES = 2_048;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DECIMAL_IDENTIFIER = /^[1-9][0-9]{0,18}$/;
const CLI_OPERATION_KEY = /^github-publication-v1:[a-z-]+:sha256:[0-9a-f]{64}$/;

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export interface AuthoritativeGateOutput {
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  detailsUrl: string;
}

export interface GitHubPublicationControllerManifestRequest {
  /** A plan already accepted by the strict no-write CLI plan parser. */
  acceptedPlan: unknown;
  /** Digest of the immutable exact plan bytes accepted from the CLI stdout pipe. */
  acceptedPlanBytesDigest: string;
  /** The service-only terminal operations that must settle before the gate completes. */
  requiredTerminalOperationKeys: readonly string[];
  /** Gate output produced by the service's authoritative policy evaluation. */
  gateOutput: AuthoritativeGateOutput;
}

export interface GateCheckCreateOperation extends JsonObject {
  ordinal: number;
  operationKey: string;
  dependencies: string[];
  activation: { anyOf: [{ condition: "always" }] };
  reconciliation: {
    logicalIdentity: string;
    exclusive: true;
  };
  desiredDigest: string;
  kind: "gateCheckCreate";
  payload: {
    name: "postil/gate";
    headSha: string;
    status: "in_progress";
    externalId: string;
    detailsUrl: string;
  };
}

export interface GateCheckCompleteOperation extends JsonObject {
  ordinal: number;
  operationKey: string;
  dependencies: string[];
  activation: { anyOf: [{ condition: "allDependenciesTerminal" }] };
  reconciliation: {
    logicalIdentity: string;
    exclusive: true;
    remoteId: {
      source: "operation";
      operationKey: string;
    };
  };
  desiredDigest: string;
  kind: "gateCheckComplete";
  remoteId: {
    source: "operation";
    operationKey: string;
  };
  payload: {
    name: "postil/gate";
    headSha: string;
    status: "completed";
    conclusion: "success" | "failure" | "neutral";
    title: string;
    summary: string;
    detailsUrl: string;
  };
}

export interface GitHubPublicationControllerOperationRecord extends JsonObject {
  source: "cli" | "service";
  operation: JsonObject | GateCheckCreateOperation | GateCheckCompleteOperation;
}

export interface GitHubPublicationControllerManifest extends JsonObject {
  version: "github-publication-controller-v1";
  forge: "github";
  controllerGeneration: string;
  inputIdentity: string;
  reviewOutputDigest: string;
  repository: {
    id: string;
    fullName: string;
  };
  pullRequestNumber: string;
  headSha: string;
  acceptedPlanIntentDigest: string;
  acceptedPlanOperationManifestDigest: string;
  acceptedPlanBytesDigest: string;
  acceptedCliOperationCount: number;
  operationCount: number;
  operationManifestDigest: string;
  operations: GitHubPublicationControllerOperationRecord[];
}

export interface BuiltGitHubPublicationControllerManifest {
  bytes: Uint8Array;
  value: GitHubPublicationControllerManifest;
  /** Exact canonical bytes for each `value.operations` record. */
  operationBytes: Uint8Array[];
  /** SHA-256 of the exact returned UTF-8 manifest bytes. */
  digest: string;
}

export class GitHubPublicationControllerManifestRejectedError extends Error {
  override name = "GitHubPublicationControllerManifestRejectedError";

  constructor(reason: string) {
    super(`GitHub publication controller manifest rejected: ${reason}`);
  }
}

/**
 * Seal immutable CLI operations together with service-owned gate mutations.
 *
 * The returned digest covers the exact returned UTF-8 bytes. A digest cannot be
 * embedded in the bytes it hashes without a circular value, so it is returned
 * alongside the manifest rather than written into it.
 */
export function buildGitHubPublicationControllerManifest(
  request: GitHubPublicationControllerManifestRequest,
): BuiltGitHubPublicationControllerManifest {
  const plan = validateAcceptedPlan(request.acceptedPlan);
  const acceptedPlanBytesDigest = requireDigest(
    request.acceptedPlanBytesDigest,
    "accepted plan byte digest",
  );
  const gateOutput = validateGateOutput(request.gateOutput);
  const requiredTerminalOperationKeys = validateRequiredTerminalOperationKeys(
    request.requiredTerminalOperationKeys,
    plan.operations,
  );

  const gateOutputDigest = digestCanonical({
    conclusion: gateOutput.conclusion,
    title: gateOutput.title,
    summary: gateOutput.summary,
    detailsUrl: gateOutput.detailsUrl,
  });
  const gateCreateKey = serviceGateOperationKey(plan, "gate-create", gateOutputDigest);
  const gateCompleteKey = serviceGateOperationKey(plan, "gate-complete", gateOutputDigest);
  const gateExternalId = serviceGateExternalId(plan, gateOutputDigest);

  if (new Set(plan.operations.map((operation) => operation.operationKey)).has(gateCreateKey)) {
    reject("service gate create key collides with an accepted CLI operation");
  }
  if (new Set(plan.operations.map((operation) => operation.operationKey)).has(gateCompleteKey)) {
    reject("service gate completion key collides with an accepted CLI operation");
  }

  const cliOperations = plan.operations.map((operation, index) => ({
    ...cloneJsonObject(operation),
    ordinal: index + 1,
  }));
  const gateCreate = buildGateCreateOperation({
    ordinal: cliOperations.length + 1,
    operationKey: gateCreateKey,
    externalId: gateExternalId,
    headSha: plan.headSha,
    detailsUrl: gateOutput.detailsUrl,
  });
  const gateComplete = buildGateCompleteOperation({
    ordinal: cliOperations.length + 2,
    operationKey: gateCompleteKey,
    createOperationKey: gateCreateKey,
    externalId: gateExternalId,
    headSha: plan.headSha,
    requiredTerminalOperationKeys,
    gateOutput,
  });
  const operations: GitHubPublicationControllerOperationRecord[] = [
    ...cliOperations.map((operation) => ({ source: "cli" as const, operation })),
    { source: "service", operation: gateCreate },
    { source: "service", operation: gateComplete },
  ];

  if (operations.length > MAX_OPERATIONS) reject("controller manifest exceeds the operation limit");
  validateControllerOperationGraph(operations);

  const value: GitHubPublicationControllerManifest = {
    version: "github-publication-controller-v1",
    forge: "github",
    controllerGeneration: plan.controllerGeneration,
    inputIdentity: plan.inputIdentity,
    reviewOutputDigest: plan.reviewOutputDigest,
    repository: {
      id: plan.repositoryId,
      fullName: plan.repositoryFullName,
    },
    pullRequestNumber: plan.pullRequestNumber,
    headSha: plan.headSha,
    acceptedPlanIntentDigest: plan.intentDigest,
    acceptedPlanOperationManifestDigest: plan.operationManifestDigest,
    acceptedPlanBytesDigest,
    acceptedCliOperationCount: plan.operations.length,
    operationCount: operations.length,
    operationManifestDigest: digestCanonical(operations),
    operations,
  };
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.byteLength > MAX_MANIFEST_BYTES) reject("controller manifest exceeds the byte limit");
  const operationBytes = operations.map((operation) =>
    Buffer.from(canonicalJson(operation), "utf8")
  );
  return { bytes, value, operationBytes, digest: digestBytes(bytes) };
}

interface ValidatedAcceptedPlan {
  controllerGeneration: string;
  inputIdentity: string;
  reviewOutputDigest: string;
  repositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: string;
  headSha: string;
  operations: JsonObject[];
  operationManifestDigest: string;
  intentDigest: string;
}

function validateAcceptedPlan(value: unknown): ValidatedAcceptedPlan {
  const plan = requireObject(value, "accepted plan");
  requireExactKeys(plan, [
    "version",
    "forge",
    "controllerGeneration",
    "inputIdentity",
    "reviewOutputDigest",
    "repository",
    "pullRequestNumber",
    "reviewedSnapshot",
    "lifecycleReceipt",
    "operationCount",
    "operationManifestDigest",
    "operations",
    "gateAnalysis",
    "intentDigest",
  ], "accepted plan");
  if (plan.version !== 1 || plan.forge !== "github") reject("accepted plan has an unsupported version or forge");
  const controllerGeneration = requireDecimal(plan.controllerGeneration, "controller generation");
  const inputIdentity = requireDigest(plan.inputIdentity, "input identity");
  const reviewOutputDigest = requireDigest(plan.reviewOutputDigest, "review output digest");
  const repository = requireObject(plan.repository, "repository");
  requireExactKeys(repository, ["id", "fullName"], "repository");
  const repositoryId = requireDecimal(repository.id, "repository id");
  const repositoryFullName = requireRepositoryFullName(repository.fullName);
  const pullRequestNumber = requireDecimal(plan.pullRequestNumber, "pull request number");
  const snapshot = requireObject(plan.reviewedSnapshot, "reviewed snapshot");
  requireExactKeys(snapshot, [
    "headSha",
    "mergeBaseSha",
    "targetSha",
    "pullRequestTitleSha256",
    "pullRequestBodySha256",
  ], "reviewed snapshot");
  const headSha = requireGitSha(snapshot.headSha, "head SHA");
  requireGitSha(snapshot.mergeBaseSha, "merge-base SHA");
  requireGitSha(snapshot.targetSha, "target SHA");
  requireDigest(snapshot.pullRequestTitleSha256, "pull request title digest");
  requireDigest(snapshot.pullRequestBodySha256, "pull request body digest");
  const operations = requireJsonObjectArray(plan.operations, "accepted CLI operations");
  if (!Number.isSafeInteger(plan.operationCount) || plan.operationCount !== operations.length) {
    reject("accepted CLI operation count does not match operations");
  }
  if (operations.length > MAX_OPERATIONS - 2) reject("accepted CLI operations leave no space for the service gate");
  const operationManifestDigest = requireDigest(plan.operationManifestDigest, "accepted CLI operation manifest digest");
  if (operationManifestDigest !== digestJson(operations)) {
    reject("accepted CLI operation manifest digest does not match operations");
  }
  validateAcceptedOperationGraph(operations);
  validateCliGateAnalysis(plan.gateAnalysis, headSha);
  const intentDigest = requireDigest(plan.intentDigest, "accepted plan intent digest");
  const { intentDigest: _intentDigest, ...unsignedPlan } = plan;
  if (intentDigest !== digestJson(unsignedPlan)) reject("accepted plan intent digest does not match the plan");
  return {
    controllerGeneration,
    inputIdentity,
    reviewOutputDigest,
    repositoryId,
    repositoryFullName,
    pullRequestNumber,
    headSha,
    operations,
    operationManifestDigest,
    intentDigest,
  };
}

function validateCliGateAnalysis(value: unknown, headSha: string): void {
  const gateAnalysis = requireObject(value, "CLI gate analysis");
  requireAllowedKeys(gateAnalysis, [
    "ownership",
    "authoritative",
    "organizationGateModeRequired",
    "name",
    "headSha",
    "analyzedConclusion",
    "title",
    "summary",
    "detailsUrl",
  ], "CLI gate analysis");
  if (
    gateAnalysis.ownership !== "service" ||
    gateAnalysis.authoritative !== false ||
    gateAnalysis.organizationGateModeRequired !== true ||
    gateAnalysis.name !== "postil/gate" ||
    gateAnalysis.headSha !== headSha
  ) {
    reject("CLI gate analysis is not the required non-authoritative service declaration");
  }
  if (
    gateAnalysis.analyzedConclusion !== "success" &&
    gateAnalysis.analyzedConclusion !== "failure" &&
    gateAnalysis.analyzedConclusion !== "neutral"
  ) {
    reject("CLI gate analysis conclusion is invalid");
  }
  requireBoundedString(gateAnalysis.title, "CLI gate analysis title", MAX_TITLE_BYTES);
  requireBoundedString(gateAnalysis.summary, "CLI gate analysis summary", MAX_SUMMARY_BYTES);
  if (gateAnalysis.detailsUrl !== undefined) requireHttpUrl(gateAnalysis.detailsUrl, "CLI gate analysis details URL");
}

function validateAcceptedOperationGraph(operations: readonly JsonObject[]): void {
  const ordinalByKey = new Map<string, number>();
  let dependencyEdges = 0;
  for (const [index, operation] of operations.entries()) {
    const key = requireCliOperationKey(operation.operationKey, "accepted CLI operation key");
    if (ordinalByKey.has(key)) reject("accepted CLI operation key is duplicated");
    if (operation.ordinal !== index + 1) reject("accepted CLI operation ordinals are not contiguous");
    if (typeof operation.kind !== "string" || operation.kind.length === 0) reject("accepted CLI operation kind is malformed");
    if (targetsGate(operation)) reject("accepted CLI operation attempts to publish the service gate");
    requireDigest(operation.desiredDigest, "accepted CLI operation desired digest");
    ordinalByKey.set(key, index + 1);
  }
  for (const operation of operations) {
    const dependencies = requireStringArray(operation.dependencies, "accepted CLI operation dependencies");
    dependencyEdges += dependencies.length;
    if (dependencyEdges > MAX_DEPENDENCY_EDGES) reject("accepted CLI operation dependency graph is too large");
    if (new Set(dependencies).size !== dependencies.length) reject("accepted CLI operation dependencies contain duplicates");
    const ordinal = Number(operation.ordinal);
    for (const dependency of dependencies) {
      const dependencyOrdinal = ordinalByKey.get(dependency);
      if (dependencyOrdinal === undefined || dependencyOrdinal >= ordinal) {
        reject("accepted CLI operation dependency is missing, forward, or self-referential");
      }
    }
  }
}

function validateRequiredTerminalOperationKeys(
  value: readonly string[],
  operations: readonly JsonObject[],
): string[] {
  if (!Array.isArray(value)) reject("required terminal operation keys are malformed");
  const acceptedKeys = new Set(operations.map((operation) => String(operation.operationKey)));
  const keys = value.map((key) => requireCliOperationKey(key, "required terminal operation key"));
  if (new Set(keys).size !== keys.length) reject("required terminal operation keys contain duplicates");
  for (const key of keys) {
    if (!acceptedKeys.has(key)) reject("required terminal operation key is absent from the accepted plan");
  }
  const dependenciesByKey = new Map(
    operations.map((operation) => [
      String(operation.operationKey),
      requireStringArray(operation.dependencies, "accepted CLI operation dependencies"),
    ]),
  );
  const covered = new Set<string>();
  const pending = [...keys];
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (covered.has(key)) continue;
    covered.add(key);
    pending.push(...(dependenciesByKey.get(key) ?? []));
  }
  if (covered.size !== operations.length) {
    reject("required terminal operation keys do not transitively seal every accepted CLI operation");
  }
  return keys;
}

function validateGateOutput(value: AuthoritativeGateOutput): AuthoritativeGateOutput {
  const output = requireObject(value, "authoritative gate output");
  requireExactKeys(output, ["conclusion", "title", "summary", "detailsUrl"], "authoritative gate output");
  if (output.conclusion !== "success" && output.conclusion !== "failure" && output.conclusion !== "neutral") {
    reject("authoritative gate conclusion is invalid");
  }
  return {
    conclusion: output.conclusion,
    title: requireBoundedString(output.title, "authoritative gate title", MAX_TITLE_BYTES),
    summary: requireBoundedString(output.summary, "authoritative gate summary", MAX_SUMMARY_BYTES),
    detailsUrl: requireHttpUrl(output.detailsUrl, "authoritative gate details URL"),
  };
}

function buildGateCreateOperation(input: {
  ordinal: number;
  operationKey: string;
  externalId: string;
  headSha: string;
  detailsUrl: string;
}): GateCheckCreateOperation {
  const operation = {
    ordinal: input.ordinal,
    operationKey: input.operationKey,
    dependencies: [],
    activation: { anyOf: [{ condition: "always" as const }] as [{ condition: "always" }] },
    reconciliation: { logicalIdentity: input.externalId, exclusive: true as const },
    desiredDigest: "",
    kind: "gateCheckCreate" as const,
    payload: {
      name: "postil/gate" as const,
      headSha: input.headSha,
      status: "in_progress" as const,
      externalId: input.externalId,
      detailsUrl: input.detailsUrl,
    },
  };
  operation.desiredDigest = digestJson(operationDesired(operation));
  return operation;
}

function buildGateCompleteOperation(input: {
  ordinal: number;
  operationKey: string;
  createOperationKey: string;
  externalId: string;
  headSha: string;
  requiredTerminalOperationKeys: string[];
  gateOutput: AuthoritativeGateOutput;
}): GateCheckCompleteOperation {
  const remoteId = { source: "operation" as const, operationKey: input.createOperationKey };
  const operation = {
    ordinal: input.ordinal,
    operationKey: input.operationKey,
    dependencies: [input.createOperationKey, ...input.requiredTerminalOperationKeys],
    activation: {
      anyOf: [{ condition: "allDependenciesTerminal" as const }] as [{ condition: "allDependenciesTerminal" }],
    },
    reconciliation: {
      logicalIdentity: input.externalId,
      exclusive: true as const,
      remoteId,
    },
    desiredDigest: "",
    kind: "gateCheckComplete" as const,
    remoteId,
    payload: {
      name: "postil/gate" as const,
      headSha: input.headSha,
      status: "completed" as const,
      conclusion: input.gateOutput.conclusion,
      title: input.gateOutput.title,
      summary: input.gateOutput.summary,
      detailsUrl: input.gateOutput.detailsUrl,
    },
  };
  operation.desiredDigest = digestJson(operationDesired(operation));
  return operation;
}

function validateControllerOperationGraph(
  records: readonly GitHubPublicationControllerOperationRecord[],
): void {
  let dependencyEdges = 0;
  const ordinalByKey = new Map<string, number>();
  for (const [index, record] of records.entries()) {
    if (
      (index < records.length - 2 && record.source !== "cli") ||
      (index >= records.length - 2 && record.source !== "service")
    ) {
      reject("controller operation sources are not ordered");
    }
    const operation = record.operation;
    const key = requireString(operation.operationKey, "controller operation key");
    if (ordinalByKey.has(key)) reject("controller operation key is duplicated");
    if (operation.ordinal !== index + 1) reject("controller operation ordinals are not contiguous");
    ordinalByKey.set(key, index + 1);
  }
  for (const { operation } of records) {
    const dependencies = requireStringArray(operation.dependencies, "controller operation dependencies");
    dependencyEdges += dependencies.length;
    if (dependencyEdges > MAX_DEPENDENCY_EDGES) reject("controller manifest dependency graph is too large");
    if (new Set(dependencies).size !== dependencies.length) reject("controller operation dependencies contain duplicates");
    for (const dependency of dependencies) {
      const dependencyOrdinal = ordinalByKey.get(dependency);
      if (dependencyOrdinal === undefined || dependencyOrdinal >= Number(operation.ordinal)) {
        reject("controller operation dependency is missing, forward, or self-referential");
      }
    }
  }
}

function serviceGateOperationKey(
  plan: ValidatedAcceptedPlan,
  actionKind: "gate-create" | "gate-complete",
  gateOutputDigest: string,
): string {
  const hash = createHash("sha256").update("github-publication-controller-gate-operation-v1\0");
  for (const value of [
    plan.repositoryId,
    plan.pullRequestNumber,
    plan.headSha,
    plan.controllerGeneration,
    plan.inputIdentity,
    plan.reviewOutputDigest,
    actionKind,
    gateOutputDigest,
  ]) hash.update(value).update("\0");
  return `github-publication-controller-v1:${actionKind}:sha256:${hash.digest("hex")}`;
}

function serviceGateExternalId(plan: ValidatedAcceptedPlan, gateOutputDigest: string): string {
  const hash = createHash("sha256").update("github-publication-controller-gate-external-id-v1\0");
  for (const value of [
    plan.repositoryId,
    plan.pullRequestNumber,
    plan.headSha,
    plan.controllerGeneration,
    plan.inputIdentity,
    plan.reviewOutputDigest,
    gateOutputDigest,
  ]) hash.update(value).update("\0");
  return `postil-gate-v1:${hash.digest("hex")}`;
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

function targetsGate(operation: JsonObject): boolean {
  const kind = typeof operation.kind === "string" ? operation.kind.toLowerCase() : "";
  const name = typeof operation.name === "string" ? operation.name : "";
  const payload = isJsonObject(operation.payload) ? operation.payload : undefined;
  return kind.includes("gate") || name === "postil/gate" || payload?.name === "postil/gate";
}

function requireObject(value: unknown, name: string): JsonObject {
  if (!isJsonObject(value)) reject(`${name} must be a plain JSON object`);
  return value;
}

function requireExactKeys(value: JsonObject, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject(`${name} has unknown, missing, or malformed fields`);
  }
}

function requireAllowedKeys(value: JsonObject, keys: readonly string[], name: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) reject(`${name} has unknown fields`);
}

function requireJsonObjectArray(value: unknown, name: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((entry) => !isJsonObject(entry))) reject(`${name} must be a JSON-object array`);
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) reject(`${name} must be a string array`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") reject(`${name} must be a string`);
  return value;
}

function requireDecimal(value: unknown, name: string): string {
  const decimal = requireString(value, name);
  if (!DECIMAL_IDENTIFIER.test(decimal) || BigInt(decimal) > 9_223_372_036_854_775_807n) {
    reject(`${name} is not a signed 64-bit decimal identifier`);
  }
  return decimal;
}

function requireDigest(value: unknown, name: string): string {
  const digest = requireString(value, name);
  if (!SHA256.test(digest)) reject(`${name} is not a lowercase SHA-256 digest`);
  return digest;
}

function requireCliOperationKey(value: unknown, name: string): string {
  const key = requireString(value, name);
  if (!CLI_OPERATION_KEY.test(key)) reject(`${name} is malformed`);
  return key;
}

function requireGitSha(value: unknown, name: string): string {
  const sha = requireString(value, name);
  if (!GIT_SHA.test(sha)) reject(`${name} is not a lowercase Git SHA`);
  return sha;
}

function requireRepositoryFullName(value: unknown): string {
  const fullName = requireString(value, "repository full name");
  if (!/^[^/\s]{1,100}\/[^/\s]{1,100}$/.test(fullName)) reject("repository full name is malformed");
  return fullName;
}

function requireBoundedString(value: unknown, name: string, maximumBytes: number): string {
  const text = requireString(value, name);
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > maximumBytes) reject(`${name} exceeds its byte limit`);
  return text;
}

function requireHttpUrl(value: unknown, name: string): string {
  const url = requireBoundedString(value, name, MAX_URL_BYTES);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported protocol");
  } catch {
    reject(`${name} is not an HTTP URL`);
  }
  return url;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(canonicalJson(value)) as JsonObject;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("manifest contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!isJsonObject(value)) reject("manifest contains a non-JSON value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function digestCanonical(value: JsonValue): string {
  return digestBytes(Buffer.from(canonicalJson(value), "utf8"));
}

function digestJson(value: unknown): string {
  try {
    return digestBytes(Buffer.from(JSON.stringify(value), "utf8"));
  } catch {
    reject("accepted plan is not JSON serializable");
  }
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function reject(reason: string): never {
  throw new GitHubPublicationControllerManifestRejectedError(reason);
}
