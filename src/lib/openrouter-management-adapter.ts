export const OPENROUTER_PROVIDER_BINDING = Object.freeze({
  provider: "openrouter",
  apiBase: "https://openrouter.ai/api/v1",
} as const);

/**
 * Postil's persisted provider-name bound. OpenRouter documents only a nonempty
 * name. Persistence schemas and lifecycle callers can import this bound to
 * apply the same validation.
 */
export const OPENROUTER_KEY_NAME_MAX_LENGTH = 160;

export type OpenRouterProviderBinding = typeof OPENROUTER_PROVIDER_BINDING;

export interface OpenRouterManagementRequest {
  readonly binding: OpenRouterProviderBinding;
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly redirect: "error";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

/**
 * A transport must reject redirects, preserve the final response URL, honor
 * the abort signal, and settle after abort. The adapter waits for transport
 * and response-body termination before returning a timeout result.
 */
export type OpenRouterManagementTransport = (
  request: OpenRouterManagementRequest,
) => Promise<Response>;

export interface OpenRouterManagedKey {
  readonly hash: string;
  readonly name: string;
  readonly disabled: boolean;
}

/**
 * The response API encodes limits as JSON numbers. Keeping the integer micros
 * below 2^51 leaves enough IEEE-754 precision for decimal parsing and the
 * multiplication back to micros to round to the exact original integer.
 */
export const OPENROUTER_EXACT_LIMIT_MAX_MICROS = (1n << 51n) - 1n;

declare const exactOpenRouterLimitMicrosBrand: unique symbol;

/**
 * A validated nonnegative USD-micros bigint. This constructor validates the
 * represented value, not the provenance of a caller's earlier calculations.
 */
export type ExactOpenRouterLimitMicros = bigint & {
  readonly [exactOpenRouterLimitMicrosBrand]: true;
};

export function exactOpenRouterLimitMicros(
  value: bigint,
): ExactOpenRouterLimitMicros {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > OPENROUTER_EXACT_LIMIT_MAX_MICROS
  ) {
    throw new Error(
      `OpenRouter key limit must be a nonnegative bigint no greater than ${OPENROUTER_EXACT_LIMIT_MAX_MICROS} USD micros`,
    );
  }
  return value as ExactOpenRouterLimitMicros;
}

export type OpenRouterExactNameLookup =
  | {
      readonly status: "none";
      readonly binding: OpenRouterProviderBinding;
      readonly name: string;
      readonly matches: readonly [];
    }
  | {
      readonly status: "one";
      readonly binding: OpenRouterProviderBinding;
      readonly name: string;
      readonly matches: readonly [OpenRouterManagedKey];
    }
  | {
      readonly status: "multiple";
      readonly binding: OpenRouterProviderBinding;
      readonly name: string;
      readonly matches: readonly OpenRouterManagedKey[];
    };

export type OpenRouterExactHashLookup =
  | {
      readonly status: "absent";
      readonly binding: OpenRouterProviderBinding;
      readonly hash: string;
      readonly key: null;
    }
  | {
      readonly status: "present";
      readonly binding: OpenRouterProviderBinding;
      readonly hash: string;
      readonly key: OpenRouterManagedKey;
    };

export type OpenRouterCreateKeyResult =
  | {
      readonly status: "created";
      readonly binding: OpenRouterProviderBinding;
      readonly key: OpenRouterManagedKey;
      readonly runtimeKey: string;
      readonly limitMicros: ExactOpenRouterLimitMicros;
      readonly expiresAt: string;
    }
  | {
      readonly status: "rejected";
      readonly binding: OpenRouterProviderBinding;
      readonly httpStatus: number;
    }
  | {
      readonly status: "ambiguous";
      readonly binding: OpenRouterProviderBinding;
      readonly reason: MutationAmbiguityReason;
      readonly httpStatus?: number;
    };

export type OpenRouterDisableKeyResult =
  | {
      readonly status: "disabled";
      readonly binding: OpenRouterProviderBinding;
      readonly key: OpenRouterManagedKey;
    }
  | {
      readonly status: "rejected";
      readonly binding: OpenRouterProviderBinding;
      readonly httpStatus: number;
    }
  | {
      readonly status: "ambiguous";
      readonly binding: OpenRouterProviderBinding;
      readonly reason: MutationAmbiguityReason;
      readonly httpStatus?: number;
    };

