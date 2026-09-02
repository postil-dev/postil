#!/usr/bin/env bun

const API_BASE = "https://api.ilert.com/api";
const WEBHOOK_URL = "https://postil.dev/api/webhooks/ilert";
const ACTION_NAME = "Postil operator alert stream";
const REQUEST_TIMEOUT_MS = 7_500;
const CANARY_ATTEMPTS = 6;
const CANARY_RETRY_MS = 2_000;
const CANARY_CLEANUP_RETRY_MS = 5_000;
const CANARY_DEADLINE_MS = 360_000;
const CANARY_CLEANUP_RESERVE_MS = 120_000;
const CANARY_CLEANUP_ATTEMPTS = 4;
const CANARY_LOOKBACK_MS = 60 * 60 * 1_000;
const ALERT_ACTION_DETAILS_CONCURRENCY = 32;
const CANARY_KEY = "postil-operator-alert-stream-canary";

export const ALERT_TRIGGER_TYPES = [
  "alert-created",
  "alert-acknowledged",
  "alert-comment-added",
  "alert-resolved",
] as const;

type Json = Record<string, unknown>;
export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;
type Clock = () => number;
type Operation = "create" | "update" | "unchanged";

interface Deadline {
  expiresAt: number;
  now: Clock;
}

interface ReconcileOptions {
  apiKey: string;
  sourceId: number;
  webhookSecret: string;
  dryRun?: boolean;
  fetchFn?: Fetch;
}

interface CanaryOptions {
  actionId: string;
  apiKey: string;
  integrationKey: string;
  fetchFn?: Fetch;
  sleep?: Sleep;
  now?: Clock;
  startedAt?: string;
}

export interface ReconcileResult {
  actionId: string | null;
  operation: Operation;
}

export function canaryAlertKey(): string {
  return CANARY_KEY;
}

export function desiredAlertAction(source: Json, secret: string): Json {
  return {
    alertSources: [source],
    connectorType: "webhook",
    name: ACTION_NAME,
    triggerMode: "AUTOMATIC",
    triggerTypes: [...ALERT_TRIGGER_TYPES],
    params: {
      webhookUrl: webhookUrl(secret),
    },
  };
}

export function equivalentAlertAction(actual: Json, desired: Json): boolean {
  const left = object(actual.params);
  const right = object(desired.params);
  return (
    actual.name === desired.name &&
    actual.connectorType === desired.connectorType &&
    actual.triggerMode === desired.triggerMode &&
    sameSet(strings(actual.triggerTypes), strings(desired.triggerTypes)) &&
    sameSet(relationIds(actual.alertSources), relationIds(desired.alertSources)) &&
    left?.webhookUrl === right?.webhookUrl &&
    hasNoHeaders(left?.headers) &&
    hasNoHeaders(right?.headers)
  );
}

export async function reconcileIlertAlertAction(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const source = alertSource(
    await management(fetchFn, options.apiKey, `/alert-sources/${options.sourceId}`),
    options.sourceId,
  );
  const desired = desiredAlertAction(source, options.webhookSecret);
  const listed = await listActions(fetchFn, options.apiKey);
  const actions: Json[] = [];
  for (
    let index = 0;
    index < listed.length;
    index += ALERT_ACTION_DETAILS_CONCURRENCY
  ) {
    actions.push(
      ...(await Promise.all(
        listed.slice(index, index + ALERT_ACTION_DETAILS_CONCURRENCY).map(async (item) =>
          requireObject(
            await management(
              fetchFn,
              options.apiKey,
              `/alert-actions/${encodeURIComponent(actionId(item))}`,
            ),
            "iLert returned an invalid alert action",
          ),
        ),
      )),
    );
  }
  const candidates = actions.filter((action) => {
    const params = object(action.params);
    return (
      action.name === ACTION_NAME ||
      params?.webhookUrl === object(desired.params)?.webhookUrl
    );
  });
  if (
    candidates.some(
      (action) =>
        action.connectorType !== "webhook" ||
        !sameSet(relationIds(action.alertSources), [options.sourceId]),
    )
  ) {
    throw new Error(
      "A conflicting Postil alert action exists; refusing to change its type or source scope",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      "Multiple Postil webhook alert actions exist; refusing to choose or delete one",
    );
  }

  const existing = candidates[0];
  const operation: Operation = !existing
    ? "create"
    : equivalentAlertAction(existing, desired)
      ? "unchanged"
      : "update";
  if (operation === "unchanged") {
    return { actionId: actionId(existing!), operation };
  }
  if (options.dryRun) {
    return { actionId: existing ? actionId(existing) : null, operation };
  }

  const id = existing ? actionId(existing) : null;
  const result = requireObject(
    await management(
      fetchFn,
      options.apiKey,
      id ? `/alert-actions/${encodeURIComponent(id)}` : "/alert-actions",
      {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(id ? { ...desired, id } : desired),
      },
    ),
    "iLert returned an invalid alert action",
  );
  const resultId = actionId(result);
  const confirmed = requireObject(
    await management(
      fetchFn,
      options.apiKey,
      `/alert-actions/${encodeURIComponent(resultId)}`,
    ),
    "iLert returned an invalid alert action",
  );
  if (!equivalentAlertAction(confirmed, desired)) {
    throw new Error("iLert did not retain the reconciled alert action");
  }
  return { actionId: resultId, operation };
}

