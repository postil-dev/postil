import { HOSTED_REVIEW_RESERVATION_MICROS } from "@/lib/hosted-usage-reservations";
import type { PrivateMonitoringCheck } from "@/lib/private-monitoring";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface OpenRouterKeyMetadata {
  name: string;
  disabled: boolean;
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
  usage: number;
  usageDaily: number;
  usageWeekly: number;
  usageMonthly: number;
  byokUsage: number;
  byokUsageDaily: number;
  byokUsageWeekly: number;
  byokUsageMonthly: number;
}

interface MetadataResult<T> {
  value: T | null;
  detail: string;
}

export interface OpenRouterMonitoredKeyNames {
  development: string;
  production: string;
  emergency: string;
}

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const KEY_PAGE_SIZE = 100;
const MAX_KEY_PAGES = 100;

export const DEFAULT_OPENROUTER_REVIEW_OUTAGE_THRESHOLD_USD =
  HOSTED_REVIEW_RESERVATION_MICROS / 1_000_000;

export function configuredOpenRouterReviewOutageThresholdUsd(
  raw = process.env.POSTIL_OPENROUTER_REVIEW_OUTAGE_THRESHOLD_USD,
): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_OPENROUTER_REVIEW_OUTAGE_THRESHOLD_USD;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1_000) {
    throw new Error(
      "POSTIL_OPENROUTER_REVIEW_OUTAGE_THRESHOLD_USD must be greater than 0 and at most 1000",
    );
  }
  return value;
}

export async function runOpenRouterCapMonitoringChecks(input: {
  managementKey: string;
  keyNames: OpenRouterMonitoredKeyNames;
  reviewOutageThresholdUsd?: number;
  fetchImpl?: Fetch;
}): Promise<PrivateMonitoringCheck[]> {
  const managementKey = input.managementKey.trim();
  if (!managementKey) {
    throw new Error("OpenRouter management credential is required");
  }
  validateKeyNames(input.keyNames);
  const threshold =
    input.reviewOutageThresholdUsd ??
    DEFAULT_OPENROUTER_REVIEW_OUTAGE_THRESHOLD_USD;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1_000) {
    throw new Error(
      "OpenRouter review outage threshold must be greater than 0 and at most 1000",
    );
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const [keyResult, creditResult] = await Promise.all([
    fetchKeyMetadata(managementKey, input.keyNames, fetchImpl),
    fetchAccountCredits(managementKey, fetchImpl),
  ]);
  const checks: PrivateMonitoringCheck[] = [];

  checks.push(metadataAvailabilityCheck("keys", keyResult));
  if (keyResult.value) {
    checks.push(
      dailyCapCheck(
        "openrouter-development-daily-cap",
        input.keyNames.development,
        keyResult.value,
        threshold,
      ),
      dailyCapCheck(
        "openrouter-production-daily-cap",
        input.keyNames.production,
        keyResult.value,
        threshold,
      ),
      emergencyConfigurationCheck(keyResult.value, input.keyNames.emergency),
      emergencyUsageCheck(keyResult.value, input.keyNames.emergency),
    );
  }

  checks.push(metadataAvailabilityCheck("credits", creditResult));
  if (creditResult.value) {
    const remaining =
      creditResult.value.totalCredits - creditResult.value.totalUsage;
    checks.push({
      key: "openrouter-account-balance",
      group: "provider",
      severity: "critical",
      healthy: remaining > threshold,
      summary: "OpenRouter account balance covers another review",
      detail: `${formatUsd(remaining)} account balance remains; review outage threshold ${formatUsd(threshold)}. This is account-wide credit, not a per-key daily allowance.`,
    });
  }

  return checks;
}

function metadataAvailabilityCheck(
  kind: "keys" | "credits",
  result: MetadataResult<unknown>,
): PrivateMonitoringCheck {
  return {
    key: `openrouter-${kind}-metadata`,
    group: "provider",
    severity: "critical",
    healthy: result.value !== null,
    summary:
      kind === "keys"
        ? "OpenRouter key metadata is readable"
        : "OpenRouter account credit metadata is readable",
    detail: result.detail,
  };
}