export interface OpenRouterManagementAdapter {
  readonly binding: OpenRouterProviderBinding;
  findKeysByExactName(name: string): Promise<OpenRouterExactNameLookup>;
  findKeyByHash(hash: string): Promise<OpenRouterExactHashLookup>;
  /** POST only after the lifecycle store has durably authorized this intent. */
  createKeyAfterPersistedIntent(input: {
    readonly intentId: string;
    readonly name: string;
    readonly limitMicros: ExactOpenRouterLimitMicros;
    readonly expiresAt: Date;
  }): Promise<OpenRouterCreateKeyResult>;
  disableKey(hash: string): Promise<OpenRouterDisableKeyResult>;
}

export class OpenRouterManagementAdapterError extends Error {
  constructor(
    readonly code:
      | "http"
      | "invalid-response"
      | "pagination-bound"
      | "response-too-large"
      | "timeout"
      | "transport",
    message: string,
  ) {
    super(message);
    this.name = "OpenRouterManagementAdapterError";
  }
}

interface AdapterLimits {
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly pageSize: number;
  readonly maxPages: number;
}

interface CreateAdapterInput {
  readonly managementCredential: string;
  readonly transport: OpenRouterManagementTransport;
  readonly limits?: Partial<AdapterLimits>;
}

type MutationAmbiguityReason =
  | "invalid-response"
  | "response-too-large"
  | "timeout"
  | "transport"
  | "unexpected-status";

type WireResult =
  | {
      readonly status: "received";
      readonly httpStatus: number;
      readonly body: string;
    }
  | {
      readonly status:
        | "invalid-response"
        | "response-too-large"
        | "timeout"
        | "transport";
    };

const DEFAULT_LIMITS: AdapterLimits = Object.freeze({
  requestTimeoutMs: 8_000,
  maxResponseBytes: 1024 * 1024,
  pageSize: 100,
  maxPages: 100,
});

const HARD_LIMITS: AdapterLimits = Object.freeze({
  requestTimeoutMs: 60_000,
  maxResponseBytes: 8 * 1024 * 1024,
  pageSize: 100,
  maxPages: 100,
});

const MAX_OPAQUE_IDENTIFIER_LENGTH = 512;
const MICROS_PER_DOLLAR = 1_000_000n;

export function createOpenRouterManagementAdapter(
  input: CreateAdapterInput,
): OpenRouterManagementAdapter {
  validateCredential(input.managementCredential);
  if (typeof input.transport !== "function") {
    throw new Error("OpenRouter management transport is required");
  }
  const limits = resolveLimits(input.limits);

  return Object.freeze({
    binding: OPENROUTER_PROVIDER_BINDING,
    findKeysByExactName: (name: string) =>
      findKeysByExactName(input, limits, name),
    findKeyByHash: (hash: string) => findKeyByHash(input, limits, hash),
    createKeyAfterPersistedIntent: (createInput: {
      readonly intentId: string;
      readonly name: string;
      readonly limitMicros: ExactOpenRouterLimitMicros;
      readonly expiresAt: Date;
    }) => createKey(input, limits, createInput),
    disableKey: (hash: string) => disableKey(input, limits, hash),
  });
}

async function findKeysByExactName(
  input: CreateAdapterInput,
  limits: AdapterLimits,
  name: string,
): Promise<OpenRouterExactNameLookup> {
  validateOpaqueName(name);
  const keys = await listManagedKeys(input, limits);
  return exactNameLookup(
    name,
    keys.filter((key) => key.name === name),
  );
}

async function findKeyByHash(
  input: CreateAdapterInput,
  limits: AdapterLimits,
  hash: string,
): Promise<OpenRouterExactHashLookup> {
  validateOpaqueIdentifier(hash, "OpenRouter key hash");
  const key = (await listManagedKeys(input, limits)).find(
    (candidate) => candidate.hash === hash,
  );
  return key
    ? { status: "present", binding: OPENROUTER_PROVIDER_BINDING, hash, key }
    : {
        status: "absent",
        binding: OPENROUTER_PROVIDER_BINDING,
        hash,
        key: null,
      };
}