export async function verifyIlertAlertStreamCanary(
  options: CanaryOptions,
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const startedAt = options.startedAt ?? new Date(startedAtMs - 5_000).toISOString();
  const canaryDeadline: Deadline = {
    expiresAt: startedAtMs + CANARY_DEADLINE_MS,
    now,
  };
  const primaryDeadline: Deadline = {
    expiresAt: canaryDeadline.expiresAt - CANARY_CLEANUP_RESERVE_MS,
    now,
  };
  const key = canaryAlertKey();
  let alertAttempted = false;
  let resolutionConfirmed = false;
  let created: { alertId: string; deliveries: number } | undefined;
  let primaryError: unknown;
  try {
    await resolveAndStabilize(
      options,
      undefined,
      key,
      sleep,
      startedAt,
      primaryDeadline,
      true,
    );
    assertCleanupReserve(canaryDeadline);
    alertAttempted = true;
    await event(fetchFn, options.integrationKey, "ALERT", key, primaryDeadline);
    created = await waitForDelivery({
      ...options,
      deadline: primaryDeadline,
      fetchFn,
      key,
      sleep,
      startedAt,
    });
    await resolveAndStabilize(options, created, key, sleep, startedAt, canaryDeadline);
    resolutionConfirmed = true;
  } catch (error) {
    primaryError = error;
  }
  if (alertAttempted && !resolutionConfirmed) {
    try {
      await resolveAndStabilize(options, created, key, sleep, startedAt, canaryDeadline);
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          "iLert canary failed and cleanup could not be verified",
        );
      }
      throw cleanupError;
    }
  }
  if (primaryError) throw primaryError;
}

export async function finalizeIlertAlertStreamCanary(
  options: CanaryOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const deadline: Deadline = {
    expiresAt: now() + CANARY_CLEANUP_RESERVE_MS,
    now,
  };
  await resolveAndStabilize(
    options,
    undefined,
    canaryAlertKey(),
    options.sleep ?? Bun.sleep,
    options.startedAt ?? new Date(now() - CANARY_LOOKBACK_MS).toISOString(),
    deadline,
  );
}

interface WaitOptions extends CanaryOptions {
  alertId?: string;
  fetchFn: Fetch;
  key: string;
  minimumDeliveries?: number;
  requiredStatus?: string;
  sleep: Sleep;
  startedAt: string;
  deadline: Deadline;
}

async function resolveAndStabilize(
  options: CanaryOptions,
  created: { alertId: string; deliveries: number } | undefined,
  key: string,
  sleep: Sleep,
  startedAt: string,
  deadline: Deadline,
  allowUnseen = false,
): Promise<void> {
  let matched = false;
  let resolutionDelivered = false;
  let stabilized = false;
  for (let attempt = 0; attempt < CANARY_CLEANUP_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline(deadline);
    await event(options.fetchFn ?? fetch, options.integrationKey, "RESOLVE", key, deadline);
    const observed = await observeCanary({
      ...options,
      alertId: created?.alertId,
      deadline,
      fetchFn: options.fetchFn ?? fetch,
      key,
      sleep,
      startedAt,
    });
    if (observed) {
      matched = true;
      resolutionDelivered ||= observed.deliveries >= (created?.deliveries ?? 0) + 1;
      stabilized = resolutionDelivered && observed.status === "RESOLVED";
    }
    if (attempt + 1 < CANARY_CLEANUP_ATTEMPTS) {
      await sleep(Math.min(CANARY_CLEANUP_RETRY_MS, remaining(deadline)));
    }
  }
  if (matched && stabilized) return;
  if (!matched && allowUnseen) return;
  throw new Error("iLert did not verify canary resolution during stabilization");
}

