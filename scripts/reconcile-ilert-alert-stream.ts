#!/usr/bin/env bun

import { appendFile } from "node:fs/promises";

const API_BASE = "https://api.ilert.com/api";
const ACTION_NAME = "Postil operator alert stream";
const REQUEST_TIMEOUT_MS = 7_500;
const REQUEST_ATTEMPTS = 3;
const REQUEST_RETRY_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;
const RECONCILE_DEADLINE_MS = 180_000;
const CANARY_ATTEMPTS = 12;
const CANARY_DISCOVERY_ATTEMPTS = 30;
const CANARY_RETRY_MS = 2_000;
const CANARY_CLEANUP_RETRY_MS = 5_000;
const CANARY_DEADLINE_MS = 360_000;
const CANARY_CLEANUP_RESERVE_MS = 120_000;
const CANARY_FINALIZER_DEADLINE_MS = 600_000;
const CANARY_FINALIZER_DISCOVERY_ATTEMPTS = 61;
const CANARY_FINALIZER_DISCOVERY_RETRY_MS = 10_000;
const CANARY_CLEANUP_ATTEMPTS = 4;
const CANARY_LOOKBACK_MS = 60 * 60 * 1_000;
const CANARY_KEY_PREFIX = "postil-ilert-webhook-canary";

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
type CanaryEventType = "alert-created" | "alert-resolved";

interface Deadline {
  expiresAt: number;
  now: Clock;
}

interface ReconcileOptions {
  apiKey: string;
  integrationKey: string;
  receiverOrigin: string;
  sourceId: number;
  webhookSecret: string;
  dryRun?: boolean;
  fetchFn?: Fetch;
  sleep?: Sleep;
  now?: Clock;
}

interface CanaryOptions {
  alertSubmitted?: boolean;
  apiKey: string;
  integrationKey: string;
  onAlertAttempted?: () => void | Promise<void>;
  onAlertSubmitted?: () => void | Promise<void>;
  receiverOrigin: string;
  runId: string;
  sourceId: number;
  webhookSecret: string;
  fetchFn?: Fetch;
  sleep?: Sleep;
  now?: Clock;
  startedAt?: string;
}

export interface ReconcileResult {
  actionId: string | null;
  operation: Operation;
}

export function canaryAlertKey(runId: string): string {
  if (!positiveId(runId)) {
    throw new Error("GitHub run ID must be a positive integer");
  }
  return `${CANARY_KEY_PREFIX}-${runId}`;
}

export function parseReceiverOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("POSTIL_ILERT_RECEIVER_ORIGIN must be an HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.hostname ||
    value.length > 2_048
  ) {
    throw new Error(
      "POSTIL_ILERT_RECEIVER_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment",
    );
  }
  return parsed.origin;
}