function dailyCapCheck(
  key: string,
  expectedName: string,
  keys: readonly OpenRouterKeyMetadata[],
  threshold: number,
): PrivateMonitoringCheck {
  const matches = keys.filter((candidate) => candidate.name === expectedName);
  const metadata = matches.length === 1 ? (matches[0] ?? null) : null;
  const configured =
    metadata !== null &&
    !metadata.disabled &&
    metadata.limitReset === "daily" &&
    metadata.limit !== null &&
    metadata.limit > 0 &&
    metadata.limitRemaining !== null;
  const healthy =
    configured && metadata.limitRemaining! > threshold;
  let detail: string;
  if (matches.length === 0) {
    detail = `Expected key ${expectedName} is absent from management metadata.`;
  } else if (matches.length > 1) {
    detail = `Expected key ${expectedName} is not unique in management metadata.`;
  } else if (!configured) {
    detail = `${expectedName} must be enabled with an independently enforced daily USD cap.`;
  } else {
    detail = `${formatUsd(metadata.limitRemaining!)} of ${formatUsd(metadata.limit!)} daily allowance remains; review outage threshold ${formatUsd(threshold)}. Account balance is evaluated separately.`;
  }
  return {
    key,
    group: "provider",
    severity: "critical",
    healthy,
    summary: `${expectedName} daily allowance covers another review`,
    detail,
  };
}

function emergencyConfigurationCheck(
  keys: readonly OpenRouterKeyMetadata[],
  emergencyKeyName: string,
): PrivateMonitoringCheck {
  const matches = keys.filter((candidate) => candidate.name === emergencyKeyName);
  const metadata = matches.length === 1 ? (matches[0] ?? null) : null;
  const healthy =
    metadata !== null &&
    !metadata.disabled &&
    metadata.limitReset === "daily" &&
    metadata.limit !== null &&
    metadata.limit > 0;
  let detail: string;
  if (matches.length === 0) {
    detail = `Expected emergency key ${emergencyKeyName} is absent from management metadata.`;
  } else if (matches.length > 1) {
    detail = `Expected emergency key ${emergencyKeyName} is not unique in management metadata.`;
  } else if (!healthy) {
    detail = `${emergencyKeyName} must remain enabled with its own daily USD cap.`;
  } else {
    detail = `${emergencyKeyName} is enabled with an independent ${formatUsd(metadata.limit!)} daily cap.`;
  }
  return {
    key: "openrouter-emergency-configuration",
    group: "provider",
    severity: "critical",
    healthy,
    summary: "Emergency OpenRouter key remains enabled and independently capped",
    detail,
  };
}

function emergencyUsageCheck(
  keys: readonly OpenRouterKeyMetadata[],
  emergencyKeyName: string,
): PrivateMonitoringCheck {
  const matches = keys.filter((candidate) => candidate.name === emergencyKeyName);
  const metadata = matches.length === 1 ? (matches[0] ?? null) : null;
  const usage = metadata
    ? [
        metadata.usage,
        metadata.usageDaily,
        metadata.usageWeekly,
        metadata.usageMonthly,
        metadata.byokUsage,
        metadata.byokUsageDaily,
        metadata.byokUsageWeekly,
        metadata.byokUsageMonthly,
      ]
    : [];
  const healthy = metadata !== null && usage.every((value) => value === 0);
  return {
    key: "openrouter-emergency-unused",
    group: "provider",
    severity: "critical",
    healthy,
    summary: "Emergency OpenRouter key remains unused",
    detail:
      metadata === null
        ? `Usage cannot be verified because ${emergencyKeyName} is missing or duplicated.`
        : healthy
          ? "Lifetime, daily, weekly, monthly, and BYOK usage are all zero."
          : `Emergency key usage is nonzero (${formatUsd(metadata.usage)} lifetime, ${formatUsd(metadata.usageDaily)} daily). Investigate every credential binding before local or hosted inference continues.`,
  };
}

async function fetchKeyMetadata(
  managementKey: string,
  keyNames: OpenRouterMonitoredKeyNames,
  fetchImpl: Fetch,
): Promise<MetadataResult<OpenRouterKeyMetadata[]>> {
  const selected: OpenRouterKeyMetadata[] = [];
  for (let page = 0; page < MAX_KEY_PAGES; page += 1) {
    const url = new URL("/api/v1/keys", OPENROUTER_ORIGIN);
    url.searchParams.set("include_disabled", "true");
    url.searchParams.set("offset", String(page * KEY_PAGE_SIZE));
    const response = await managementRequest(url, managementKey, fetchImpl);
    if (!response.ok) return { value: null, detail: response.detail };
    const data = response.value as { data?: unknown };
    if (!Array.isArray(data.data)) {
      return {
        value: null,
        detail: "OpenRouter key metadata did not match the expected response contract.",
      };
    }
    for (const raw of data.data) {
      if (!isRecord(raw) || typeof raw.name !== "string") continue;
      if (!Object.values(keyNames).includes(raw.name)) {
        continue;
      }
      const parsed = parseKeyMetadata(raw);
      if (!parsed) {
        return {
          value: null,
          detail: `OpenRouter metadata for ${raw.name} did not match the expected response contract.`,
        };
      }
      selected.push(parsed);
    }
    if (data.data.length < KEY_PAGE_SIZE) {
      return {
        value: selected,
        detail: "OpenRouter key metadata was read successfully.",
      };
    }
  }
  return {
    value: null,
    detail: "OpenRouter key metadata pagination exceeded the bounded page limit.",
  };
}