async function listManagedKeys(
  input: CreateAdapterInput,
  limits: AdapterLimits,
): Promise<OpenRouterManagedKey[]> {
  const keys: OpenRouterManagedKey[] = [];
  const observedHashes = new Set<string>();

  for (let page = 0; page < limits.maxPages; page += 1) {
    const url = new URL(providerUrl("keys"));
    url.searchParams.set("include_disabled", "true");
    url.searchParams.set("offset", String(page * limits.pageSize));
    const result = await sendManagementRequest(input, limits, {
      method: "GET",
      url: url.toString(),
    });
    const body = receivedBodyOrThrow(result, "list keys");
    if (result.status !== "received" || result.httpStatus !== 200) {
      throw new OpenRouterManagementAdapterError(
        "http",
        `OpenRouter list keys returned HTTP ${
          result.status === "received" ? result.httpStatus : "unknown"
        }`,
      );
    }
    const pageKeys = parseListResponse(body);
    if (pageKeys.length > limits.pageSize) {
      throw new OpenRouterManagementAdapterError(
        "invalid-response",
        "OpenRouter list keys returned more records than the bounded page size",
      );
    }
    for (const key of pageKeys) {
      if (observedHashes.has(key.hash)) {
        throw new OpenRouterManagementAdapterError(
          "invalid-response",
          "OpenRouter list keys repeated an exact key hash across pages",
        );
      }
      observedHashes.add(key.hash);
      keys.push(key);
    }
    if (pageKeys.length < limits.pageSize) {
      return keys;
    }
  }

  throw new OpenRouterManagementAdapterError(
    "pagination-bound",
    "OpenRouter list keys exceeded the bounded page count",
  );
}

async function createKey(
  input: CreateAdapterInput,
  limits: AdapterLimits,
  createInput: {
    readonly intentId: string;
    readonly name: string;
    readonly limitMicros: ExactOpenRouterLimitMicros;
    readonly expiresAt: Date;
  },
): Promise<OpenRouterCreateKeyResult> {
  validateIntentId(createInput.intentId);
  validateOpaqueName(createInput.name);
  const expiresAt = validateExpiration(createInput.expiresAt);
  const limit = microsToUsdJsonNumber(createInput.limitMicros);
  const body = `{"name":${JSON.stringify(createInput.name)},"limit":${limit},"limit_reset":null,"expires_at":${JSON.stringify(expiresAt)}}`;
  const result = await sendManagementRequest(input, limits, {
    method: "POST",
    url: providerUrl("keys"),
    body,
  });
  if (result.status !== "received") {
    return ambiguousMutation(result.status);
  }
  if (isDocumentedRejectionStatus("create", result.httpStatus)) {
    return {
      status: "rejected",
      binding: OPENROUTER_PROVIDER_BINDING,
      httpStatus: result.httpStatus,
    };
  }
  if (result.httpStatus !== 201) {
    return ambiguousMutation("unexpected-status", result.httpStatus);
  }

  let parsed: { key: OpenRouterManagedKey; runtimeKey: string };
  try {
    parsed = parseCreateResponse(
      result.body,
      createInput.name,
      createInput.limitMicros,
      expiresAt,
    );
  } catch {
    return ambiguousMutation("invalid-response", result.httpStatus);
  }
  return {
    status: "created",
    binding: OPENROUTER_PROVIDER_BINDING,
    key: parsed.key,
    runtimeKey: parsed.runtimeKey,
    limitMicros: createInput.limitMicros,
    expiresAt,
  };
}

async function disableKey(
  input: CreateAdapterInput,
  limits: AdapterLimits,
  hash: string,
): Promise<OpenRouterDisableKeyResult> {
  validateOpaqueIdentifier(hash, "OpenRouter key hash");
  const result = await sendManagementRequest(input, limits, {
    method: "PATCH",
    url: providerUrl(`keys/${encodeURIComponent(hash)}`),
    body: '{"disabled":true}',
  });
  if (result.status !== "received") {
    return ambiguousMutation(result.status);
  }
  if (isDocumentedRejectionStatus("disable", result.httpStatus)) {
    return {
      status: "rejected",
      binding: OPENROUTER_PROVIDER_BINDING,
      httpStatus: result.httpStatus,
    };
  }
  if (result.httpStatus !== 200) {
    return ambiguousMutation("unexpected-status", result.httpStatus);
  }

  let key: OpenRouterManagedKey;
  try {
    const value = parseJsonObject(result.body);
    key = parseManagedKey(value.data);
    if (key.hash !== hash || !key.disabled) {
      throw new Error("OpenRouter disable response did not bind the exact key hash");
    }
  } catch {
    return ambiguousMutation("invalid-response", result.httpStatus);
  }
  return {
    status: "disabled",
    binding: OPENROUTER_PROVIDER_BINDING,
    key,
  };
}

