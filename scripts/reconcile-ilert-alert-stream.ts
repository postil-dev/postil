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
const CANARY_KEY_PREFIX = "postil-operator-alert-stream-canary";

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
  runAttempt: string;
  runId: string;
  sourceId?: number;
  fetchFn?: Fetch;
  sleep?: Sleep;
  now?: Clock;
  startedAt?: string;
}

export interface ReconcileResult {
  actionId: string | null;
  operation: Operation;
}

export function canaryAlertKey(runId: string, runAttempt: string): string {
  if (!positiveId(runId) || !positiveId(runAttempt)) {
    throw new Error("GitHub run ID and attempt must be positive integers");
  }
  return `${CANARY_KEY_PREFIX}-${runId}-${runAttempt}`;
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
  const actualRelationIds = relationIds(actual.alertSources);
  const desiredRelationIds = relationIds(desired.alertSources);
  return (
    actual.name === desired.name &&
    actual.connectorType === desired.connectorType &&
    actual.triggerMode === desired.triggerMode &&
    sameSet(strings(actual.triggerTypes), strings(desired.triggerTypes)) &&
    actualRelationIds !== null &&
    desiredRelationIds !== null &&
    sameSet(actualRelationIds, desiredRelationIds) &&
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
      (action) => {
        const actionRelationIds = relationIds(action.alertSources);
        return (
          action.connectorType !== "webhook" ||
          actionRelationIds === null ||
          !sameSet(actionRelationIds, [options.sourceId])
        );
      },
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
  const key = canaryAlertKey(options.runId, options.runAttempt);
  let alertAttempted = false;
  let resolutionConfirmed = false;
  let created: CanaryObservation | undefined;
  let preexistingAlertIds = new Set<string>();
  let primaryError: unknown;
  try {
    const waitOptions = {
      ...options,
      deadline: primaryDeadline,
      fetchFn,
      key,
      sleep,
      startedAt,
    };
    const preexisting = await findCanaryAlerts(waitOptions);
    preexistingAlertIds = new Set(preexisting.map(canaryAlertId));
    for (const alert of preexisting) {
      if (alert.status === "RESOLVED") continue;
      await resolveAndStabilize(
        options,
        await observeCanaryAlert(waitOptions, alert),
        key,
        sleep,
        startedAt,
        primaryDeadline,
      );
    }
    assertCleanupReserve(canaryDeadline);
    alertAttempted = true;
    await event(fetchFn, options.integrationKey, "ALERT", key, primaryDeadline);
    created = await waitForCreatedDelivery({
      ...options,
      deadline: primaryDeadline,
      fetchFn,
      key,
      sleep,
      startedAt,
      preexistingAlertIds,
    });
    await resolveAndStabilize(options, created, key, sleep, startedAt, canaryDeadline);
    resolutionConfirmed = true;
  } catch (error) {
    primaryError = error;
  }
  if (alertAttempted && !resolutionConfirmed) {
    try {
      const cleanupTarget = created ?? await findNewCanaryAlert({
        ...options,
        deadline: canaryDeadline,
        fetchFn,
        key,
        sleep,
        startedAt,
      }, preexistingAlertIds);
      if (cleanupTarget) {
        await resolveAndStabilize(
          options,
          cleanupTarget,
          key,
          sleep,
          startedAt,
          canaryDeadline,
        );
      }
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
  const key = canaryAlertKey(options.runId, options.runAttempt);
  const waitOptions = {
    ...options,
    deadline,
    fetchFn: options.fetchFn ?? fetch,
    key,
    sleep: options.sleep ?? Bun.sleep,
    startedAt: options.startedAt ?? new Date(now() - CANARY_LOOKBACK_MS).toISOString(),
  };
  const initial = await findCanaryAlerts(waitOptions);
  const initialCanary = initial[0];
  if (!initialCanary || initial.length !== 1) {
    throw new Error("iLert did not identify a unique canary for cleanup");
  }
  canaryAlertId(initialCanary);
  if (initialCanary.status === "RESOLVED") return;
  const created = await observeCanaryAlert(waitOptions, initialCanary);
  await resolveAndStabilize(
    options,
    created,
    key,
    waitOptions.sleep,
    waitOptions.startedAt,
    deadline,
  );
}

interface WaitOptions extends CanaryOptions {
  alertId?: string;
  fetchFn: Fetch;
  key: string;
  preexistingAlertIds?: ReadonlySet<string>;
  sleep: Sleep;
  startedAt: string;
  deadline: Deadline;
}

async function resolveAndStabilize(
  options: CanaryOptions,
  created: CanaryObservation | undefined,
  key: string,
  sleep: Sleep,
  startedAt: string,
  deadline: Deadline,
): Promise<void> {
  const deliveryBaseline = created ?? await observeCanary({
    ...options,
    deadline,
    fetchFn: options.fetchFn ?? fetch,
    key,
    sleep,
    startedAt,
  });
  if (!deliveryBaseline) {
    throw new Error("iLert did not identify a unique canary for cleanup");
  }
  if (deliveryBaseline.status === "RESOLVED") return;
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
      resolutionDelivered ||= Boolean(
        deliveryBaseline && deliveredAfter(observed, deliveryBaseline),
      );
      stabilized = resolutionDelivered && observed.status === "RESOLVED";
    }
    if (attempt + 1 < CANARY_CLEANUP_ATTEMPTS) {
      await sleep(Math.min(CANARY_CLEANUP_RETRY_MS, remaining(deadline)));
    }
  }
  if (matched && stabilized) return;
  throw new Error("iLert did not verify canary resolution during stabilization");
}

async function waitForCreatedDelivery(
  options: WaitOptions,
): Promise<CanaryObservation> {
  for (let attempt = 0; attempt < CANARY_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline(options.deadline);
    const observed = await findNewCanaryAlert(
      options,
      options.preexistingAlertIds ?? new Set(),
    );
    if (observed && observed.status === "PENDING" && observed.deliveries.count >= 1) {
      return observed;
    }
    if (attempt + 1 < CANARY_ATTEMPTS) {
      await options.sleep(Math.min(CANARY_RETRY_MS, remaining(options.deadline)));
    }
  }
  throw new Error("iLert did not confirm successful Postil webhook delivery");
}

async function observeCanary(
  options: WaitOptions,
): Promise<CanaryObservation | undefined> {
  const alerts = await findCanaryAlerts(options);
  const matches = options.alertId
    ? alerts.filter((alert) => canaryAlertId(alert) === options.alertId)
    : alerts;
  if (matches.length > 1) {
    throw new Error("Multiple current iLert canary alerts exist; refusing to choose one");
  }
  return matches[0] ? observeCanaryAlert(options, matches[0]) : undefined;
}

async function findNewCanaryAlert(
  options: WaitOptions,
  preexistingAlertIds: ReadonlySet<string>,
): Promise<CanaryObservation | undefined> {
  const current = await findCanaryAlerts(options);
  const created = current.filter((alert) => !preexistingAlertIds.has(canaryAlertId(alert)));
  if (created.length > 1) {
    throw new Error("Multiple current iLert canary alerts exist; refusing to choose one");
  }
  return created[0] ? observeCanaryAlert(options, created[0]) : undefined;
}

async function observeCanaryAlert(
  options: WaitOptions,
  alert: Json,
): Promise<CanaryObservation> {
  const id = canaryAlertId(alert);
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
  const history = actions
    .filter((item) => opaqueId(object(item)?.alertActionId) === options.actionId)
    .flatMap((item) => {
      const value = object(item)?.history;
      return Array.isArray(value) ? value : [];
    })
    .filter((item) => object(item)?.success === true);
  const deliveryIds = new Set(
    history.flatMap((item) => {
      const historyId = opaqueId(object(item)?.id);
      return historyId ? [historyId] : [];
    }),
  );
  return {
    alertId: id,
    deliveries: {
      count: history.length,
      ids: deliveryIds,
      hasCompleteUniqueIds: deliveryIds.size === history.length,
    },
    status: alert?.status,
  };
}

function canaryAlertId(alert: Json): string {
  const id = positiveId(alert.id);
  if (!id) throw new Error("iLert returned a canary alert without an identity");
  return id;
}

interface DeliveryObservation {
  count: number;
  ids: ReadonlySet<string>;
  hasCompleteUniqueIds: boolean;
}

interface CanaryObservation {
  alertId: string;
  deliveries: DeliveryObservation;
  status: unknown;
}

function deliveredAfter(
  observed: CanaryObservation,
  baseline: CanaryObservation,
): boolean {
  if (observed.alertId !== baseline.alertId) return observed.deliveries.count >= 1;
  if (observed.deliveries.count <= baseline.deliveries.count) return false;
  // The iLert history contract provides an optional entry id but no delivery
  // timestamp. When every successful entry has a distinct id, require a new
  // one as well as the append-only count increase.
  if (
    baseline.deliveries.hasCompleteUniqueIds &&
    observed.deliveries.hasCompleteUniqueIds
  ) {
    return [...observed.deliveries.ids].some((id) => !baseline.deliveries.ids.has(id));
  }
  return true;
}

async function findCanaryAlerts(options: WaitOptions): Promise<Json[]> {
  const matches: Json[] = [];
  for (let start = 0; ; start += 100) {
    assertBeforeDeadline(options.deadline);
    const query = new URLSearchParams({
      from: options.startedAt,
      "max-results": "100",
      "start-index": String(start),
    });
    if (options.sourceId) query.append("sources", String(options.sourceId));
    const alerts = await management(
      options.fetchFn,
      options.apiKey,
      `/alerts?${query.toString()}`,
      {},
      options.deadline,
    );
    if (!Array.isArray(alerts) || alerts.some((item) => !object(item))) {
      throw new Error("iLert returned an invalid alert list during the canary");
    }
    matches.push(
      ...alerts.flatMap((item) => {
        const alert = object(item);
        return alert?.alertKey === options.key ? [alert] : [];
      }),
    );
    if (alerts.length < 100) return matches;
  }
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

function relationIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const item of value) {
    const id = positiveNumber(object(item)?.id);
    if (!id) return null;
    ids.push(id);
  }
  return ids;
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
      runAttempt: environment("POSTIL_ILERT_CANARY_RUN_ATTEMPT"),
      runId: environment("POSTIL_ILERT_CANARY_RUN_ID"),
      sourceId,
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