export function desiredAlertAction(
  source: Json,
  secret: string,
  receiverOrigin: string,
): Json {
  return {
    alertSources: [source],
    connectorType: "webhook",
    name: ACTION_NAME,
    triggerMode: "AUTOMATIC",
    triggerTypes: [...ALERT_TRIGGER_TYPES],
    conditions: "",
    params: {
      bodyTemplate: "",
      webhookUrl: webhookUrl(secret, receiverOrigin),
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
    emptyText(actual.conditions) &&
    emptyText(desired.conditions) &&
    left?.webhookUrl === right?.webhookUrl &&
    emptyText(left?.bodyTemplate) &&
    emptyText(right?.bodyTemplate) &&
    hasNoHeaders(left?.headers) &&
    hasNoHeaders(right?.headers)
  );
}

export async function reconcileIlertAlertAction(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const deadline = { expiresAt: now() + RECONCILE_DEADLINE_MS, now };
  const receiverOrigin = parseReceiverOrigin(options.receiverOrigin);
  requireWebhookSecret(options.webhookSecret);
  const source = await loadBoundAlertSource(
    fetchFn,
    options.apiKey,
    options.sourceId,
    deadline,
    sleep,
  );
  const desired = desiredAlertAction(
    source,
    options.webhookSecret,
    receiverOrigin,
  );
  const listed = await listActions(
    fetchFn,
    options.apiKey,
    options.sourceId,
    deadline,
    sleep,
  );
  const summaries = listed.filter((action) => {
    const params = object(action.params);
    return (
      action.name === ACTION_NAME ||
      params?.webhookUrl === object(desired.params)?.webhookUrl
    );
  });
  const actions = await Promise.all(
    summaries.map(async (item) => {
      const id = actionId(item);
      return requireAlertActionId(
        await management(
          fetchFn,
          options.apiKey,
          `/alert-actions/${encodeURIComponent(id)}?include=conditions`,
          {},
          deadline,
          sleep,
        ),
        id,
        "iLert returned an invalid alert action",
      );
    }),
  );
  if (
    actions.some((action) => {
      const actionRelationIds = relationIds(action.alertSources);
      return (
        action.connectorType !== "webhook" ||
        actionRelationIds === null ||
        !sameSet(actionRelationIds, [options.sourceId])
      );
    })
  ) {
    throw new Error(
      "A conflicting Postil alert action exists; refusing to change its type or source scope",
    );
  }
  if (actions.length > 1) {
    throw new Error(
      "Multiple Postil webhook alert actions exist; refusing to choose or delete one",
    );
  }

  const existing = actions[0];
  const operation: Operation = !existing
    ? "create"
    : equivalentAlertAction(existing, desired)
      ? "unchanged"
      : "update";
  if (operation === "unchanged") {
    return { actionId: actionId(existing), operation };
  }
  if (options.dryRun) {
    return { actionId: existing ? actionId(existing) : null, operation };
  }

  await preflightReceiver(
    fetchFn,
    receiverOrigin,
    options.webhookSecret,
    deadline,
    sleep,
  );
  const id = existing ? actionId(existing) : null;
  const result = requireObject(
    await management(
      fetchFn,
      options.apiKey,
      id
        ? `/alert-actions/${encodeURIComponent(id)}?include=conditions`
        : "/alert-actions?include=conditions",
      {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(id ? { ...desired, id } : desired),
      },
      deadline,
      sleep,
    ),
    "iLert returned an invalid alert action",
  );
  const resultId = actionId(result);
  if (id && resultId !== id) {
    throw new Error("iLert returned a different alert action after update");
  }
  const confirmed = requireObject(
    await management(
      fetchFn,
      options.apiKey,
      `/alert-actions/${encodeURIComponent(resultId)}?include=conditions`,
      {},
      deadline,
      sleep,
    ),
    "iLert returned an invalid alert action",
  );
  if (actionId(confirmed) !== resultId) {
    throw new Error("iLert returned a confirmation for a different alert action");
  }
  if (!equivalentAlertAction(confirmed, desired)) {
    throw new Error("iLert did not retain the reconciled alert action");
  }
  return { actionId: resultId, operation };
}

export async function verifyIlertWebhookCanary(
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
  const receiverOrigin = parseReceiverOrigin(options.receiverOrigin);
  requireWebhookSecret(options.webhookSecret);
  await loadBoundAlertSource(
    fetchFn,
    options.apiKey,
    options.sourceId,
    primaryDeadline,
    sleep,
  );
  const key = canaryAlertKey(options.runId);
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
      receiverOrigin,
      sleep,
      startedAt,
    };
    const preexisting = await findCanaryAlerts(waitOptions);
    preexistingAlertIds = new Set(preexisting.map(canaryAlertId));
    for (const alert of preexisting) {
      const observed = canaryObservation(alert);
      if (observed.status === "RESOLVED") continue;
      await resolveAndStabilize(waitOptions, observed, canaryDeadline);
    }
    assertCleanupReserve(canaryDeadline);
    alertAttempted = true;
    await options.onAlertAttempted?.();
    await event(
      fetchFn,
      options.integrationKey,
      "ALERT",
      key,
      primaryDeadline,
      sleep,
    );
    await options.onAlertSubmitted?.();
    created = await waitForCreatedDelivery({
      ...waitOptions,
      preexistingAlertIds,
    });
    await resolveAndStabilize(waitOptions, created, canaryDeadline);
    resolutionConfirmed = true;
  } catch (error) {
    primaryError = error;
  }

  if (alertAttempted && !resolutionConfirmed) {
    try {
      await cleanupAfterAlertAttempt(
        {
          ...options,
          deadline: canaryDeadline,
          fetchFn,
          key,
          receiverOrigin,
          sleep,
          startedAt,
        },
        created,
        preexistingAlertIds,
      );
    } catch (cleanupError) {
      throw new AggregateError(
        primaryError ? [primaryError, cleanupError] : [cleanupError],
        "iLert canary failed and cleanup could not be verified",
      );
    }
  }
  if (primaryError) throw primaryError;
}