async function sendManagementRequest(
  input: CreateAdapterInput,
  limits: AdapterLimits,
  request: {
    readonly method: OpenRouterManagementRequest["method"];
    readonly url: string;
    readonly body?: string;
  },
): Promise<WireResult> {
  assertBoundProviderUrl(request.url);
  const controller = new AbortController();
  const operation = (async (): Promise<WireResult> => {
    let response: Response;
    try {
      response = await input.transport(
        Object.freeze({
          binding: OPENROUTER_PROVIDER_BINDING,
          method: request.method,
          url: request.url,
          redirect: "error",
          headers: Object.freeze({
            authorization: `Bearer ${input.managementCredential}`,
            accept: "application/json",
            ...(request.body ? { "content-type": "application/json" } : {}),
          }),
          ...(request.body ? { body: request.body } : {}),
          signal: controller.signal,
        }),
      );
    } catch {
      return { status: "transport" };
    }
    try {
      await assertFinalResponseDestination(response, request.url);
      const body = await readBoundedBody(
        response,
        limits.maxResponseBytes,
        controller.signal,
      );
      return { status: "received", httpStatus: response.status, body };
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        return { status: "response-too-large" };
      }
      if (error instanceof InvalidResponseError) {
        return { status: "invalid-response" };
      }
      return { status: "transport" };
    }
  })();

  let deadlineElapsed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<WireResult>((resolve) => {
    timeout = setTimeout(() => {
      deadlineElapsed = true;
      controller.abort();
      resolve({ status: "timeout" });
    }, limits.requestTimeoutMs);
  });
  try {
    const result = await Promise.race([operation, deadline]);
    if (deadlineElapsed) {
      await operation;
      return { status: "timeout" };
    }
    return result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(maxResponseBytes)
  ) {
    throw new ResponseTooLargeError();
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancellation: Promise<void> | undefined;
  const cancelReader = () => {
    cancellation ??= reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  if (signal.aborted) cancelReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    if (cancellation) await cancellation;
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidResponseError();
  }
}

function receivedBodyOrThrow(result: WireResult, operation: string): string {
  if (result.status === "received") return result.body;
  throw new OpenRouterManagementAdapterError(
    result.status,
    `OpenRouter ${operation} failed with ${result.status}`,
  );
}

function parseListResponse(body: string): OpenRouterManagedKey[] {
  const value = parseJsonObject(body);
  if (!Array.isArray(value.data)) {
    throw new OpenRouterManagementAdapterError(
      "invalid-response",
      "OpenRouter list keys response did not contain a data array",
    );
  }
  try {
    return value.data.map(parseManagedKey);
  } catch {
    throw new OpenRouterManagementAdapterError(
      "invalid-response",
      "OpenRouter list keys response contained invalid key metadata",
    );
  }
}

function parseCreateResponse(
  body: string,
  expectedName: string,
  expectedLimitMicros: ExactOpenRouterLimitMicros,
  expectedExpiresAt: string,
): { key: OpenRouterManagedKey; runtimeKey: string } {
  const value = parseJsonObject(body);
  const runtimeKey = value.key;
  const key = parseManagedKey(value.data);
  if (
    typeof runtimeKey !== "string" ||
    runtimeKey.length === 0 ||
    runtimeKey !== runtimeKey.trim() ||
    key.name !== expectedName ||
    key.disabled ||
    !isRecord(value.data) ||
    typeof value.data.limit !== "number" ||
    !Number.isFinite(value.data.limit) ||
    value.data.limit < 0 ||
    usdNumberToMicros(value.data.limit) !== expectedLimitMicros ||
    value.data.limit_reset !== null ||
    value.data.expires_at !== expectedExpiresAt
  ) {
    throw new Error("OpenRouter create response did not match the request");
  }
  return { key, runtimeKey };
}

function parseManagedKey(value: unknown): OpenRouterManagedKey {
  if (!isRecord(value)) {
    throw new Error("OpenRouter key metadata must be an object");
  }
  validateOpaqueIdentifier(value.hash, "OpenRouter key hash");
  validateOpaqueName(value.name);
  if (typeof value.disabled !== "boolean") {
    throw new Error("OpenRouter key disabled state must be boolean");
  }
  return { hash: value.hash, name: value.name, disabled: value.disabled };
}

function parseJsonObject(body: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new OpenRouterManagementAdapterError(
      "invalid-response",
      "OpenRouter management response was not valid JSON",
    );
  }
  if (!isRecord(value)) {
    throw new OpenRouterManagementAdapterError(
      "invalid-response",
      "OpenRouter management response was not a JSON object",
    );
  }
  return value;
}

