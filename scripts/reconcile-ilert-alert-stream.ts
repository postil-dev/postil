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
const CANARY_FINALIZER_DISCOVERY_DEADLINE_MS = 360_000;
const CANARY_FINALIZER_DISCOVERY_RETRY_MS = 10_000;
const CANARY_CLEANUP_ATTEMPTS = 4;
const SOURCE_BINDING_CLEANUP_RESERVE_MS = 60_000;
const ALERT_REPORT_TIME_SKEW_MS = 5_000;
const CANARY_KEY_PREFIX = "postil-ilert-webhook-canary";
const SOURCE_BINDING_PROBE_PREFIX = "postil-ilert-source-binding";

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
type CanaryHandoff = "true" | "unknown" | "cleaned";

interface Deadline {
  expiresAt: number;
  now: Clock;
}

interface ReconcileOptions {
  apiKey: string;
  integrationKey: string;
  receiverOrigin: string;
  runId?: string;
  sourceId: number;
  webhookSecret: string;
  dryRun?: boolean;
  fetchFn?: Fetch;
  sleep?: Sleep;
  now?: Clock;
}

interface CanaryOptions {
  alertSubmitted?: CanaryHandoff;
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

interface FinalizerOptions {
  alertSubmitted?: CanaryHandoff;
  apiKey: string;
  integrationKey: string;
  runId: string;
  sourceId: number;
  fetchFn?: Fetch;
  sleep?: Sleep;
  now?: Clock;
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

export function sourceBindingProbeKey(runId: string): string {
  if (!positiveId(runId)) {
    throw new Error("GitHub run ID must be a positive integer");
  }
  return `${SOURCE_BINDING_PROBE_PREFIX}-${runId}`;
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
    alertFilter: null,
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
    emptyAlertFilter(actual.alertFilter) &&
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
  const actions = await loadCandidateActions(
    fetchFn,
    options.apiKey,
    desired,
    deadline,
    sleep,
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
  if (options.dryRun) {
    return { actionId: existing ? actionId(existing) : null, operation };
  }

  // The Event API documents that an integration key routes events to its
  // alert source. The management source resource deliberately does not expose
  // that key, so prove the binding before mutating the action.
  await verifyIntegrationBinding({
    apiKey: options.apiKey,
    cleanupDeadline: { expiresAt: deadline.expiresAt, now },
    deadline: { expiresAt: deadline.expiresAt - SOURCE_BINDING_CLEANUP_RESERVE_MS, now },
    fetchFn,
    integrationKey: options.integrationKey,
    key: sourceBindingProbeKey(requireRunId(options.runId)),
    sleep,
    sourceId: options.sourceId,
  });

  await preflightReceiver(
    fetchFn,
    receiverOrigin,
    options.webhookSecret,
    deadline,
    sleep,
  );
  if (operation === "unchanged") {
    return { actionId: actionId(existing), operation };
  }
  const id = existing ? actionId(existing) : null;
  const result = id
    ? requireObject(
      await management(
        fetchFn,
        options.apiKey,
        `/alert-actions/${encodeURIComponent(id)}?include=conditions`,
        { method: "PUT", body: JSON.stringify({ ...desired, id }) },
        deadline,
        sleep,
      ),
      "iLert returned an invalid alert action",
    )
    : await createAlertActionSafely({
      apiKey: options.apiKey,
      deadline,
      desired,
      fetchFn,
      sleep,
    });
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
  let submittedAt = startedAtMs;
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
    const open = await findOpenCanaryAlerts(waitOptions);
    preexistingAlertIds = new Set(open.map(canaryAlertId));
    await resolveAllOpenCanaryAlerts(waitOptions, canaryDeadline);
    assertCleanupReserve(canaryDeadline);
    submittedAt = now();
    const submittedOptions = { ...waitOptions, submittedAt };
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
      ...submittedOptions,
      preexistingAlertIds,
    });
    await resolveAndStabilize(submittedOptions, created, canaryDeadline);
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
          submittedAt,
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
  options: FinalizerOptions,
): Promise<void> {
  // A cleaned handoff is emitted only after the primary path observed the
  // exact persisted create and resolve receiver events. It needs no duplicate
  // management or receiver check.
  if (options.alertSubmitted === "cleaned") return;
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const deadline: Deadline = {
    expiresAt: now() + CANARY_FINALIZER_DEADLINE_MS,
    now,
  };
  const discoveryDeadline: Deadline = {
    expiresAt: now() + CANARY_FINALIZER_DISCOVERY_DEADLINE_MS,
    now,
  };
  const key = canaryAlertKey(options.runId);
  const waitOptions: DeterministicCleanupOptions = {
    ...options,
    deadline,
    fetchFn,
    key,
    sleep,
  };

  // Submit both idempotent cleanup events before management-source validation.
  // A receiver or source-configuration failure must not suppress cleanup.
  await resolveDeterministicKeys(fetchFn, options.integrationKey, [
    key,
    sourceBindingProbeKey(options.runId),
  ], deadline, sleep);

  await loadBoundAlertSource(
    fetchFn,
    options.apiKey,
    options.sourceId,
    deadline,
    sleep,
  );

  await finalizeDeterministicCanaryKeys(
    waitOptions,
    [key, sourceBindingProbeKey(options.runId)],
    discoveryDeadline,
  );
}

interface DeterministicCleanupOptions extends FinalizerOptions {
  deadline: Deadline;
  fetchFn: Fetch;
  key: string;
  sleep: Sleep;
}

interface WaitOptions extends Omit<CanaryOptions, "fetchFn" | "sleep">, DeterministicCleanupOptions {
  preexistingAlertIds?: ReadonlySet<string>;
  startedAt: string;
  submittedAt?: number;
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
  await resolveAllOpenCanaryAlerts(options, options.deadline);
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
      (observed?.status === "PENDING" || observed?.status === "ACCEPTED") &&
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
  const current = await findCurrentCanaryAlerts(options);
  const created = current.filter(
    (alert) =>
      !preexistingAlertIds.has(canaryAlertId(alert)) &&
      (alert.status === "PENDING" || alert.status === "ACCEPTED"),
  );
  return created.length === 1 ? canaryObservation(created[0]!) : undefined;
}

async function observeCanaryAlert(
  options: WaitOptions,
  alertId: string,
): Promise<CanaryObservation | undefined> {
  const matches = (await findCurrentCanaryAlerts(options)).filter(
    (alert) => canaryAlertId(alert) === alertId,
  );
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

async function findOpenCanaryAlerts(options: DeterministicCleanupOptions): Promise<Json[]> {
  return findAlertsByKey({
    apiKey: options.apiKey,
    deadline: options.deadline,
    fetchFn: options.fetchFn,
    key: options.key,
    sleep: options.sleep,
    // The primary canary belongs to the configured source. A binding probe can
    // expose a mismatched integration key only by searching every source.
    sourceId: isSourceBindingProbeKey(options.key) ? undefined : options.sourceId,
    states: ["PENDING", "ACCEPTED"],
  });
}

function isSourceBindingProbeKey(key: string): boolean {
  return key.startsWith(`${SOURCE_BINDING_PROBE_PREFIX}-`);
}

async function findCurrentCanaryAlerts(options: WaitOptions): Promise<Json[]> {
  const submittedAt = options.submittedAt ?? Date.parse(options.startedAt);
  return findAlertsByKey({
    apiKey: options.apiKey,
    deadline: options.deadline,
    fetchFn: options.fetchFn,
    from: reportTime(submittedAt - ALERT_REPORT_TIME_SKEW_MS),
    key: options.key,
    sleep: options.sleep,
    sourceId: options.sourceId,
    until: reportTime(options.deadline.now() + ALERT_REPORT_TIME_SKEW_MS),
  });
}

async function resolveAllOpenCanaryAlerts(
  options: WaitOptions,
  deadline: Deadline,
): Promise<void> {
  for (let pass = 0; pass < CANARY_CLEANUP_ATTEMPTS; pass += 1) {
    const open = await findOpenCanaryAlerts(options);
    if (open.length === 0) return;
    await event(
      options.fetchFn,
      options.integrationKey,
      "RESOLVE",
      options.key,
      deadline,
      options.sleep,
    );
    if (pass + 1 < CANARY_CLEANUP_ATTEMPTS) {
      await options.sleep(Math.min(CANARY_CLEANUP_RETRY_MS, remaining(deadline)));
    }
  }
  throw new Error("iLert did not resolve every open canary alert");
}

async function resolveDeterministicKeys(
  fetchFn: Fetch,
  integrationKey: string,
  keys: readonly string[],
  deadline: Deadline,
  sleep: Sleep,
): Promise<void> {
  const errors: unknown[] = [];
  for (const key of keys) {
    try {
      await event(fetchFn, integrationKey, "RESOLVE", key, deadline, sleep);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "iLert deterministic canary cleanup could not be submitted");
  }
}

async function finalizeDeterministicCanaryKeys(
  options: DeterministicCleanupOptions,
  keys: readonly string[],
  discoveryDeadline: Deadline,
): Promise<void> {
  let discovered = false;
  while (remaining(discoveryDeadline) > 0) {
    assertBeforeDeadline(options.deadline);
    const open = (
      await Promise.all(keys.map((key) => findOpenCanaryAlerts({ ...options, key })))
    ).flat();
    discovered ||= open.length > 0;
    // Event submission is idempotent and protects against a delayed or stale
    // management listing. Keep submitting through the whole settling window.
    await resolveDeterministicKeys(
      options.fetchFn,
      options.integrationKey,
      keys,
      options.deadline,
      options.sleep,
    );
    const delay = Math.min(
      CANARY_FINALIZER_DISCOVERY_RETRY_MS,
      remaining(discoveryDeadline),
      remaining(options.deadline),
    );
    if (delay > 0) await options.sleep(delay);
  }
  if (!discovered) {
    throw new Error("iLert canary cleanup could not account for an accepted or ambiguous submission");
  }
  const stillOpen = (
    await Promise.all(keys.map((key) => findOpenCanaryAlerts({ ...options, key })))
  ).flat();
  if (stillOpen.length > 0) {
    throw new Error("iLert canary cleanup did not clear every deterministic key");
  }
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
  priority?: "HIGH" | "LOW",
  summary = "Postil iLert webhook canary",
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
        summary: eventType === "ALERT" ? summary : `${summary} resolved`,
        ...(eventType === "ALERT"
          ? {
              details:
                "GitHub Actions is verifying the Postil iLert webhook receiver.",
              priority: priority ?? "HIGH",
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

interface IntegrationBindingOptions {
  apiKey: string;
  cleanupDeadline: Deadline;
  deadline: Deadline;
  fetchFn: Fetch;
  integrationKey: string;
  key: string;
  sleep: Sleep;
  sourceId: number;
}

async function verifyIntegrationBinding(
  options: IntegrationBindingOptions,
): Promise<void> {
  const submittedAt = options.deadline.now();
  let alertAttempted = false;
  let primaryError: unknown;
  let preexistingAlertIds = new Set<string>();
  try {
    // Probe keys are deterministic across reruns. Resolve every older open
    // probe globally before sending ALERT, then prove this attempt with a new
    // pending or accepted identity rather than resolved history.
    preexistingAlertIds = new Set((await findAlertsByKey({
      apiKey: options.apiKey,
      deadline: options.deadline,
      fetchFn: options.fetchFn,
      key: options.key,
      sleep: options.sleep,
    })).map(canaryAlertId));
    await resolveAllOpenProbeAlerts(options);
    // A transport error can arrive after iLert commits the event, so cleanup
    // starts once submission is attempted rather than after a response.
    alertAttempted = true;
    await event(
      options.fetchFn,
      options.integrationKey,
      "ALERT",
      options.key,
      options.deadline,
      options.sleep,
      "LOW",
      "Postil Event API source-binding probe",
    );
    const probe = await waitForProbeAlert(options, submittedAt, preexistingAlertIds);
    if (alertSourceId(probe) !== options.sourceId) {
      throw new Error("iLert Event API key does not route to the configured alert source");
    }
  } catch (error) {
    primaryError = error;
  }

  if (alertAttempted) {
    try {
      await resolveProbeAlert(options);
    } catch (cleanupError) {
      throw new AggregateError(
        primaryError ? [primaryError, cleanupError] : [cleanupError],
        "iLert Event API source-binding probe cleanup could not be verified",
      );
    }
  }
  if (primaryError) throw primaryError;
}

async function waitForProbeAlert(
  options: IntegrationBindingOptions,
  submittedAt: number,
  preexistingAlertIds: ReadonlySet<string>,
): Promise<Json> {
  for (let attempt = 0; attempt < CANARY_DISCOVERY_ATTEMPTS; attempt += 1) {
    const matches = await findAlertsByKey({
      apiKey: options.apiKey,
      deadline: options.deadline,
      fetchFn: options.fetchFn,
      from: reportTime(submittedAt - ALERT_REPORT_TIME_SKEW_MS),
      key: options.key,
      sleep: options.sleep,
      until: reportTime(options.deadline.now() + ALERT_REPORT_TIME_SKEW_MS),
    });
    const created = matches.filter((match) => {
      const observation = canaryObservation(match);
      return !preexistingAlertIds.has(observation.alertId) &&
        (observation.status === "PENDING" || observation.status === "ACCEPTED");
    });
    if (created.length === 1) return created[0]!;
    if (created.length > 1) {
      throw new Error("iLert created multiple source-binding probe alerts");
    }
    if (attempt + 1 < CANARY_DISCOVERY_ATTEMPTS) {
      await options.sleep(Math.min(CANARY_RETRY_MS, remaining(options.deadline)));
    }
  }
  throw new Error("iLert did not expose the source-binding probe alert");
}

async function resolveProbeAlert(
  options: IntegrationBindingOptions,
): Promise<void> {
  // An ALERT transport result can be ambiguous. Submit the same-key cleanup
  // before relying on management visibility, then keep retrying stale reads.
  await event(
    options.fetchFn,
    options.integrationKey,
    "RESOLVE",
    options.key,
    options.cleanupDeadline,
    options.sleep,
    undefined,
    "Postil Event API source-binding probe",
  );
  await resolveAllOpenProbeAlerts({
    ...options,
    deadline: options.cleanupDeadline,
  });
}

async function resolveAllOpenProbeAlerts(
  options: Pick<IntegrationBindingOptions, "apiKey" | "fetchFn" | "integrationKey" | "key" | "sleep"> & { deadline: Deadline },
): Promise<void> {
  for (let attempt = 0; attempt < CANARY_CLEANUP_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline(options.deadline);
    const matches = await findAlertsByKey({
      apiKey: options.apiKey,
      deadline: options.deadline,
      fetchFn: options.fetchFn,
      key: options.key,
      sleep: options.sleep,
      states: ["PENDING", "ACCEPTED"],
    });
    if (matches.length === 0) return;
    try {
      await event(
        options.fetchFn,
        options.integrationKey,
        "RESOLVE",
        options.key,
        options.deadline,
        options.sleep,
        undefined,
        "Postil Event API source-binding probe",
      );
    } catch (error) {
      if (attempt + 1 >= CANARY_CLEANUP_ATTEMPTS) throw error;
    }
    if (attempt + 1 < CANARY_CLEANUP_ATTEMPTS) {
      await options.sleep(Math.min(CANARY_CLEANUP_RETRY_MS, remaining(options.deadline)));
    }
  }
  throw new Error("iLert did not verify source-binding probe resolution");
}

interface AlertKeyLookupOptions {
  apiKey: string;
  deadline: Deadline;
  fetchFn: Fetch;
  from?: string;
  key: string;
  sleep: Sleep;
  sourceId?: number;
  states?: readonly ("PENDING" | "ACCEPTED" | "RESOLVED")[];
  until?: string;
}

async function findAlertsByKey(options: AlertKeyLookupOptions): Promise<Json[]> {
  const matches: Json[] = [];
  for (let start = 0; ; start += 100) {
    assertBeforeDeadline(options.deadline);
    const query = new URLSearchParams({
      "max-results": "100",
      "start-index": String(start),
    });
    if (options.sourceId) query.append("sources", String(options.sourceId));
    if (options.from) query.append("from", options.from);
    for (const state of options.states ?? []) query.append("states", state);
    if (options.until) query.append("until", options.until);
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
    matches.push(...alerts.flatMap((item) => {
      const alert = object(item);
      return alert?.alertKey === options.key &&
          (options.states === undefined || options.states.includes(
            alert.status as "PENDING" | "ACCEPTED" | "RESOLVED",
          ))
        ? [alert]
        : [];
    }));
    if (alerts.length < 100) return matches;
  }
}

function alertSourceId(alert: Json): number | null {
  return positiveNumber(object(alert.alertSource)?.id);
}

interface CreateAlertActionOptions {
  apiKey: string;
  deadline: Deadline;
  desired: Json;
  fetchFn: Fetch;
  sleep: Sleep;
}

async function createAlertActionSafely(
  options: CreateAlertActionOptions,
): Promise<Json> {
  try {
    return requireObject(
      await managementOnce(
        options.fetchFn,
        options.apiKey,
        "/alert-actions?include=conditions",
        { method: "POST", body: JSON.stringify(options.desired) },
        options.deadline,
      ),
      "iLert returned an invalid alert action",
    );
  } catch (error) {
    const candidates = await loadCandidateActions(
      options.fetchFn,
      options.apiKey,
      options.desired,
      options.deadline,
      options.sleep,
    );
    const equivalent = candidates.filter((candidate) =>
      equivalentAlertAction(candidate, options.desired)
    );
    if (equivalent.length === 1) return equivalent[0]!;
    throw new Error(
      "iLert alert-action creation was ambiguous; refusing to submit a second POST",
      { cause: error },
    );
  }
}

async function managementOnce(
  fetchFn: Fetch,
  apiKey: string,
  path: string,
  init: RequestInit,
  deadline: Deadline,
): Promise<unknown> {
  assertBeforeDeadline(deadline);
  let response: Response;
  try {
    response = await fetchFn(`${API_BASE}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining(deadline))),
    });
  } catch (error) {
    throw new Error("iLert alert-action creation request is ambiguous", { cause: error });
  }
  if (!response.ok) {
    throw new Error(`iLert alert-action creation request is ambiguous after HTTP ${response.status}`);
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
  deadline: Deadline,
  sleep: Sleep,
): Promise<Json[]> {
  const actions: Json[] = [];
  for (let start = 0; ; start += 100) {
    const query = new URLSearchParams({
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
}

async function loadCandidateActions(
  fetchFn: Fetch,
  apiKey: string,
  desired: Json,
  deadline: Deadline,
  sleep: Sleep,
): Promise<Json[]> {
  const webhook = object(desired.params)?.webhookUrl;
  const summaries = (await listActions(fetchFn, apiKey, deadline, sleep))
    .filter((action) => {
      const params = object(action.params);
      return action.name === ACTION_NAME || params?.webhookUrl === webhook;
    });
  return Promise.all(summaries.map(async (item) => {
    const id = actionId(item);
    return requireAlertActionId(
      await management(
        fetchFn,
        apiKey,
        `/alert-actions/${encodeURIComponent(id)}?include=conditions`,
        {},
        deadline,
        sleep,
      ),
      id,
      "iLert returned an invalid alert action",
    );
  }));
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

function requireRunId(value: string | undefined): string {
  if (!value || !positiveId(value)) {
    throw new Error("POSTIL_ILERT_CANARY_RUN_ID must be a positive integer for live reconciliation");
  }
  return value;
}

function reportTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
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

function emptyAlertFilter(value: unknown): boolean {
  return value === undefined || value === null ||
    (object(value) !== null && Object.keys(object(value)!).length === 0);
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
  if (!dryRun && !canary && !finalizeCanary) {
    throw new Error(
      "usage: live reconciliation requires --canary because it needs a recoverable run identity; use --dry-run to preview",
    );
  }
  const values = options.env ?? process.env;
  const log = options.log ?? console.log;
  const runId = canary || finalizeCanary
    ? environment(values, "POSTIL_ILERT_CANARY_RUN_ID")
    : undefined;

  if (finalizeCanary) {
    const alertSubmitted = canaryAlertSubmission(values);
    await finalizeIlertWebhookCanary({
      alertSubmitted,
      apiKey: environment(values, "ILERT_API_KEY"),
      fetchFn: options.fetchFn,
      integrationKey: environment(values, "ILERT_INTEGRATION_KEY"),
      now: options.now,
      runId: runId!,
      sleep: options.sleep,
      sourceId: requiredSourceId(values),
    });
    log("iLert canary cleanup is stabilized");
    return;
  }

  const sourceId = requiredSourceId(values);
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
  if (canary) await recordCanaryAlertSubmission(values, "unknown");
  const result = await reconcileIlertAlertAction({ ...shared, dryRun, runId });
  log(`iLert webhook-action reconciliation${dryRun ? " plan" : ""}: ${result.operation}`);
  if (canary) {
    try {
      await verifyIlertWebhookCanary({
        ...shared,
        onAlertAttempted: () => recordCanaryAlertSubmission(values, "unknown"),
        onAlertSubmitted: () => recordCanaryAlertSubmission(values, "true"),
        runId: runId!,
      });
    } catch (error) {
      // `unknown` keeps the independent finalizer responsible for discovery
      // and cleanup when pre-clean or ALERT submission is inconclusive.
      await recordCanaryAlertSubmission(values, "unknown");
      throw error;
    }
    await recordCanaryAlertSubmission(values, "cleaned");
    log("Postil persisted the iLert canary create and resolve webhooks");
  }
}

function requiredSourceId(values: Record<string, string | undefined>): number {
  const sourceId = Number(environment(values, "POSTIL_ILERT_ALERT_SOURCE_ID"));
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error("POSTIL_ILERT_ALERT_SOURCE_ID must be a positive integer");
  }
  return sourceId;
}

function canaryAlertSubmission(
  values: Record<string, string | undefined>,
): CanaryHandoff | undefined {
  const value = values.POSTIL_ILERT_CANARY_ALERT_SUBMITTED;
  if (value === undefined || value === "") return undefined;
  if (value === "true") return "true";
  if (value === "unknown" || value === "cleaned") return value;
  throw new Error("POSTIL_ILERT_CANARY_ALERT_SUBMITTED must be true, unknown, or cleaned");
}

async function recordCanaryAlertSubmission(
  values: Record<string, string | undefined>,
  submitted: CanaryHandoff,
): Promise<void> {
  const output = values.GITHUB_OUTPUT;
  if (!output) return;
  await appendFile(output, `alert_submitted=${submitted}\n`, "utf8");
}

if (import.meta.main) await runCli();