export async function finalizeIlertWebhookCanary(
  options: CanaryOptions,
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const deadline: Deadline = {
    expiresAt: now() + CANARY_FINALIZER_DEADLINE_MS,
    now,
  };
  const receiverOrigin = parseReceiverOrigin(options.receiverOrigin);
  requireWebhookSecret(options.webhookSecret);
  const key = canaryAlertKey(options.runId);
  const waitOptions: WaitOptions = {
    ...options,
    deadline,
    fetchFn,
    key,
    receiverOrigin,
    sleep,
    startedAt: options.startedAt ?? new Date(now() - CANARY_LOOKBACK_MS).toISOString(),
  };

  if (options.alertSubmitted === false) return;

  try {
    await loadBoundAlertSource(
      fetchFn,
      options.apiKey,
      options.sourceId,
      deadline,
      sleep,
    );
  } catch (bindingError) {
    try {
      await event(
        fetchFn,
        options.integrationKey,
        "RESOLVE",
        key,
        deadline,
        sleep,
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [bindingError, cleanupError],
        "iLert source verification failed and canary cleanup could not be submitted",
      );
    }
    throw bindingError;
  }

  await event(
    fetchFn,
    options.integrationKey,
    "RESOLVE",
    key,
    deadline,
    sleep,
  );
  const initialCanary = await waitForFinalizerCanaryAlert(waitOptions);
  await resolveAndStabilize(waitOptions, initialCanary, deadline);
}

interface WaitOptions extends CanaryOptions {
  deadline: Deadline;
  fetchFn: Fetch;
  key: string;
  preexistingAlertIds?: ReadonlySet<string>;
  receiverOrigin: string;
  sleep: Sleep;
  startedAt: string;
}

interface CanaryObservation {
  alertId: string;
  status: "PENDING" | "ACCEPTED" | "RESOLVED";
}

async function cleanupAfterAlertAttempt(
  options: WaitOptions,
  created: CanaryObservation | undefined,
  preexistingAlertIds: ReadonlySet<string>,
): Promise<void> {
  let submissionError: unknown;
  try {
    await event(
      options.fetchFn,
      options.integrationKey,
      "RESOLVE",
      options.key,
      options.deadline,
      options.sleep,
    );
  } catch (error) {
    submissionError = error;
  }

  let target = created;
  if (!target) {
    target = await waitForNewCanaryAlert(options, preexistingAlertIds);
  }
  if (target) {
    await resolveAndStabilize(options, target, options.deadline);
  }
  if (submissionError) throw submissionError;
}

async function resolveAndStabilize(
  options: WaitOptions,
  target: CanaryObservation,
  deadline: Deadline,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CANARY_CLEANUP_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline(deadline);
    try {
      await event(
        options.fetchFn,
        options.integrationKey,
        "RESOLVE",
        options.key,
        deadline,
        options.sleep,
      );
      const observed = await observeCanaryAlert(options, target.alertId);
      if (
        observed?.status === "RESOLVED" &&
        await receiverEventReceived(
          options,
          target.alertId,
          "alert-resolved",
        )
      ) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < CANARY_CLEANUP_ATTEMPTS) {
      await options.sleep(
        Math.min(CANARY_CLEANUP_RETRY_MS, remaining(deadline)),
      );
    }
  }
  throw new Error("iLert did not verify canary resolution during stabilization", {
    cause: lastError,
  });
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
    if (
      observed?.status === "PENDING" &&
      await receiverEventReceived(options, observed.alertId, "alert-created")
    ) {
      return observed;
    }
    if (attempt + 1 < CANARY_ATTEMPTS) {
      await options.sleep(Math.min(CANARY_RETRY_MS, remaining(options.deadline)));
    }
  }
  throw new Error("iLert did not confirm persisted Postil webhook delivery");
}

async function waitForFinalizerCanaryAlert(
  options: WaitOptions,
): Promise<CanaryObservation> {
  for (let attempt = 0; attempt < CANARY_FINALIZER_DISCOVERY_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline(options.deadline);
    const matches = await findCanaryAlerts(options);
    if (matches.length > 1) {
      throw new Error("Multiple current iLert canary alerts exist; refusing to choose one");
    }
    if (matches[0]) return canaryObservation(matches[0]);
    if (attempt + 1 < CANARY_FINALIZER_DISCOVERY_ATTEMPTS) {
      await options.sleep(
        Math.min(CANARY_FINALIZER_DISCOVERY_RETRY_MS, remaining(options.deadline)),
      );
    }
  }
  throw new Error(
    "iLert canary cleanup could not establish whether the submitted alert exists",
  );
}