function exactNameLookup(
  name: string,
  matches: readonly OpenRouterManagedKey[],
): OpenRouterExactNameLookup {
  if (matches.length === 0) {
    return {
      status: "none",
      binding: OPENROUTER_PROVIDER_BINDING,
      name,
      matches: [],
    };
  }
  if (matches.length === 1) {
    return {
      status: "one",
      binding: OPENROUTER_PROVIDER_BINDING,
      name,
      matches: [matches[0]!],
    };
  }
  return {
    status: "multiple",
    binding: OPENROUTER_PROVIDER_BINDING,
    name,
    matches: [...matches],
  };
}

function ambiguousMutation(
  reason: MutationAmbiguityReason,
  httpStatus?: number,
): Extract<OpenRouterCreateKeyResult, { status: "ambiguous" }> {
  return {
    status: "ambiguous",
    binding: OPENROUTER_PROVIDER_BINDING,
    reason,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function isDocumentedRejectionStatus(
  operation: "create" | "disable",
  status: number,
): boolean {
  return operation === "create"
    ? [400, 401, 403, 429].includes(status)
    : [400, 401, 403, 404, 429].includes(status);
}

function microsToUsdJsonNumber(micros: ExactOpenRouterLimitMicros): string {
  if (
    typeof micros !== "bigint" ||
    micros < 0n ||
    micros > OPENROUTER_EXACT_LIMIT_MAX_MICROS
  ) {
    throw new Error(
      `OpenRouter key limit must be no greater than ${OPENROUTER_EXACT_LIMIT_MAX_MICROS} USD micros`,
    );
  }
  const whole = micros / MICROS_PER_DOLLAR;
  const remainder = micros % MICROS_PER_DOLLAR;
  const fraction = remainder
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  const decimal = fraction ? `${whole}.${fraction}` : whole.toString();
  if (!Number.isFinite(Number(decimal))) {
    throw new Error("OpenRouter key limit exceeds the provider number range");
  }
  return decimal;
}

function usdNumberToMicros(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("OpenRouter key limit was not a nonnegative finite number");
  }
  const micros = value * Number(MICROS_PER_DOLLAR);
  if (!Number.isSafeInteger(micros)) {
    throw new Error("OpenRouter key limit did not represent exact USD micros");
  }
  const exact = BigInt(micros);
  if (exact > OPENROUTER_EXACT_LIMIT_MAX_MICROS) {
    throw new Error("OpenRouter key limit exceeded the exact adapter range");
  }
  return exact;
}

function validateExpiration(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("OpenRouter key expiration must be a valid UTC timestamp");
  }
  return value.toISOString();
}

function providerUrl(path: string): string {
  const base = new URL(`${OPENROUTER_PROVIDER_BINDING.apiBase}/`);
  const url = new URL(path, base);
  const serialized = url.toString();
  assertBoundProviderUrl(serialized);
  return serialized;
}

function assertBoundProviderUrl(value: string): void {
  const base = new URL(`${OPENROUTER_PROVIDER_BINDING.apiBase}/`);
  const url = new URL(value);
  if (
    url.protocol !== base.protocol ||
    url.host !== base.host ||
    !url.pathname.startsWith(base.pathname)
  ) {
    throw new Error(
      "OpenRouter management request escaped its provider binding",
    );
  }
}

async function assertFinalResponseDestination(
  response: Response,
  requestedUrl: string,
): Promise<void> {
  if (
    response.redirected ||
    response.type === "opaqueredirect" ||
    response.url !== requestedUrl
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // Destination validation remains authoritative when cancellation fails.
    }
    throw new InvalidResponseError();
  }
}

function validateCredential(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("OpenRouter management credential is invalid");
  }
}

function validateIntentId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("OpenRouter create intent id is invalid");
  }
}

function validateOpaqueName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > OPENROUTER_KEY_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      "OpenRouter key name must be a nonempty opaque string without control characters",
    );
  }
}

function validateOpaqueIdentifier(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_OPAQUE_IDENTIFIER_LENGTH ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
}

function resolveLimits(input: Partial<AdapterLimits> | undefined): AdapterLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    const maximum = HARD_LIMITS[name as keyof AdapterLimits];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(
        `OpenRouter adapter ${name} must be a positive safe integer no greater than ${maximum}`,
      );
    }
  }
  return Object.freeze(limits);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ResponseTooLargeError extends Error {}
class InvalidResponseError extends Error {}
