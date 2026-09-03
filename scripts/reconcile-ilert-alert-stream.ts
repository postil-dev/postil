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
const CANARY_FINALIZER_TERMINAL_INVENTORY_MS = 60_000;
const CANARY_FINALIZER_TERMINAL_INVENTORY_MAX_PAGES = 20;
const CANARY_CLEANUP_ATTEMPTS = 4;
const ALERT_REPORT_TIME_SKEW_MS = 5_000;
// GitHub permits the initial workflow run plus 50 reruns.
const MAX_CANARY_RUN_ATTEMPT = 51;
const FINALIZER_STABLE_EMPTY_SCANS = 2;
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
  runAttempt?: string;
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
  runAttempt: string;
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
  runAttempt: string;
  sweepAttempt?: string;
  sourceId: number;
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
  const identity = canaryRunIdentity(runId, runAttempt);
  return `${CANARY_KEY_PREFIX}-${identity.runId}-${identity.runAttempt}`;
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
  const source = await loadIntegrationBoundAlertSource(
    fetchFn,
    options.apiKey,
    options.integrationKey,
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
  const existing = reservedCandidate(actions, desired, options.sourceId);
  const operation: Operation = !existing
    ? "create"
    : equivalentAlertAction(existing, desired)
      ? "unchanged"
      : "update";
  if (options.dryRun) {
    return { actionId: existing ? actionId(existing) : null, operation };
  }
  const identity = requireCanaryRunIdentity(options.runId, options.runAttempt);
  await precleanPriorAttemptKeys({
    apiKey: options.apiKey,
    deadline,
    fetchFn,
    integrationKey: options.integrationKey,
    runAttempt: identity.runAttempt,
    runId: identity.runId,
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
      sourceId: options.sourceId,
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
  const identity = canaryRunIdentity(options.runId, options.runAttempt);
  const startedAtMs = now();
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
  await loadIntegrationBoundAlertSource(
    fetchFn,
    options.apiKey,
    options.integrationKey,
    options.sourceId,
    primaryDeadline,
    sleep,
  );
  await precleanPriorAttemptKeys({
    apiKey: options.apiKey,
    deadline: primaryDeadline,
    fetchFn,
    integrationKey: options.integrationKey,
    runAttempt: identity.runAttempt,
    runId: identity.runId,
    sleep,
    sourceId: options.sourceId,
  });
  const key = canaryAlertKey(identity.runId, String(identity.runAttempt));
  let alertAttempted = false;
  let resolutionConfirmed = false;
  let created: CanaryTarget | undefined;
  let acceptedAt = startedAtMs;
  let primaryError: unknown;
  try {
    assertCleanupReserve(canaryDeadline);
    const submittedOptions: WaitOptions = {
      apiKey: options.apiKey,
      deadline: primaryDeadline,
      fetchFn,
      integrationKey: options.integrationKey,
      key,
      receiverOrigin,
      sleep,
      sourceId: options.sourceId,
      acceptedAt,
      webhookSecret: options.webhookSecret,
    };
    alertAttempted = true;
    await options.onAlertAttempted?.();
    acceptedAt = now();
    await event(
      fetchFn,
      options.integrationKey,
      "ALERT",
      key,
      primaryDeadline,
      sleep,
    );
    submittedOptions.acceptedAt = acceptedAt;
    await options.onAlertSubmitted?.();
    created = await waitForCreatedDelivery(submittedOptions);
    await resolveAndStabilize(submittedOptions, created, canaryDeadline);
    resolutionConfirmed = true;
  } catch (error) {
    primaryError = error;
    created ??= invalidCanaryAlertTarget(error);
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
          acceptedAt,
          sourceId: options.sourceId,
          webhookSecret: options.webhookSecret,
        },
        created,
      );
    } catch (cleanupError) {
      if (primaryError instanceof InvalidCanaryAlertValidationError) throw primaryError;
      if (cleanupError instanceof InvalidCanaryAlertValidationError) throw cleanupError;
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
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const identity = canaryRunIdentity(options.runId, options.runAttempt);
  const sweepAttempt = canaryRunIdentity(options.runId, options.sweepAttempt ?? options.runAttempt)
    .runAttempt;
  const deadline: Deadline = {
    expiresAt: now() + CANARY_FINALIZER_DEADLINE_MS,
    now,
  };
  const discoveryDeadline: Deadline = {
    expiresAt: now() + CANARY_FINALIZER_DISCOVERY_DEADLINE_MS,
    now,
  };
  const cleanup: CleanupOptions = {
    apiKey: options.apiKey,
    deadline,
    fetchFn,
    integrationKey: options.integrationKey,
    sleep,
  };
  await loadIntegrationBoundAlertSource(
    fetchFn,
    options.apiKey,
    options.integrationKey,
    options.sourceId,
    deadline,
    sleep,
  );
  const keys = deterministicCanaryKeys(
    identity.runId,
    sweepAttempt,
    options.sourceId,
  );
  const handoff = options.alertSubmitted ?? "unknown";
  const currentMain = keys.find((key) => key.runAttempt === identity.runAttempt);
  if (!currentMain) {
    throw new Error("iLert canary cleanup could not reconstruct the producer attempt");
  }
  const currentWindow = handoff === "true"
    ? finalizerCurrentAttemptWindow(options.startedAt)
    : undefined;

  await finalizeDeterministicCanaryKeys(
    cleanup,
    keys,
    discoveryDeadline,
    handoff,
    currentMain,
    currentWindow,
  );
}

interface CleanupOptions {
  apiKey: string;
  deadline: Deadline;
  fetchFn: Fetch;
  integrationKey: string;
  sleep: Sleep;
}

interface WaitOptions extends CleanupOptions {
  key: string;
  receiverOrigin: string;
  sourceId: number;
  acceptedAt: number;
  webhookSecret: string;
}

interface CanaryTarget {
  alertId: string;
  alertKey: string;
  sourceId: number;
}

interface CanaryObservation extends CanaryTarget {
  priority: "HIGH" | "LOW";
  status: "PENDING" | "ACCEPTED" | "RESOLVED";
}

class InvalidCanaryAlertValidationError extends Error {
  constructor(message: string, readonly target?: CanaryTarget) {
    super(message);
  }
}

class InvalidCanaryAlertStatusError extends InvalidCanaryAlertValidationError {
  constructor(readonly target: CanaryTarget) {
    super("iLert returned a canary alert with an invalid status", target);
  }
}

class InvalidCanaryAlertPriorityError extends InvalidCanaryAlertValidationError {
  constructor(readonly target: CanaryTarget) {
    super("iLert returned a canary alert with an invalid priority", target);
  }
}

class InvalidCanaryAlertIdentityError extends InvalidCanaryAlertValidationError {}

interface DeterministicCanaryKey {
  key: string;
  runAttempt: number;
  sourceId: number;
}

interface ReportTimeWindow {
  from: string;
  until: string;
}

async function cleanupAfterAlertAttempt(
  options: WaitOptions,
  created: CanaryTarget | undefined,
): Promise<void> {
  let submissionError: unknown;
  try {
    if (!created) {
      await event(
        options.fetchFn,
        options.integrationKey,
        "RESOLVE",
        options.key,
        options.deadline,
        options.sleep,
      );
    }
  } catch (error) {
    submissionError = error;
  }

  let target = created;
  if (!target) {
    target = await waitForSubmittedAlert(
      options,
      ["PENDING", "ACCEPTED", "RESOLVED"],
    );
  }
  if (target) {
    await driveAlertToResolved(options, target, options.deadline);
  } else {
    throw new Error("iLert could not identify the attempted canary alert for cleanup", {
      cause: submissionError,
    });
  }
}

async function resolveAndStabilize(
  options: WaitOptions,
  target: CanaryTarget,
  deadline: Deadline,
): Promise<void> {
  let lastError: unknown;
  const cleanupOptions = { ...options, deadline };
  for (let attempt = 0; attempt < CANARY_CLEANUP_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline(deadline);
    try {
      await resolveAlertById(cleanupOptions, target.alertId);
      const observed = await observeAlertById(cleanupOptions, target);
      if (
        observed.status === "RESOLVED" &&
        await receiverEventReceived(
          cleanupOptions,
          target.alertId,
          "alert-resolved",
        )
      ) {
        return;
      }
    } catch (error) {
      if (error instanceof InvalidCanaryAlertValidationError) throw error;
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
    const observed = await findSubmittedAlert(
      options,
      ["PENDING", "ACCEPTED"],
    );
    if (
      (observed?.status === "PENDING" || observed?.status === "ACCEPTED") &&
      observed.priority === "HIGH" &&
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

async function waitForSubmittedAlert(
  options: WaitOptions,
  states: readonly ("PENDING" | "ACCEPTED" | "RESOLVED")[],
): Promise<CanaryObservation | undefined> {
  for (let attempt = 0; attempt < CANARY_DISCOVERY_ATTEMPTS; attempt += 1) {
    const observed = await findSubmittedAlert(options, states);
    if (observed) return observed;
    if (attempt + 1 < CANARY_DISCOVERY_ATTEMPTS) {
      await options.sleep(Math.min(CANARY_RETRY_MS, remaining(options.deadline)));
    }
  }
  return undefined;
}

async function findSubmittedAlert(
  options: WaitOptions,
  states: readonly ("PENDING" | "ACCEPTED" | "RESOLVED")[],
): Promise<CanaryObservation | undefined> {
  const current = await findAlertsByKey({
    apiKey: options.apiKey,
    deadline: options.deadline,
    fetchFn: options.fetchFn,
    ...submissionWindow(options.acceptedAt, options.deadline.now()),
    key: options.key,
    sleep: options.sleep,
    sourceId: options.sourceId,
    states,
  });
  if (current.length > 1) {
    throw new Error("iLert created multiple alerts for one canary attempt");
  }
  return current[0]
    ? canaryObservation(current[0], options.key, options.sourceId)
    : undefined;
}

async function observeAlertById(
  options: CleanupOptions,
  target: CanaryTarget,
): Promise<CanaryObservation> {
  const alert = requireObject(
    await management(
      options.fetchFn,
      options.apiKey,
      `/alerts/${encodeURIComponent(target.alertId)}`,
      {},
      options.deadline,
      options.sleep,
    ),
    "iLert returned an invalid canary alert detail",
  );
  if (canaryAlertId(alert) !== target.alertId) {
    throw new Error("iLert returned a detail for a different canary alert");
  }
  return canaryObservation(alert, target.alertKey, target.sourceId);
}

function canaryObservation(
  alert: Json,
  expectedKey: string,
  expectedSourceId?: number,
): CanaryObservation {
  if (alert.alertKey !== expectedKey) {
    throw new Error("iLert returned a canary alert with a different key");
  }
  const alertId = positiveId(alert.id);
  const observedSourceId = alertSourceId(alert);
  const target = alertId && (observedSourceId ?? expectedSourceId)
    ? {
      alertId,
      alertKey: expectedKey,
      sourceId: observedSourceId ?? expectedSourceId!,
    }
    : undefined;
  if (!alertId) {
    throw new InvalidCanaryAlertIdentityError(
      "iLert returned a canary alert without an identity",
      target,
    );
  }
  if (!observedSourceId) {
    throw new InvalidCanaryAlertIdentityError(
      "iLert returned a canary alert without a valid source",
      target,
    );
  }
  if (expectedSourceId !== undefined && observedSourceId !== expectedSourceId) {
    throw new InvalidCanaryAlertIdentityError(
      "iLert returned a canary alert from a different source",
      target,
    );
  }
  const exactTarget: CanaryTarget = {
    alertId,
    alertKey: expectedKey,
    sourceId: observedSourceId,
  };
  const priority = alert.priority;
  if (priority !== "HIGH" && priority !== "LOW") {
    throw new InvalidCanaryAlertPriorityError(exactTarget);
  }
  const status = alert.status;
  if (status !== "PENDING" && status !== "ACCEPTED" && status !== "RESOLVED") {
    throw new InvalidCanaryAlertStatusError(exactTarget);
  }
  return { ...exactTarget, priority, status };
}

function invalidCanaryAlertTarget(error: unknown): CanaryTarget | undefined {
  return invalidCanaryAlertValidationError(error)?.target;
}

function invalidCanaryAlertValidationError(
  error: unknown,
  seen = new Set<unknown>(),
): InvalidCanaryAlertValidationError | undefined {
  if (error instanceof InvalidCanaryAlertValidationError) return error;
  if (Array.isArray(error)) {
    for (const nested of error) {
      const validationError = invalidCanaryAlertValidationError(nested, seen);
      if (validationError) return validationError;
    }
    return undefined;
  }
  if (!error || typeof error !== "object" || seen.has(error)) return undefined;
  seen.add(error);
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const validationError = invalidCanaryAlertValidationError(nested, seen);
      if (validationError) return validationError;
    }
  }
  if (error instanceof Error) {
    return invalidCanaryAlertValidationError(error.cause, seen);
  }
  return undefined;
}

function canaryAlertId(alert: Json): string {
  const id = positiveId(alert.id);
  if (!id) throw new Error("iLert returned a canary alert without an identity");
  return id;
}

async function driveAlertToResolved(
  options: CleanupOptions,
  target: CanaryTarget,
  deadline: Deadline,
): Promise<void> {
  let lastError: unknown;
  let invalidValidationError: InvalidCanaryAlertValidationError | undefined;
  for (let attempt = 0; attempt < CANARY_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await resolveAlertById(options, target.alertId);
      const observed = await observeAlertById(options, target);
      if (observed.status === "RESOLVED") {
        if (invalidValidationError) throw invalidValidationError;
        return;
      }
    } catch (error) {
      if (error instanceof InvalidCanaryAlertValidationError) {
        invalidValidationError ??= error;
      }
      lastError = error;
    }
    if (attempt + 1 < CANARY_CLEANUP_ATTEMPTS) {
      await options.sleep(Math.min(CANARY_CLEANUP_RETRY_MS, remaining(deadline)));
    }
  }
  if (invalidValidationError) throw invalidValidationError;
  throw new Error("iLert did not resolve the canary alert", {
    cause: lastError,
  });
}

async function precleanPriorAttemptKeys(
  options: CleanupOptions & {
    runAttempt: number;
    runId: string;
    sourceId: number;
  },
): Promise<void> {
  if (options.runAttempt === 1) return;
  const keys = deterministicCanaryKeys(
    options.runId,
    options.runAttempt - 1,
    options.sourceId,
  );
  const targets = new Map<string, CanaryTarget>();
  let stableEmptyScans = 0;
  let lastErrors: unknown[] = [];
  let invalidValidationError: InvalidCanaryAlertValidationError | undefined;

  for (let pass = 0; pass < CANARY_CLEANUP_ATTEMPTS; pass += 1) {
    const discovered = await discoverOpenDeterministicAlerts(options, keys);
    rememberTargets(targets, discovered.alerts);
    lastErrors = discovered.errors;
    invalidValidationError ??= discovered.validationError;
    stableEmptyScans = discovered.complete && discovered.open === 0
      ? stableEmptyScans + 1
      : 0;
    await resolveKnownAlerts(options, targets);
    const observed = await observeKnownAlerts(options, targets);
    lastErrors = [...lastErrors, ...observed.errors];
    invalidValidationError ??= invalidCanaryAlertValidationError(observed.errors);
    if (!invalidValidationError && stableEmptyScans >= FINALIZER_STABLE_EMPTY_SCANS && observed.allResolved) {
      return;
    }
    if (pass + 1 < CANARY_CLEANUP_ATTEMPTS) {
      await options.sleep(Math.min(CANARY_CLEANUP_RETRY_MS, remaining(options.deadline)));
    }
  }
  if (invalidValidationError) throw invalidValidationError;
  throw new AggregateError(
    lastErrors,
    "iLert did not stabilize prior-attempt canary cleanup",
  );
}

async function finalizeDeterministicCanaryKeys(
  options: CleanupOptions,
  keys: readonly DeterministicCanaryKey[],
  discoveryDeadline: Deadline,
  handoff: CanaryHandoff,
  currentMain: DeterministicCanaryKey,
  currentWindow: ReportTimeWindow | undefined,
): Promise<void> {
  const targets = new Map<string, CanaryTarget>();
  // The producer's persisted create-and-resolve proof accounts for the first
  // alert, but a retry-ambiguous Event API submission can materialize later.
  // Continue the full inventory sweep for that delayed duplicate.
  let currentAccountedFor = handoff === "cleaned";
  let currentResolveSubmitted = false;
  let fatalError: unknown;
  let invalidValidationError: InvalidCanaryAlertValidationError | undefined;
  let validationContextErrors: unknown[] = [];
  let recentErrors: unknown[] = [];

  const retainErrors = (errors: readonly unknown[]) => {
    if (errors.length > 0) recentErrors = [...recentErrors, ...errors].slice(-20);
  };
  const retainInvalidValidation = (errors: readonly unknown[]) => {
    const validationError = invalidCanaryAlertValidationError(errors);
    if (!validationError) return;
    invalidValidationError ??= validationError;
    validationContextErrors = [...validationContextErrors, ...errors].slice(-20);
  };
  const discover = async (
    deadline: Deadline,
    maxPages?: number,
  ): Promise<{ complete: boolean; open: number }> => {
    const result = await discoverOpenDeterministicAlerts(
      { ...options, deadline },
      keys,
      maxPages,
    );
    rememberTargets(targets, result.alerts);
    retainErrors(result.errors);
    retainInvalidValidation(result.errors);
    if (result.validationError && !invalidValidationError) {
      invalidValidationError = result.validationError;
      validationContextErrors = [...validationContextErrors, result.validationError].slice(-20);
    }
    if (handoff === "true" && !currentAccountedFor && currentWindow) {
      try {
        const current = await findAlertsByKey({
          apiKey: options.apiKey,
          deadline,
          fetchFn: options.fetchFn,
          ...currentWindow,
          key: currentMain.key,
          maxPages,
          onTarget: (target) => targets.set(target.alertId, target),
          sleep: options.sleep,
          sourceId: currentMain.sourceId,
        });
        if (current.length > 1) {
          fatalError = new Error("iLert returned multiple current-attempt canary alerts");
        } else if (current[0]) {
          const observed = canaryObservation(
            current[0],
            currentMain.key,
            currentMain.sourceId,
          );
          if (observed.priority !== "HIGH") {
            fatalError = new Error("iLert persisted the current canary at non-HIGH priority");
          }
          targets.set(observed.alertId, observed);
          currentAccountedFor = true;
        }
      } catch (error) {
        const target = invalidCanaryAlertTarget(error);
        if (target) targets.set(target.alertId, target);
        retainInvalidValidation([error]);
        retainErrors([error]);
      }
    }
    if (
      handoff !== "cleaned" &&
      !currentResolveSubmitted &&
      ![...targets.values()].some((target) => target.alertKey === currentMain.key)
    ) {
      try {
        await event(
          options.fetchFn,
          options.integrationKey,
          "RESOLVE",
          currentMain.key,
          options.deadline,
          options.sleep,
        );
        currentResolveSubmitted = true;
        if (handoff === "unknown") currentAccountedFor = true;
      } catch (error) {
        retainErrors([error]);
      }
    }
    return { complete: result.complete, open: result.open };
  };

  while (remaining(discoveryDeadline) > 0) {
    await discover(discoveryDeadline);
    const resolved = await resolveKnownAlerts(options, targets);
    retainErrors(resolved.errors);
    const observed = await observeKnownAlerts(options, targets);
    retainErrors(observed.errors);
    retainInvalidValidation(observed.errors);
    if (handoff === "unknown" && currentTargetResolved(currentMain.key, targets, resolved, observed)) {
      currentAccountedFor = true;
    }
    const delay = Math.min(
      CANARY_FINALIZER_DISCOVERY_RETRY_MS,
      remaining(discoveryDeadline),
      remaining(options.deadline),
    );
    if (delay > 0) await options.sleep(delay);
  }

  let inventoryIncomplete = false;
  let stableEmptyScans = 0;

  while (remaining(options.deadline) > CANARY_CLEANUP_RESERVE_MS) {
    const terminalDeadline: Deadline = {
      expiresAt: Math.min(
        options.deadline.expiresAt - CANARY_CLEANUP_RESERVE_MS,
        options.deadline.now() + CANARY_FINALIZER_TERMINAL_INVENTORY_MS,
      ),
      now: options.deadline.now,
    };
    if (remaining(terminalDeadline) <= 0) break;
    const terminalDiscovery = await discover(
      terminalDeadline,
      CANARY_FINALIZER_TERMINAL_INVENTORY_MAX_PAGES,
    );
    // A later complete, empty scan proves recovery from a transient inventory
    // failure. Any incomplete or non-empty scan resets that proof.
    inventoryIncomplete = !terminalDiscovery.complete;
    stableEmptyScans = terminalDiscovery.complete && terminalDiscovery.open === 0
      ? stableEmptyScans + 1
      : 0;
    const resolved = await resolveKnownAlerts(options, targets);
    retainErrors(resolved.errors);
    const observed = await observeKnownAlerts(options, targets);
    retainErrors(observed.errors);
    retainInvalidValidation(observed.errors);
    if (handoff === "unknown" && currentTargetResolved(currentMain.key, targets, resolved, observed)) {
      currentAccountedFor = true;
    }
    if (
      !fatalError &&
      !invalidValidationError &&
      !inventoryIncomplete &&
      currentAccountedFor &&
      observed.allResolved &&
      stableEmptyScans >= FINALIZER_STABLE_EMPTY_SCANS
    ) {
      return;
    }
    const delay = Math.min(
      CANARY_CLEANUP_RETRY_MS,
      remaining(options.deadline) - CANARY_CLEANUP_RESERVE_MS,
    );
    if (delay > 0) await options.sleep(delay);
  }

  while (remaining(options.deadline) > 0) {
    const resolved = await resolveKnownAlerts(options, targets);
    retainErrors(resolved.errors);
    const observed = await observeKnownAlerts(options, targets);
    retainErrors(observed.errors);
    retainInvalidValidation(observed.errors);
    if (handoff === "unknown" && currentTargetResolved(currentMain.key, targets, resolved, observed)) {
      currentAccountedFor = true;
    }
    const delay = Math.min(CANARY_CLEANUP_RETRY_MS, remaining(options.deadline));
    if (delay > 0) await options.sleep(delay);
  }

  if (invalidValidationError) {
    const context = validationContextErrors.filter(
      (error) => error !== invalidValidationError,
    );
    if (context.length > 0) {
      throw new AggregateError(
        [invalidValidationError, ...context],
        `iLert canary cleanup encountered ${invalidValidationError.message}`,
      );
    }
    throw invalidValidationError;
  }
  if (inventoryIncomplete) {
    throw new AggregateError(
      recentErrors,
      "iLert canary cleanup inventory was incomplete",
    );
  }
  if (fatalError) {
    throw new Error("iLert canary cleanup found an invalid current-attempt identity", {
      cause: fatalError,
    });
  }
  if (!currentAccountedFor) {
    throw new AggregateError(
      recentErrors,
      "iLert canary cleanup could not account for the accepted current-attempt submission",
    );
  }
  throw new AggregateError(
    recentErrors,
    "iLert canary cleanup did not verify every discovered alert as RESOLVED",
  );
}

async function discoverOpenDeterministicAlerts(
  options: CleanupOptions,
  keys: readonly DeterministicCanaryKey[],
  maxPages?: number,
): Promise<{
  alerts: CanaryTarget[];
  complete: boolean;
  errors: unknown[];
  open: number;
  validationError?: InvalidCanaryAlertValidationError;
}> {
  const alerts: CanaryTarget[] = [];
  const errors: unknown[] = [];
  let open = 0;
  let validationError: InvalidCanaryAlertValidationError | undefined;
  const groups = [keys];
  for (const group of groups) {
    if (group.length === 0) continue;
    try {
      const sourceId = group[0]!.sourceId;
      const found = await findAlertsByKeys({
        apiKey: options.apiKey,
        deadline: options.deadline,
        fetchFn: options.fetchFn,
        keys: group.map((key) => key.key),
        maxPages,
        sleep: options.sleep,
        sourceId,
        states: ["PENDING", "ACCEPTED"],
        onTarget: (target) => alerts.push(target),
      });
      open += found.length;
    } catch (error) {
      const target = invalidCanaryAlertTarget(error);
      if (target && !alerts.some((alert) => alert.alertId === target.alertId)) {
        alerts.push(target);
      }
      validationError ??= invalidCanaryAlertValidationError(error);
      errors.push(error);
    }
  }
  return { alerts, complete: errors.length === 0, errors, open, validationError };
}

async function observeKnownAlerts(
  options: CleanupOptions,
  targets: Map<string, CanaryTarget>,
): Promise<{ allResolved: boolean; errors: unknown[]; resolvedIds: Set<string> }> {
  const errors: unknown[] = [];
  const resolvedIds = new Set<string>();
  let allResolved = true;
  for (const [alertId, target] of targets) {
    try {
      const observed = await observeAlertById(options, target);
      targets.set(alertId, observed);
      if (observed.status === "RESOLVED") resolvedIds.add(alertId);
      else allResolved = false;
    } catch (error) {
      errors.push(error);
      allResolved = false;
    }
  }
  return { allResolved, errors, resolvedIds };
}

async function resolveKnownAlerts(
  options: CleanupOptions,
  targets: ReadonlyMap<string, CanaryTarget>,
): Promise<{ errors: unknown[]; resolvedIds: Set<string> }> {
  const errors: unknown[] = [];
  const resolvedIds = new Set<string>();
  for (const target of targets.values()) {
    try {
      await resolveAlertById(options, target.alertId);
      resolvedIds.add(target.alertId);
    } catch (error) {
      errors.push(error);
    }
  }
  return { errors, resolvedIds };
}

function currentTargetResolved(
  key: string,
  targets: ReadonlyMap<string, CanaryTarget>,
  resolved: { resolvedIds: ReadonlySet<string> },
  observed: { resolvedIds: ReadonlySet<string> },
): boolean {
  return [...resolved.resolvedIds].some((alertId) =>
    targets.get(alertId)?.alertKey === key && observed.resolvedIds.has(alertId)
  );
}

function rememberTargets(
  targets: Map<string, CanaryTarget>,
  alerts: readonly CanaryTarget[],
): void {
  for (const alert of alerts) targets.set(alert.alertId, alert);
}

function deterministicCanaryKeys(
  runId: string,
  throughAttempt: number,
  sourceId: number,
): DeterministicCanaryKey[] {
  const keys: DeterministicCanaryKey[] = [];
  for (let runAttempt = 1; runAttempt <= throughAttempt; runAttempt += 1) {
    const attempt = String(runAttempt);
    keys.push({
      key: canaryAlertKey(runId, attempt),
      runAttempt,
      sourceId,
    });
  }
  return keys;
}

function submissionWindow(acceptedAt: number, now: number): ReportTimeWindow {
  return {
    from: reportTime(acceptedAt - ALERT_REPORT_TIME_SKEW_MS),
    until: reportTime(Math.max(acceptedAt, now) + ALERT_REPORT_TIME_SKEW_MS),
  };
}

function finalizerCurrentAttemptWindow(startedAt: string | undefined): ReportTimeWindow {
  const parsed = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(
      "POSTIL_ILERT_CANARY_STARTED_AT is required after an accepted canary submission",
    );
  }
  return {
    from: reportTime(parsed - ALERT_REPORT_TIME_SKEW_MS),
    until: reportTime(
      parsed + RECONCILE_DEADLINE_MS + CANARY_DEADLINE_MS + ALERT_REPORT_TIME_SKEW_MS,
    ),
  };
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
  sensitive = false,
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

async function resolveAlertById(
  options: CleanupOptions,
  alertId: string,
): Promise<void> {
  const response = await requestWithRetry(
    options.fetchFn,
    `${API_BASE}/alerts/${encodeURIComponent(alertId)}/resolve`,
    {
      method: "PUT",
      headers: { accept: "application/json", authorization: `Bearer ${options.apiKey}` },
    },
    options.deadline,
    options.sleep,
  );
  if (response.status !== 200) {
    throw new Error("iLert management alert resolution failed");
  }
}

interface AlertKeyLookupOptions {
  apiKey: string;
  deadline: Deadline;
  fetchFn: Fetch;
  from?: string;
  key: string;
  maxPages?: number;
  onTarget?: (target: CanaryTarget) => void;
  sleep: Sleep;
  sourceId?: number;
  states?: readonly ("PENDING" | "ACCEPTED" | "RESOLVED")[];
  until?: string;
}

async function findAlertsByKey(options: AlertKeyLookupOptions): Promise<Json[]> {
  return findAlertsByKeys({
    ...options,
    keys: [options.key],
  });
}

async function findAlertsByKeys(
  options: Omit<AlertKeyLookupOptions, "key"> & { keys: readonly string[] },
): Promise<Json[]> {
  const matches: Json[] = [];
  const keys = new Set(options.keys);
  let validationError: InvalidCanaryAlertValidationError | undefined;
  try {
    for (let start = 0, page = 0; ; start += 100, page += 1) {
      if (options.maxPages !== undefined && page >= options.maxPages) {
        throw new Error("iLert terminal canary inventory exceeded its pagination limit");
      }
      assertBeforeDeadline(options.deadline);
      const query = new URLSearchParams({
        "max-results": "100",
        "start-index": String(start),
      });
      if (options.sourceId) query.append("sources", String(options.sourceId));
      if (options.from) query.append("from", options.from);
      if (options.until) query.append("until", options.until);
      for (const state of options.states ?? []) query.append("states", state);
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
      for (const item of alerts) {
        const alert = object(item);
        if (typeof alert?.alertKey !== "string" || !keys.has(alert.alertKey)) continue;
        try {
          const observed = canaryObservation(alert, alert.alertKey, options.sourceId);
          options.onTarget?.(observed);
          if (options.states === undefined || options.states.includes(observed.status)) {
            matches.push(alert);
          }
        } catch (error) {
          const target = invalidCanaryAlertTarget(error);
          if (target) options.onTarget?.(target);
          if (error instanceof InvalidCanaryAlertValidationError) {
            validationError ??= error;
            continue;
          }
          throw error;
        }
      }
      if (alerts.length < 100) {
        if (validationError) throw validationError;
        return matches;
      }
    }
  } catch (error) {
    if (validationError && error !== validationError) {
      throw new AggregateError(
        [validationError, error],
        "iLert canary inventory encountered an invalid matching alert before completion",
      );
    }
    throw error;
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
  sourceId: number;
}

async function createAlertActionSafely(
  options: CreateAlertActionOptions,
): Promise<Json> {
  let created: Json;
  try {
    created = requireObject(
      await managementOnce(
        options.fetchFn,
        options.apiKey,
        "/alert-actions?include=conditions",
        { method: "POST", body: JSON.stringify(options.desired) },
        options.deadline,
      ),
      "iLert returned an invalid alert action",
    );
  } catch {
    const candidate = await loadReservedAlertAction(options);
    if (candidate && equivalentAlertAction(candidate, options.desired)) return candidate;
    throw new Error(
      "iLert alert-action creation was ambiguous; refusing to submit a second POST",
    );
  }
  const candidate = await loadReservedAlertAction(options);
  if (
    !candidate ||
    !equivalentAlertAction(candidate, options.desired) ||
    actionId(candidate) !== actionId(created)
  ) {
    throw new Error("iLert did not confirm the created alert action in the global inventory");
  }
  return candidate;
}

async function loadReservedAlertAction(
  options: CreateAlertActionOptions,
): Promise<Json | undefined> {
  const candidates = await loadCandidateActions(
    options.fetchFn,
    options.apiKey,
    options.desired,
    options.deadline,
    options.sleep,
  );
  return reservedCandidate(candidates, options.desired, options.sourceId);
}

function reservedCandidate(
  candidates: readonly Json[],
  desired: Json,
  sourceId: number,
): Json | undefined {
  if (candidates.some((action) => {
    const actionRelationIds = relationIds(action.alertSources);
    return action.connectorType !== "webhook" ||
      actionRelationIds === null ||
      !sameSet(actionRelationIds, [sourceId]);
  })) {
    throw new Error(
      "A conflicting Postil alert action exists; refusing to change its type or source scope",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      "Multiple Postil webhook alert actions exist; refusing to choose or delete one",
    );
  }
  return candidates[0];
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
  sensitive = false,
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
  if (sensitive) throw new Error("Sensitive remote request failed after bounded retries");
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
  const desiredEndpoint = receiverEndpoint(webhook);
  if (!desiredEndpoint) throw new Error("iLert returned an invalid desired webhook URL");
  const summaries = (await listActions(fetchFn, apiKey, deadline, sleep))
    .filter((action) => reservedActionSummary(action, desiredEndpoint));
  return Promise.all(summaries.map(async (item) => {
    const id = actionId(item);
    const action = requireAlertActionId(
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
    if (
      action.name !== ACTION_NAME &&
      !sameReceiverEndpoint(object(action.params)?.webhookUrl, desiredEndpoint)
    ) {
      throw new Error("iLert returned an inconsistent reserved alert action");
    }
    if (action.name === ACTION_NAME && !receiverEndpoint(object(action.params)?.webhookUrl)) {
      throw new Error("iLert returned a reserved alert action with an invalid webhook URL");
    }
    return action;
  }));
}

interface ReceiverEndpoint {
  hostname: string;
  pathname: string;
  port: string;
  protocol: string;
  query: string;
}

function reservedActionSummary(action: Json, desired: ReceiverEndpoint): boolean {
  if (action.name === ACTION_NAME) {
    const webhook = object(action.params)?.webhookUrl;
    if (webhook !== undefined && !receiverEndpoint(webhook)) {
      throw new Error("iLert returned a reserved alert action with an invalid webhook URL");
    }
    return true;
  }
  return sameReceiverEndpoint(object(action.params)?.webhookUrl, desired);
}

function sameReceiverEndpoint(value: unknown, desired: ReceiverEndpoint): boolean {
  const actual = receiverEndpoint(value);
  return actual !== null &&
    actual.protocol === desired.protocol &&
    actual.hostname === desired.hostname &&
    actual.port === desired.port &&
    actual.pathname === desired.pathname &&
    actual.query === desired.query;
}

function receiverEndpoint(value: unknown): ReceiverEndpoint | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    const query = [...parsed.searchParams.entries()]
      .sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName === rightName
          ? leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
          : leftName < rightName ? -1 : 1,
      )
      .map(([name, entry]) => `${encodeURIComponent(name)}=${encodeURIComponent(entry)}`)
      .join("&");
    return {
      hostname: parsed.hostname.toLowerCase(),
      pathname: parsed.pathname,
      port: parsed.port,
      protocol: parsed.protocol.toLowerCase(),
      query,
    };
  } catch {
    return null;
  }
}

async function loadIntegrationBoundAlertSource(
  fetchFn: Fetch,
  apiKey: string,
  integrationKey: string,
  sourceId: number,
  deadline: Deadline,
  sleep: Sleep,
): Promise<Json> {
  try {
    const response = await requestWithRetry(
      fetchFn,
      `${API_BASE}/alert-sources/${encodeURIComponent(integrationKey)}`,
      { headers: { accept: "application/json", authorization: `Bearer ${apiKey}` } },
      deadline,
      sleep,
      true,
    );
    if (response.status !== 200) throw new Error("binding request failed");
    return alertSource(await parseJson(response), sourceId);
  } catch {
    throw new Error("iLert integration binding validation failed");
  }
}

function alertSource(
  value: unknown,
  expectedId: number,
): Json {
  const source = requireObject(value, "iLert returned an invalid alert source");
  const id = positiveNumber(source.id);
  if (
    id !== expectedId ||
    source.integrationType !== "API"
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

function requireCanaryRunIdentity(
  runId: string | undefined,
  runAttempt: string | undefined,
): { runAttempt: number; runId: string } {
  if (!runId || !runAttempt) {
    throw new Error(
      "POSTIL_ILERT_CANARY_RUN_ID and POSTIL_ILERT_CANARY_RUN_ATTEMPT are required for live reconciliation",
    );
  }
  return canaryRunIdentity(runId, runAttempt);
}

function canaryRunIdentity(
  runId: string,
  runAttempt: string,
): { runAttempt: number; runId: string } {
  const normalizedRunId = positiveId(runId);
  const normalizedRunAttempt = positiveNumber(runAttempt);
  if (!normalizedRunId) {
    throw new Error("GitHub run ID must be a positive integer");
  }
  if (
    !normalizedRunAttempt ||
    normalizedRunAttempt > MAX_CANARY_RUN_ATTEMPT
  ) {
    throw new Error(
      `GitHub run attempt must be between 1 and ${MAX_CANARY_RUN_ATTEMPT}`,
    );
  }
  return { runAttempt: normalizedRunAttempt, runId: normalizedRunId };
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

  if (finalizeCanary) {
    const alertSubmitted = canaryAlertSubmission(values);
    await finalizeIlertWebhookCanary({
      alertSubmitted,
      apiKey: environment(values, "ILERT_API_KEY"),
      fetchFn: options.fetchFn,
      integrationKey: environment(values, "ILERT_INTEGRATION_KEY"),
      now: options.now,
      runAttempt: environment(values, "POSTIL_ILERT_CANARY_RUN_ATTEMPT"),
      sweepAttempt: values.POSTIL_ILERT_CANARY_SWEEP_ATTEMPT,
      runId: environment(values, "POSTIL_ILERT_CANARY_RUN_ID"),
      sleep: options.sleep,
      sourceId: requiredSourceId(values),
      startedAt: values.POSTIL_ILERT_CANARY_STARTED_AT,
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
  const runId = canary
    ? environment(values, "POSTIL_ILERT_CANARY_RUN_ID")
    : undefined;
  const runAttempt = canary
    ? environment(values, "POSTIL_ILERT_CANARY_RUN_ATTEMPT")
    : undefined;
  const startedAt = canary
    ? new Date((options.now ?? Date.now)()).toISOString()
    : undefined;
  if (canary) {
    await recordCanaryAlertSubmission(values, "unknown", startedAt, runAttempt);
  }
  const result = await reconcileIlertAlertAction({
    ...shared,
    dryRun,
    runAttempt,
    runId,
  });
  log(`iLert webhook-action reconciliation${dryRun ? " plan" : ""}: ${result.operation}`);
  if (canary) {
    let alertAccepted = false;
    try {
      await verifyIlertWebhookCanary({
        ...shared,
        onAlertAttempted: () => recordCanaryAlertSubmission(values, "unknown", startedAt, runAttempt),
        onAlertSubmitted: async () => {
          alertAccepted = true;
          await recordCanaryAlertSubmission(values, "true", startedAt, runAttempt);
        },
        runAttempt: runAttempt!,
        runId: runId!,
        startedAt,
      });
    } catch (error) {
      await recordCanaryAlertSubmission(
        values,
        alertAccepted ? "true" : "unknown",
        startedAt,
        runAttempt,
      );
      throw error;
    }
    await recordCanaryAlertSubmission(values, "cleaned", startedAt, runAttempt);
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
  startedAt?: string,
  producerAttempt?: string,
): Promise<void> {
  const output = values.GITHUB_OUTPUT;
  if (!output) return;
  await appendFile(
    output,
    `alert_submitted=${submitted}\n${startedAt ? `started_at=${startedAt}\n` : ""}${producerAttempt ? `producer_attempt=${producerAttempt}\n` : ""}`,
    "utf8",
  );
}

if (import.meta.main) await runCli();