async function waitForNewCanaryAlert(
  options: WaitOptions,
  preexistingAlertIds: ReadonlySet<string>,
): Promise<CanaryObservation | undefined> {
  for (let attempt = 0; attempt < CANARY_DISCOVERY_ATTEMPTS; attempt += 1) {
    const observed = await findNewCanaryAlert(options, preexistingAlertIds);
    if (observed) return observed;
    if (attempt + 1 < CANARY_DISCOVERY_ATTEMPTS) {
      await options.sleep(Math.min(CANARY_RETRY_MS, remaining(options.deadline)));
    }
  }
  return undefined;
}

async function findNewCanaryAlert(
  options: WaitOptions,
  preexistingAlertIds: ReadonlySet<string>,
): Promise<CanaryObservation | undefined> {
  const current = await findCanaryAlerts(options);
  const created = current.filter(
    (alert) => !preexistingAlertIds.has(canaryAlertId(alert)),
  );
  if (created.length > 1) {
    throw new Error("Multiple current iLert canary alerts exist; refusing to choose one");
  }
  return created[0] ? canaryObservation(created[0]) : undefined;
}

async function observeCanaryAlert(
  options: WaitOptions,
  alertId: string,
): Promise<CanaryObservation | undefined> {
  const matches = (await findCanaryAlerts(options)).filter(
    (alert) => canaryAlertId(alert) === alertId,
  );
  if (matches.length > 1) {
    throw new Error("Multiple current iLert canary alerts exist; refusing to choose one");
  }
  return matches[0] ? canaryObservation(matches[0]) : undefined;
}

function canaryObservation(alert: Json): CanaryObservation {
  const status = alert.status;
  if (status !== "PENDING" && status !== "ACCEPTED" && status !== "RESOLVED") {
    throw new Error("iLert returned a canary alert with an invalid status");
  }
  return { alertId: canaryAlertId(alert), status };
}

function canaryAlertId(alert: Json): string {
  const id = positiveId(alert.id);
  if (!id) throw new Error("iLert returned a canary alert without an identity");
  return id;
}

async function findCanaryAlerts(options: WaitOptions): Promise<Json[]> {
  const matches: Json[] = [];
  for (let start = 0; start <= 1_000; start += 100) {
    assertBeforeDeadline(options.deadline);
    const query = new URLSearchParams({
      from: options.startedAt,
      "max-results": "100",
      "start-index": String(start),
      sources: String(options.sourceId),
    });
    const alerts = await management(
      options.fetchFn,
      options.apiKey,
      `/alerts?${query.toString()}`,
      {},
      options.deadline,
      options.sleep,
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
  throw new Error("iLert alert pagination exceeded the safety bound");
}

async function receiverEventReceived(
  options: WaitOptions,
  alertId: string,
  eventType: CanaryEventType,
): Promise<boolean> {
  const query = new URLSearchParams({
    alertId,
    eventType,
    sourceId: String(options.sourceId),
  });
  const response = await requestWithRetry(
    options.fetchFn,
    `${options.receiverOrigin}/api/webhooks/ilert?${query.toString()}`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: basicAuthorization(options.webhookSecret),
      },
    },
    options.deadline,
    options.sleep,
  );
  if (!response.ok) {
    throw new Error(`Postil webhook observation failed with HTTP ${response.status}`);
  }
  const value = object(await parseJson(response));
  if (!value || typeof value.received !== "boolean") {
    throw new Error("Postil returned an invalid webhook observation");
  }
  return value.received;
}

async function preflightReceiver(
  fetchFn: Fetch,
  receiverOrigin: string,
  webhookSecret: string,
  deadline: Deadline,
  sleep: Sleep,
): Promise<void> {
  const response = await requestWithRetry(
    fetchFn,
    `${receiverOrigin}/api/webhooks/ilert`,
    {
      method: "GET",
      headers: { authorization: basicAuthorization(webhookSecret) },
    },
    deadline,
    sleep,
  );
  if (response.status !== 204) {
    throw new Error(`Postil webhook credential preflight failed with HTTP ${response.status}`);
  }
}