async function fetchAccountCredits(
  managementKey: string,
  fetchImpl: Fetch,
): Promise<
  MetadataResult<{ totalCredits: number; totalUsage: number }>
> {
  const response = await managementRequest(
    new URL("/api/v1/credits", OPENROUTER_ORIGIN),
    managementKey,
    fetchImpl,
  );
  if (!response.ok) return { value: null, detail: response.detail };
  const raw = response.value as { data?: unknown };
  if (
    !isRecord(raw.data) ||
    !isNonnegativeFiniteNumber(raw.data.total_credits) ||
    !isNonnegativeFiniteNumber(raw.data.total_usage)
  ) {
    return {
      value: null,
      detail: "OpenRouter account credit metadata did not match the expected response contract.",
    };
  }
  return {
    value: {
      totalCredits: raw.data.total_credits,
      totalUsage: raw.data.total_usage,
    },
    detail: "OpenRouter account credit metadata was read successfully.",
  };
}

async function managementRequest(
  url: URL,
  managementKey: string,
  fetchImpl: Fetch,
): Promise<
  | { ok: true; value: unknown; detail: string }
  | { ok: false; detail: string }
> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${managementKey}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      detail: "OpenRouter management metadata request failed before an HTTP response was received.",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      detail:
        response.status === 401
          ? "OpenRouter management credential was rejected with HTTP 401."
          : response.status === 403
            ? "OpenRouter management credential lacks permission (HTTP 403)."
            : `OpenRouter management metadata request returned HTTP ${response.status}.`,
    };
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    return {
      ok: false,
      detail: "OpenRouter management metadata response exceeded the size limit.",
    };
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    return {
      ok: false,
      detail: "OpenRouter management metadata response exceeded the size limit.",
    };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(body),
      detail: "OpenRouter management metadata request succeeded.",
    };
  } catch {
    return {
      ok: false,
      detail: "OpenRouter management metadata response was not valid JSON.",
    };
  }
}

function parseKeyMetadata(raw: Record<string, unknown>): OpenRouterKeyMetadata | null {
  if (
    typeof raw.name !== "string" ||
    typeof raw.disabled !== "boolean" ||
    !isNullableNonnegativeFiniteNumber(raw.limit) ||
    !isNullableNonnegativeFiniteNumber(raw.limit_remaining) ||
    !(raw.limit_reset === null || typeof raw.limit_reset === "string") ||
    !isNonnegativeFiniteNumber(raw.usage) ||
    !isNonnegativeFiniteNumber(raw.usage_daily) ||
    !isNonnegativeFiniteNumber(raw.usage_weekly) ||
    !isNonnegativeFiniteNumber(raw.usage_monthly) ||
    !isNonnegativeFiniteNumber(raw.byok_usage) ||
    !isNonnegativeFiniteNumber(raw.byok_usage_daily) ||
    !isNonnegativeFiniteNumber(raw.byok_usage_weekly) ||
    !isNonnegativeFiniteNumber(raw.byok_usage_monthly)
  ) {
    return null;
  }
  return {
    name: raw.name,
    disabled: raw.disabled,
    limit: raw.limit,
    limitRemaining: raw.limit_remaining,
    limitReset: raw.limit_reset,
    usage: raw.usage,
    usageDaily: raw.usage_daily,
    usageWeekly: raw.usage_weekly,
    usageMonthly: raw.usage_monthly,
    byokUsage: raw.byok_usage,
    byokUsageDaily: raw.byok_usage_daily,
    byokUsageWeekly: raw.byok_usage_weekly,
    byokUsageMonthly: raw.byok_usage_monthly,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableNonnegativeFiniteNumber(
  value: unknown,
): value is number | null {
  return value === null || isNonnegativeFiniteNumber(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function validateKeyNames(keyNames: OpenRouterMonitoredKeyNames): void {
  const names = Object.values(keyNames).map((name) => name.trim());
  if (
    Object.values(keyNames).some(
      (name) =>
        name !== name.trim() ||
        name.length === 0 ||
        name.length > 160 ||
        /[\u0000-\u001f\u007f]/.test(name),
    ) ||
    new Set(names).size !== names.length
  ) {
    throw new Error(
      "OpenRouter monitored key names must be nonempty, distinct, and at most 160 characters",
    );
  }
}