async function waitForDelivery(
  options: WaitOptions,
): Promise<{ alertId: string; deliveries: number }> {
  for (let attempt = 0; attempt < CANARY_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline(options.deadline);
    const observed = await observeCanary(options);
    if (
      observed &&
      observed.deliveries >= (options.minimumDeliveries ?? 1) &&
      (!options.requiredStatus || observed.status === options.requiredStatus)
    ) {
      return { alertId: observed.alertId, deliveries: observed.deliveries };
    }
    if (attempt + 1 < CANARY_ATTEMPTS) {
      await options.sleep(Math.min(CANARY_RETRY_MS, remaining(options.deadline)));
    }
  }
  throw new Error("iLert did not confirm successful Postil webhook delivery");
}

async function observeCanary(
  options: WaitOptions,
): Promise<{ alertId: string; deliveries: number; status: unknown } | undefined> {
  const alerts = await management(
    options.fetchFn,
    options.apiKey,
    `/alerts?from=${encodeURIComponent(options.startedAt)}&max-results=100`,
    {},
    options.deadline,
  );
  if (!Array.isArray(alerts)) {
    throw new Error("iLert returned an invalid alert list during the canary");
  }
  const alert = object(alerts.find((item) => object(item)?.alertKey === options.key));
  const id = positiveId(alert?.id);
  if (!id || (options.alertId && options.alertId !== id)) return undefined;
  const value = await management(
    options.fetchFn,
    options.apiKey,
    `/alerts/${encodeURIComponent(id)}/actions`,
    {},
    options.deadline,
  );
  const actions = Array.isArray(value) ? value : [value];
  if (actions.some((item) => !object(item))) {
    throw new Error("iLert returned invalid action history during the canary");
  }
  const deliveries = actions
    .filter((item) => opaqueId(object(item)?.alertActionId) === options.actionId)
    .flatMap((item) => {
      const history = object(item)?.history;
      return Array.isArray(history) ? history : [];
    })
    .filter((item) => object(item)?.success === true).length;
  return { alertId: id, deliveries, status: alert?.status };
}