async function event(
  fetchFn: Fetch,
  integrationKey: string,
  eventType: "ALERT" | "RESOLVE",
  alertKey: string,
  deadline: Deadline,
  sleep: Sleep,
): Promise<void> {
  const response = await requestWithRetry(
    fetchFn,
    `${API_BASE}/events`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        integrationKey,
        eventType,
        summary:
          eventType === "ALERT"
            ? "Postil iLert webhook canary"
            : "Postil iLert webhook canary resolved",
        ...(eventType === "ALERT"
          ? {
              details:
                "GitHub Actions is verifying the Postil iLert webhook receiver.",
              priority: "HIGH",
            }
          : {}),
        alertKey,
      }),
    },
    deadline,
    sleep,
  );
  if (!response.ok) {
    throw new Error(`iLert event request failed with HTTP ${response.status}`);
  }
}

async function management(
  fetchFn: Fetch,
  apiKey: string,
  path: string,
  init: RequestInit,
  deadline: Deadline,
  sleep: Sleep,
): Promise<unknown> {
  const response = await requestWithRetry(
    fetchFn,
    `${API_BASE}${path}`,
    {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    },
    deadline,
    sleep,
  );
  if (!response.ok) {
    throw new Error(`iLert management request failed with HTTP ${response.status}`);
  }
  return parseJson(response);
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Remote service returned invalid JSON");
  }
}

async function requestWithRetry(
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
  deadline: Deadline,
  sleep: Sleep,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline(deadline);
    const timeout = Math.min(REQUEST_TIMEOUT_MS, remaining(deadline));
    try {
      const response = await fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(timeout),
      });
      if (!transientStatus(response.status) || attempt + 1 >= REQUEST_ATTEMPTS) {
        return response;
      }
      const delay = retryDelay(response, deadline);
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= REQUEST_ATTEMPTS) break;
      await sleep(Math.min(REQUEST_RETRY_MS * (attempt + 1), remaining(deadline)));
    }
  }
  throw new Error("Remote request failed after bounded retries", { cause: lastError });
}

function transientStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function retryDelay(response: Response, deadline: Deadline): number {
  const retryAfter = response.headers.get("retry-after");
  let requested = REQUEST_RETRY_MS;
  if (retryAfter && /^[0-9]+$/u.test(retryAfter)) {
    requested = Number(retryAfter) * 1_000;
  } else if (retryAfter) {
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) requested = Math.max(0, retryAt - deadline.now());
  }
  return Math.min(requested, MAX_RETRY_AFTER_MS, remaining(deadline));
}