async function event(
  fetchFn: Fetch,
  integrationKey: string,
  eventType: "ALERT" | "RESOLVE",
  alertKey: string,
  deadline?: Deadline,
): Promise<void> {
  const response = await request(fetchFn, `${API_BASE}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      integrationKey,
      eventType,
      summary:
        eventType === "ALERT"
          ? "Postil operator alert stream canary"
          : "Postil operator alert stream canary resolved",
      ...(eventType === "ALERT"
        ? {
            details:
              "GitHub Actions is verifying the Postil operator notification path.",
            priority: "HIGH",
          }
        : {}),
      alertKey,
    }),
  }, deadline);
  if (!response.ok) {
    throw new Error(`iLert event request failed with HTTP ${response.status}`);
  }
}

async function management(
  fetchFn: Fetch,
  apiKey: string,
  path: string,
  init: RequestInit = {},
  deadline?: Deadline,
): Promise<unknown> {
  const response = await request(fetchFn, `${API_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  }, deadline);
  if (!response.ok) {
    throw new Error(`iLert management request failed with HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("iLert returned invalid JSON");
  }
}

function request(
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
  deadline?: Deadline,
): Promise<Response> {
  const timeout = deadline
    ? Math.min(REQUEST_TIMEOUT_MS, remaining(deadline))
    : REQUEST_TIMEOUT_MS;
  if (timeout <= 0) throw new Error("iLert canary deadline expired");
  return fetchFn(url, { ...init, signal: AbortSignal.timeout(timeout) });
}

async function listActions(fetchFn: Fetch, apiKey: string): Promise<Json[]> {
  const actions: Json[] = [];
  for (let start = 0; start <= 1_000; start += 100) {
    const page = await management(
      fetchFn,
      apiKey,
      `/alert-actions?start-index=${start}&max-results=100`,
    );
    if (!Array.isArray(page) || page.some((item) => !object(item))) {
      throw new Error("iLert returned an invalid alert-action list");
    }
    actions.push(...(page as Json[]));
    if (page.length < 100) return actions;
  }
  const probe = await management(
    fetchFn,
    apiKey,
    "/alert-actions?start-index=1100&max-results=100",
  );
  if (!Array.isArray(probe) || probe.some((item) => !object(item))) {
    throw new Error("iLert returned an invalid alert-action list");
  }
  if (probe.length === 0) return actions;
  throw new Error("iLert alert-action pagination exceeded the safety bound");
}

function alertSource(value: unknown, expectedId: number): Json {
  const source = requireObject(value, "iLert returned an invalid alert source");
  const policy = object(source.escalationPolicy);
  const id = positiveNumber(source.id);
  if (
    id !== expectedId ||
    !nonempty(source.name) ||
    !nonempty(source.integrationType) ||
    !nonempty(policy?.name) ||
    !Array.isArray(policy?.escalationRules)
  ) {
    throw new Error("iLert returned an invalid alert source");
  }
  const policyId = positiveNumber(policy.id);
  return {
    id,
    name: source.name,
    integrationType: source.integrationType,
    escalationPolicy: {
      ...(policyId ? { id: policyId } : {}),
      name: policy.name,
      escalationRules: policy.escalationRules,
    },
  };
}

function actionId(value: unknown): string {
  const id = opaqueId(object(value)?.id);
  if (id) return id;
  throw new Error("iLert returned an alert action without an identity");
}

function opaqueId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    return value;
  }
  return null;
}

function positiveId(value: unknown): string | null {
  const id = positiveNumber(value);
  return id ? String(id) : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
      ? Number(value)
      : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function relationIds(value: unknown): number[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const id = positiveNumber(object(item)?.id);
        return id ? [id] : [];
      })
    : [];
}

function hasNoHeaders(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function sameSet<T extends number | string>(left: T[], right: T[]): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function object(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function requireObject(value: unknown, message: string): Json {
  const result = object(value);
  if (!result) throw new Error(message);
  return result;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function webhookUrl(secret: string): string {
  return WEBHOOK_URL.replace(
    "https://",
    `https://${encodeURIComponent("postil-ilert")}:${encodeURIComponent(secret)}@`,
  );
}

function remaining(deadline: Deadline): number {
  return deadline.expiresAt - deadline.now();
}

function assertBeforeDeadline(deadline: Deadline): void {
  if (remaining(deadline) <= 0) throw new Error("iLert canary deadline expired");
}

function assertCleanupReserve(deadline: Deadline): void {
  if (remaining(deadline) < CANARY_CLEANUP_RESERVE_MS) {
    throw new Error("iLert canary cannot start without its cleanup reserve");
  }
}

function environment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) =>
        arg !== "--dry-run" && arg !== "--canary" && arg !== "--finalize-canary",
    )
  ) {
    throw new Error(
      "usage: reconcile-ilert-alert-stream.ts [--dry-run] [--canary|--finalize-canary]",
    );
  }
  const dryRun = args.includes("--dry-run");
  const canary = args.includes("--canary");
  const finalizeCanary = args.includes("--finalize-canary");
  if (dryRun && (canary || finalizeCanary)) {
    throw new Error("--dry-run cannot be combined with a canary command");
  }
  if (canary && finalizeCanary) {
    throw new Error("--canary cannot be combined with --finalize-canary");
  }
  const apiKey = environment("ILERT_API_KEY");
  const sourceId = Number(environment("POSTIL_ILERT_ALERT_SOURCE_ID"));
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error("POSTIL_ILERT_ALERT_SOURCE_ID must be a positive integer");
  }
  const result = await reconcileIlertAlertAction({
    apiKey,
    sourceId,
    webhookSecret: environment("POSTIL_ILERT_WEBHOOK_SECRET"),
    dryRun,
  });
  console.log(
    `iLert alert-stream reconciliation${dryRun ? " plan" : ""}: ${result.operation}`,
  );
  if (canary || finalizeCanary) {
    if (!result.actionId) throw new Error("the reconciled alert action has no identity");
    const options = {
      actionId: result.actionId,
      apiKey,
      integrationKey: environment("ILERT_INTEGRATION_KEY"),
    };
    if (canary) {
      await verifyIlertAlertStreamCanary(options);
      console.log("iLert confirmed successful Postil webhook delivery");
    } else {
      await finalizeIlertAlertStreamCanary(options);
      console.log("iLert confirmed canary resolution stabilization");
    }
  }
}

if (import.meta.main) await main();