async function listActions(
  fetchFn: Fetch,
  apiKey: string,
  sourceId: number,
  deadline: Deadline,
  sleep: Sleep,
): Promise<Json[]> {
  const actions: Json[] = [];
  for (let start = 0; start <= 1_000; start += 100) {
    const query = new URLSearchParams({
      source: String(sourceId),
      "start-index": String(start),
      "max-results": "100",
    });
    const page = await management(
      fetchFn,
      apiKey,
      `/alert-actions?${query.toString()}`,
      {},
      deadline,
      sleep,
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
    `/alert-actions?source=${sourceId}&start-index=1100&max-results=100`,
    {},
    deadline,
    sleep,
  );
  if (!Array.isArray(probe) || probe.some((item) => !object(item))) {
    throw new Error("iLert returned an invalid alert-action list");
  }
  if (probe.length === 0) return actions;
  throw new Error("iLert alert-action pagination exceeded the safety bound");
}

async function loadBoundAlertSource(
  fetchFn: Fetch,
  apiKey: string,
  sourceId: number,
  deadline: Deadline,
  sleep: Sleep,
): Promise<Json> {
  return alertSource(
    await management(
      fetchFn,
      apiKey,
      `/alert-sources/${sourceId}`,
      {},
      deadline,
      sleep,
    ),
    sourceId,
  );
}

function alertSource(
  value: unknown,
  expectedId: number,
): Json {
  const source = requireObject(value, "iLert returned an invalid alert source");
  const policy = object(source.escalationPolicy);
  const id = positiveNumber(source.id);
  if (
    id !== expectedId ||
    !nonempty(source.name) ||
    source.integrationType !== "API" ||
    !nonempty(policy?.name) ||
    !Array.isArray(policy?.escalationRules)
  ) {
    throw new Error("iLert alert source does not match the configured identity");
  }
  return { id };
}

function actionId(value: unknown): string {
  const id = opaqueId(object(value)?.id);
  if (id) return id;
  throw new Error("iLert returned an alert action without an identity");
}

function requireAlertActionId(
  value: unknown,
  expectedId: string,
  invalidMessage: string,
): Json {
  const action = requireObject(value, invalidMessage);
  if (actionId(action) !== expectedId) {
    throw new Error("iLert returned a detail for a different alert action");
  }
  return action;
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

function emptyText(value: unknown): boolean {
  return value === undefined || value === null || value === "";
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

function requireWebhookSecret(secret: string): void {
  if (
    !/^[\x21-\x7e]{32,512}$/u.test(secret) ||
    new Set(secret).size < 4
  ) {
    throw new Error(
      "POSTIL_ILERT_WEBHOOK_SECRET must contain 32 to 512 random printable ASCII bytes",
    );
  }
}

function webhookUrl(secret: string, receiverOrigin: string): string {
  requireWebhookSecret(secret);
  const parsed = new URL(parseReceiverOrigin(receiverOrigin));
  return `https://${encodeURIComponent("postil-ilert")}:${encodeURIComponent(secret)}@${parsed.host}/api/webhooks/ilert`;
}

function basicAuthorization(secret: string): string {
  return `Basic ${Buffer.from(`postil-ilert:${secret}`, "utf8").toString("base64")}`;
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

function environment(
  values: Record<string, string | undefined>,
  name: string,
): string {
  const value = values[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

interface CliOptions {
  args?: string[];
  env?: Record<string, string | undefined>;
  fetchFn?: Fetch;
  sleep?: Sleep;
  now?: Clock;
  log?: (message: string) => void;
}

export async function runCli(options: CliOptions = {}): Promise<void> {
  const args = options.args ?? process.argv.slice(2);
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
  const values = options.env ?? process.env;
  const sourceId = Number(environment(values, "POSTIL_ILERT_ALERT_SOURCE_ID"));
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error("POSTIL_ILERT_ALERT_SOURCE_ID must be a positive integer");
  }
  const shared = {
    apiKey: environment(values, "ILERT_API_KEY"),
    fetchFn: options.fetchFn,
    integrationKey: environment(values, "ILERT_INTEGRATION_KEY"),
    now: options.now,
    receiverOrigin: environment(values, "POSTIL_ILERT_RECEIVER_ORIGIN"),
    sleep: options.sleep,
    sourceId,
    webhookSecret: environment(values, "POSTIL_ILERT_WEBHOOK_SECRET"),
  };
  const log = options.log ?? console.log;

  if (finalizeCanary) {
    await finalizeIlertWebhookCanary({
      ...shared,
      alertSubmitted: canaryAlertSubmission(values),
      runId: environment(values, "POSTIL_ILERT_CANARY_RUN_ID"),
    });
    log("iLert canary cleanup is stabilized");
    return;
  }

  const result = await reconcileIlertAlertAction({ ...shared, dryRun });
  log(`iLert webhook-action reconciliation${dryRun ? " plan" : ""}: ${result.operation}`);
  if (canary) {
    let alertAttempted = false;
    try {
      await verifyIlertWebhookCanary({
        ...shared,
        onAlertAttempted: () => {
          alertAttempted = true;
        },
        onAlertSubmitted: () => recordCanaryAlertSubmission(values, true),
        runId: environment(values, "POSTIL_ILERT_CANARY_RUN_ID"),
      });
    } catch (error) {
      if (!alertAttempted) await recordCanaryAlertSubmission(values, false);
      throw error;
    }
    log("Postil persisted the iLert canary create and resolve webhooks");
  }
}

function canaryAlertSubmission(
  values: Record<string, string | undefined>,
): boolean | undefined {
  const value = values.POSTIL_ILERT_CANARY_ALERT_SUBMITTED;
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("POSTIL_ILERT_CANARY_ALERT_SUBMITTED must be true or false");
}

async function recordCanaryAlertSubmission(
  values: Record<string, string | undefined>,
  submitted: boolean,
): Promise<void> {
  const output = values.GITHUB_OUTPUT;
  if (!output) return;
  await appendFile(output, `alert_submitted=${submitted}\n`, "utf8");
}

if (import.meta.main) await runCli();
