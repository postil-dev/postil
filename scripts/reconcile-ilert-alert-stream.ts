#!/usr/bin/env bun

import { appendFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";

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
const CANARY_ORPHAN_SWEEP_DEADLINE_MS = 12 * 60 * 1_000;
const CANARY_ORPHAN_SWEEP_MAX_PAGES = 20;
const ALERT_ACTION_INVENTORY_MAX_PAGES = 50;
const CANARY_CLEANUP_ATTEMPTS = 4;
// GitHub permits reruns for 30 days. Keep two additional days for queueing,
// setup, smoke checks, and clock skew before cleanup establishes its window.
export const CANARY_RERUN_LOOKBACK_MS = 32 * 24 * 60 * 60 * 1_000;
const ALERT_PAGE_SIZE = 100;
// GitHub permits the initial workflow run plus 50 reruns.
export const MAX_CANARY_RUN_ATTEMPT = 51;
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
type BeforeMutationAttempt = () => Promise<void>;

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
}

interface OrphanSweepOptions {
  apiKey: string;
  sourceId: number;
  fetchFn?: Fetch;
  sleep?: Sleep;
  now?: Clock;
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

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
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
  // The cleanup and receiver preflight can take most of the reconciliation
  // budget. Re-read both identities at the mutation boundary so a concurrent
  // action or source change observed before dispatch rejects the stale plan.
  const boundarySource = await loadIntegrationBoundAlertSource(
    fetchFn,
    options.apiKey,
    options.integrationKey,
    options.sourceId,
    deadline,
    sleep,
  );
  const boundaryDesired = desiredAlertAction(
    boundarySource,
    options.webhookSecret,
    receiverOrigin,
  );
  if (!sameJson(desired, boundaryDesired)) {
    throw new Error("iLert alert-action source binding changed before mutation");
  }
  const boundaryActions = await loadCandidateActions(
    fetchFn,
    options.apiKey,
    boundaryDesired,
    deadline,
    sleep,
  );
  const boundaryExisting = reservedCandidate(
    boundaryActions,
    boundaryDesired,
    options.sourceId,
  );
  if (!existing && boundaryExisting) {
    throw new Error("A Postil alert action appeared before creation; refusing to submit POST");
  }
  if (
    existing &&
    (!boundaryExisting ||
      actionId(existing) !== actionId(boundaryExisting) ||
      !sameJson(existing, boundaryExisting))
  ) {
    throw new Error("iLert reserved alert action changed before mutation");
  }
  if (operation === "unchanged") {
    return { actionId: actionId(existing), operation };
  }
  const id = boundaryExisting ? actionId(boundaryExisting) : null;
  // The guard runs immediately before every action mutation attempt, including
  // a retry after a transient response. Receiver acceptance comes first; the
  // source binding and complete continuity-safe action inventory then form the
  // final reads before the request deadline is recomputed and the mutation is
  // dispatched. The provider offers no conditional write, so an out-of-band
  // change after these reads remains a detected postcondition risk.
  const beforeMutationAttempt: BeforeMutationAttempt = async () => {
    await preflightReceiver(
      fetchFn,
      receiverOrigin,
      options.webhookSecret,
      deadline,
      sleep,
    );
    const attemptSource = await loadIntegrationBoundAlertSource(
      fetchFn,
      options.apiKey,
      options.integrationKey,
      options.sourceId,
      deadline,
      sleep,
    );
    const attemptDesired = desiredAlertAction(
      attemptSource,
      options.webhookSecret,
      receiverOrigin,
    );
    if (!sameJson(boundaryDesired, attemptDesired)) {
      throw new Error("iLert alert-action source binding changed before mutation");
    }
    const attemptActions = await loadCandidateActions(
      fetchFn,
      options.apiKey,
      attemptDesired,
      deadline,
      sleep,
    );
    const attemptExisting = reservedCandidate(
      attemptActions,
      attemptDesired,
      options.sourceId,
    );
    if (!id && attemptExisting) {
      throw new Error("A Postil alert action appeared before creation; refusing to submit POST");
    }
    if (
      id &&
      (!attemptExisting ||
        actionId(attemptExisting) !== id ||
        !sameJson(attemptExisting, boundaryExisting))
    ) {
      throw new Error("iLert reserved alert action changed before mutation");
    }
  };
  const result = id
    ? requireObject(
      await management(
        fetchFn,
        options.apiKey,
        `/alert-actions/${encodeURIComponent(id)}?include=conditions`,
        { method: "PUT", body: JSON.stringify({ ...boundaryDesired, id }) },
        deadline,
        sleep,
        false,
        beforeMutationAttempt,
      ),
      "iLert returned an invalid alert action",
    )
    : await createAlertActionSafely({
      apiKey: options.apiKey,
      deadline,
      desired: boundaryDesired,
      fetchFn,
      beforeMutationAttempt,
      sleep,
      sourceId: options.sourceId,
    });
  const resultId = actionId(result);
  if (id && resultId !== id) {
    throw new Error("iLert returned a different alert action after update");
  }
  await confirmUniqueMutatedAlertAction({
    apiKey: options.apiKey,
    beforeMutationAttempt,
    deadline,
    desired: boundaryDesired,
    expectedId: resultId,
    fetchFn,
    sleep,
    sourceId: options.sourceId,
  });
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
    runAttempt: identity.runAttempt,
    runId: identity.runId,
    sleep,
    sourceId: options.sourceId,
  });
  const key = canaryAlertKey(identity.runId, String(identity.runAttempt));
  let alertAttempted = false;
  let resolutionConfirmed = false;
  let created: CanaryTarget | undefined;
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
      webhookSecret: options.webhookSecret,
    };
    alertAttempted = true;
    await options.onAlertAttempted?.();
    await event(
      submittedOptions,
      "ALERT",
      key,
    );
    await options.onAlertSubmitted?.();
    created = await waitForCreatedDelivery(submittedOptions, (target) => {
      // The management inventory has authenticated this exact id, key, and
      // source. Keep it before receiver evidence so cleanup remains able to
      // resolve it if the receiver or a subsequent discovery request fails.
      created ??= target;
    });
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
    sourceId: options.sourceId,
  };
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
  await finalizeDeterministicCanaryKeys(
    cleanup,
    keys,
    discoveryDeadline,
    handoff,
    currentMain,
  );
}

export async function sweepIlertWebhookCanaryOrphans(
  options: OrphanSweepOptions,
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const deadline: Deadline = {
    expiresAt: now() + CANARY_ORPHAN_SWEEP_DEADLINE_MS,
    now,
  };
  const cleanup: ManagementCleanupOptions = {
    apiKey: options.apiKey,
    deadline,
    fetchFn,
    sleep,
    sourceId: options.sourceId,
  };
  const targets = new Map<string, CanaryTarget>();

  await loadManagementBoundAlertSource(
    fetchFn,
    options.apiKey,
    options.sourceId,
    deadline,
    sleep,
  );

  for (let pass = 0; pass < CANARY_CLEANUP_ATTEMPTS; pass += 1) {
    const discovered = await findOpenDeterministicCanaryAlerts({
      ...cleanup,
      maxPages: CANARY_ORPHAN_SWEEP_MAX_PAGES,
    });
    rememberTargets(targets, discovered.targets);

    const resolved = await resolveKnownAlerts(cleanup, targets);
    const observed = await observeKnownAlerts(cleanup, targets);
    if (discovered.errors.length > 0 || resolved.errors.length > 0 || !observed.allResolved) {
      throw new AggregateError(
        [...discovered.errors, ...resolved.errors, ...observed.errors],
        discovered.errors.length > 0
          ? "iLert orphan canary sweep inventory was incomplete after resolving retained alerts"
          : resolved.errors.length > 0
          ? "iLert orphan canary sweep could not resolve every discovered alert"
          : "iLert orphan canary sweep could not verify every discovered alert as RESOLVED",
      );
    }

    const remainingOpen = await findOpenDeterministicCanaryAlerts({
      ...cleanup,
      maxPages: CANARY_ORPHAN_SWEEP_MAX_PAGES,
    });
    rememberTargets(targets, remainingOpen.targets);
    if (remainingOpen.errors.length > 0) {
      const resolved = await resolveKnownAlerts(cleanup, targets);
      const observed = await observeKnownAlerts(cleanup, targets);
      throw new AggregateError(
        [...remainingOpen.errors, ...resolved.errors, ...observed.errors],
        "iLert orphan canary sweep inventory was incomplete after resolving retained alerts",
      );
    }
    await loadManagementBoundAlertSource(
      fetchFn,
      options.apiKey,
      options.sourceId,
      deadline,
      sleep,
    );
    if (remainingOpen.targets.length === 0) return;
    if (pass + 1 < CANARY_CLEANUP_ATTEMPTS) {
      await sleep(Math.min(CANARY_CLEANUP_RETRY_MS, remaining(deadline)));
    }
  }

  throw new Error("iLert orphan canary sweep did not stabilize every deterministic alert");
}

interface ManagementCleanupOptions {
  apiKey: string;
  deadline: Deadline;
  fetchFn: Fetch;
  sleep: Sleep;
  sourceId: number;
}

interface CleanupOptions extends ManagementCleanupOptions {
  integrationKey: string;
}

interface WaitOptions extends CleanupOptions {
  key: string;
  receiverOrigin: string;
  sourceId: number;
  webhookSecret: string;
}

interface CanaryTarget {
  alertId: string;
  alertKey: string;
  sourceId: number;
  status?: "PENDING" | "ACCEPTED" | "RESOLVED";
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

const ALL_ALERT_STATES = ["PENDING", "ACCEPTED", "RESOLVED"] as const;

async function cleanupAfterAlertAttempt(
  options: WaitOptions,
  created: CanaryTarget | undefined,
): Promise<void> {
  let submissionError: unknown;
  try {
    if (!created) {
      await event(
        options,
        "RESOLVE",
        options.key,
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
  onValidatedTarget?: (target: CanaryTarget) => void,
): Promise<CanaryObservation> {
  for (let attempt = 0; attempt < CANARY_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline(options.deadline);
    const observed = await findSubmittedAlert(
      options,
      ["PENDING", "ACCEPTED"],
    );
    if (observed) onValidatedTarget?.(observed);
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
    ...rollingCanaryInventoryWindow(options.deadline.now()),
    completeInventory: true,
    key: options.key,
    maxPages: CANARY_FINALIZER_TERMINAL_INVENTORY_MAX_PAGES,
    sleep: options.sleep,
    sourceId: options.sourceId,
    states: ALL_ALERT_STATES,
  });
  if (current.length > 1) {
    throw new Error("iLert created multiple alerts for one canary attempt");
  }
  if (!current[0]) return undefined;
  const observed = canaryObservation(current[0], options.key, options.sourceId);
  return states.includes(observed.status) ? observed : undefined;
}

async function observeAlertById(
  options: ManagementCleanupOptions,
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
  if (!alertId) {
    throw new InvalidCanaryAlertIdentityError(
      "iLert returned a canary alert without an identity",
    );
  }
  if (!observedSourceId) {
    throw new InvalidCanaryAlertIdentityError(
      "iLert returned a canary alert without a valid source",
    );
  }
  if (expectedSourceId !== undefined && observedSourceId !== expectedSourceId) {
    throw new InvalidCanaryAlertIdentityError(
      "iLert returned a canary alert from a different source",
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
  options: ManagementCleanupOptions,
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
  options: ManagementCleanupOptions & {
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
    const discovered = await discoverOpenDeterministicAlerts(
      options,
      keys,
      rollingCanaryInventoryWindow(options.deadline.now()),
      CANARY_FINALIZER_TERMINAL_INVENTORY_MAX_PAGES,
      true,
    );
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
    const inventoryWindow = rollingCanaryInventoryWindow(deadline.now());
    const result = await discoverOpenDeterministicAlerts(
      { ...options, deadline },
      keys,
      inventoryWindow,
      maxPages ?? CANARY_FINALIZER_TERMINAL_INVENTORY_MAX_PAGES,
      true,
    );
    rememberTargets(targets, result.alerts);
    retainErrors(result.errors);
    retainInvalidValidation(result.errors);
    if (result.validationError && !invalidValidationError) {
      invalidValidationError = result.validationError;
      validationContextErrors = [...validationContextErrors, result.validationError].slice(-20);
    }
    if (handoff === "true" && !currentAccountedFor) {
      try {
        const current = await findAlertsByKey({
          apiKey: options.apiKey,
          deadline,
          fetchFn: options.fetchFn,
          ...rollingCanaryInventoryWindow(deadline.now()),
          key: currentMain.key,
          completeInventory: true,
          maxPages: maxPages ?? CANARY_FINALIZER_TERMINAL_INVENTORY_MAX_PAGES,
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
          options,
          "RESOLVE",
          currentMain.key,
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
  options: ManagementCleanupOptions,
  keys: readonly DeterministicCanaryKey[],
  window?: ReportTimeWindow,
  maxPages?: number,
  completeInventory = false,
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
        completeInventory,
        deadline: options.deadline,
        fetchFn: options.fetchFn,
        keys: group.map((key) => key.key),
        maxPages,
        sleep: options.sleep,
        sourceId,
        states: completeInventory ? ALL_ALERT_STATES : ["PENDING", "ACCEPTED"],
        ...(window ?? {}),
        onTarget: (target) => alerts.push(target),
      });
      open += found.filter((alert) =>
        alert.status === "PENDING" || alert.status === "ACCEPTED"
      ).length;
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
  options: ManagementCleanupOptions,
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
  options: ManagementCleanupOptions,
  targets: ReadonlyMap<string, CanaryTarget>,
): Promise<{ errors: unknown[]; resolvedIds: Set<string> }> {
  const errors: unknown[] = [];
  const resolvedIds = new Set<string>();
  for (const target of targets.values()) {
    if (target.status === "RESOLVED") {
      resolvedIds.add(target.alertId);
      continue;
    }
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

function rollingCanaryInventoryWindow(untilMs: number): ReportTimeWindow {
  return {
    from: reportTime(untilMs - CANARY_RERUN_LOOKBACK_MS),
    until: reportTime(untilMs),
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
  options: CleanupOptions,
  eventType: "ALERT" | "RESOLVE",
  alertKey: string,
  priority?: "HIGH" | "LOW",
  summary = "Postil iLert webhook canary",
): Promise<void> {
  const response = await requestWithRetry(
    options.fetchFn,
    `${API_BASE}/events`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        integrationKey: options.integrationKey,
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
    options.deadline,
    options.sleep,
    false,
    async () => {
      await loadIntegrationBoundAlertSource(
        options.fetchFn,
        options.apiKey,
        options.integrationKey,
        options.sourceId,
        options.deadline,
        options.sleep,
      );
    },
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
  beforeAttempt?: BeforeMutationAttempt,
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
    sensitive,
    beforeAttempt,
  );
  if (!response.ok) {
    throw new Error(`iLert management request failed with HTTP ${response.status}`);
  }
  return parseJson(response);
}

async function resolveAlertById(
  options: ManagementCleanupOptions,
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
    false,
    async () => {
      await loadManagementBoundAlertSource(
        options.fetchFn,
        options.apiKey,
        options.sourceId,
        options.deadline,
        options.sleep,
      );
    },
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
  completeInventory?: boolean;
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
  const matches = new Map<string, Json>();
  const keys = new Set(options.keys);
  const retainedTargetIds = new Set<string>();
  let validationError: InvalidCanaryAlertValidationError | undefined;

  const retainTarget = (target: CanaryTarget) => {
    if (retainedTargetIds.has(target.alertId)) return;
    retainedTargetIds.add(target.alertId);
    options.onTarget?.(target);
  };
  const queryFor = (start?: number): URLSearchParams => {
    const query = new URLSearchParams();
    if (start !== undefined) {
      query.set("max-results", String(ALERT_PAGE_SIZE));
      query.set("start-index", String(start));
    }
    if (options.sourceId) query.append("sources", String(options.sourceId));
    if (options.from) query.append("from", options.from);
    if (options.until) query.append("until", options.until);
    for (const state of options.states ?? []) query.append("states", state);
    return query;
  };
  const fetchCount = async (): Promise<number> => {
    assertBeforeDeadline(options.deadline);
    const value = requireObject(
      await management(
        options.fetchFn,
        options.apiKey,
        `/alerts/count?${queryFor().toString()}`,
        {},
        options.deadline,
        options.sleep,
      ),
      "iLert returned an invalid alert inventory count",
    );
    const count = value.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("iLert returned an invalid alert inventory count");
    }
    return count;
  };
  const fetchPage = async (start: number): Promise<{ alerts: Json[]; ids: string[] }> => {
    assertBeforeDeadline(options.deadline);
    const alerts = await management(
      options.fetchFn,
      options.apiKey,
      `/alerts?${queryFor(start).toString()}`,
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
        retainTarget(observed);
        if (options.states === undefined || options.states.includes(observed.status)) {
          matches.set(observed.alertId, alert);
        }
      } catch (error) {
        const target = invalidCanaryAlertTarget(error);
        if (target) retainTarget(target);
        if (error instanceof InvalidCanaryAlertValidationError) {
          validationError ??= error;
          continue;
        }
        throw error;
      }
    }
    const ids = alerts.map((item) => {
      const alertId = positiveId(item.id);
      if (!alertId) {
        throw new Error("iLert returned an offset-page alert without an identity");
      }
      return alertId;
    });
    return { alerts, ids };
  };

  const listCompleteInventory = async (): Promise<Json[]> => {
    const beforeCount = await fetchCount();
    const pages: Json[] = [];
    const ids = new Set<string>();
    for (let page = 0, start = 0; ; page += 1, start += ALERT_PAGE_SIZE) {
      if (options.maxPages !== undefined && page >= options.maxPages) {
        throw new Error("iLert terminal canary inventory exceeded its pagination limit");
      }
      const found = await fetchPage(start);
      for (const [index, alert] of found.alerts.entries()) {
        const id = found.ids[index]!;
        if (ids.has(id)) {
          throw new Error("iLert alert inventory repeated an alert identity");
        }
        ids.add(id);
        pages.push(alert);
      }
      if (found.alerts.length < ALERT_PAGE_SIZE) break;
    }
    const afterCount = await fetchCount();
    if (beforeCount !== afterCount || afterCount !== ids.size) {
      throw new Error("iLert alert inventory changed during pagination");
    }
    return pages;
  };

  try {
    if (!options.completeInventory) {
      for (let page = 0, start = 0; ; page += 1, start += ALERT_PAGE_SIZE) {
        if (options.maxPages !== undefined && page >= options.maxPages) {
          throw new Error("iLert terminal canary inventory exceeded its pagination limit");
        }
        const found = await fetchPage(start);
        if (found.alerts.length < ALERT_PAGE_SIZE) {
          if (validationError) throw validationError;
          return [...matches.values()];
        }
      }
    }
    const first = await listCompleteInventory();
    const second = await listCompleteInventory();
    const firstIds = first.map((alert) => positiveId(alert.id));
    const secondIds = second.map((alert) => positiveId(alert.id));
    if (
      firstIds.length !== secondIds.length ||
      firstIds.some((id, index) => id !== secondIds[index])
    ) {
      throw new Error("iLert alert inventory changed during continuity revalidation");
    }
    if (validationError) throw validationError;
    return [...matches.values()];
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

async function findOpenDeterministicCanaryAlerts(
  options: ManagementCleanupOptions & { maxPages: number },
): Promise<{ errors: unknown[]; targets: CanaryTarget[] }> {
  const targets = new Map<string, CanaryTarget>();
  const queryFor = (start?: number): URLSearchParams => {
    const query = new URLSearchParams();
    if (start !== undefined) {
      query.set("max-results", String(ALERT_PAGE_SIZE));
      query.set("start-index", String(start));
    }
    query.append("sources", String(options.sourceId));
    query.append("states", "PENDING");
    query.append("states", "ACCEPTED");
    return query;
  };
  const fetchCount = async (): Promise<number> => {
    assertBeforeDeadline(options.deadline);
    const value = requireObject(
      await management(
        options.fetchFn,
        options.apiKey,
        `/alerts/count?${queryFor().toString()}`,
        {},
        options.deadline,
        options.sleep,
      ),
      "iLert returned an invalid orphan canary inventory count",
    );
    const count = value.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("iLert returned an invalid orphan canary inventory count");
    }
    return count;
  };
  const listCompleteInventory = async (): Promise<CanaryTarget[]> => {
    const beforeCount = await fetchCount();
    const identities = new Set<string>();
    const found: CanaryTarget[] = [];
    for (let page = 0, start = 0; ; page += 1, start += ALERT_PAGE_SIZE) {
      if (page >= options.maxPages) {
        throw new Error("iLert orphan canary inventory exceeded its pagination limit");
      }
      assertBeforeDeadline(options.deadline);
      const pageAlerts = await management(
        options.fetchFn,
        options.apiKey,
        `/alerts?${queryFor(start).toString()}`,
        {},
        options.deadline,
        options.sleep,
      );
      if (!Array.isArray(pageAlerts) || pageAlerts.some((alert) => !object(alert))) {
        throw new Error("iLert returned an invalid orphan canary inventory page");
      }
      for (const item of pageAlerts) {
        const alert = object(item)!;
        const alertId = positiveId(alert.id);
        if (!alertId) {
          throw new Error("iLert returned an orphan canary inventory alert without an identity");
        }
        if (identities.has(alertId)) {
          throw new Error("iLert orphan canary inventory repeated an alert identity");
        }
        identities.add(alertId);
        if (
          typeof alert.alertKey !== "string" ||
          !isDeterministicCanaryKey(alert.alertKey)
        ) {
          continue;
        }
        const target = canaryObservation(alert, alert.alertKey, options.sourceId);
        targets.set(target.alertId, target);
        found.push(target);
      }
      if (pageAlerts.length < ALERT_PAGE_SIZE) break;
    }
    const afterCount = await fetchCount();
    if (beforeCount !== afterCount || afterCount !== identities.size) {
      throw new Error("iLert orphan canary inventory changed during pagination");
    }
    return found;
  };

  try {
    const first = await listCompleteInventory();
    const second = await listCompleteInventory();
    const firstIds = first.map((target) => target.alertId);
    const secondIds = second.map((target) => target.alertId);
    if (
      firstIds.length !== secondIds.length ||
      firstIds.some((id, index) => id !== secondIds[index])
    ) {
      throw new Error("iLert orphan canary inventory changed during continuity validation");
    }
    return { errors: [], targets: [...targets.values()] };
  } catch (error) {
    const target = invalidCanaryAlertTarget(error);
    if (target) targets.set(target.alertId, target);
    return { errors: [error], targets: [...targets.values()] };
  }
}

function alertSourceId(alert: Json): number | null {
  return positiveNumber(object(alert.alertSource)?.id);
}

interface CreateAlertActionOptions {
  apiKey: string;
  beforeMutationAttempt: BeforeMutationAttempt;
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
    created = await managementOnce(
      options.fetchFn,
      options.apiKey,
      "/alert-actions?include=conditions",
      { method: "POST", body: JSON.stringify(options.desired) },
      options.deadline,
      options.beforeMutationAttempt,
    );
  } catch (error) {
    if (!(error instanceof AmbiguousAlertActionCreateError)) throw error;
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

async function confirmUniqueMutatedAlertAction(
  options: CreateAlertActionOptions & { expectedId: string },
): Promise<void> {
  const candidates = await loadCandidateActions(
    options.fetchFn,
    options.apiKey,
    options.desired,
    options.deadline,
    options.sleep,
  );
  const candidate = reservedCandidate(candidates, options.desired, options.sourceId);
  if (!candidate || actionId(candidate) !== options.expectedId) {
    throw new Error(
      "iLert did not retain exactly one reconciled alert action after mutation",
    );
  }
  if (!equivalentAlertAction(candidate, options.desired)) {
    throw new Error("iLert did not retain the reconciled alert action");
  }
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
  beforeAttempt?: BeforeMutationAttempt,
): Promise<Json> {
  assertBeforeDeadline(deadline);
  await beforeAttempt?.();
  assertBeforeDeadline(deadline);
  const timeout = Math.min(REQUEST_TIMEOUT_MS, remaining(deadline));
  try {
    const response = await fetchFn(`${API_BASE}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      throw new Error(`iLert alert-action creation request is ambiguous after HTTP ${response.status}`);
    }
    return requireObject(
      await parseJson(response),
      "iLert returned an invalid alert action",
    );
  } catch (error) {
    throw new AmbiguousAlertActionCreateError(error);
  }
}

class AmbiguousAlertActionCreateError extends Error {
  constructor(cause: unknown) {
    super("iLert alert-action creation request is ambiguous", { cause });
  }
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
  beforeAttempt?: BeforeMutationAttempt,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    assertBeforeDeadline(deadline);
    await beforeAttempt?.();
    // Guards may perform bounded remote validation. Re-read the deadline only
    // after that work completes so validation cannot borrow time reserved for
    // cleanup or dispatch a mutation after its budget has expired.
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
  const list = async (): Promise<Json[]> => {
    const actions: Json[] = [];
    const ids = new Set<string>();
    for (let pageIndex = 0, start = 0; ; pageIndex += 1, start += ALERT_PAGE_SIZE - 1) {
      if (pageIndex >= ALERT_ACTION_INVENTORY_MAX_PAGES) {
        throw new Error("iLert alert-action inventory exceeded its pagination limit");
      }
      const query = new URLSearchParams({
        "start-index": String(start),
        "max-results": String(ALERT_PAGE_SIZE),
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
      for (const action of page as Json[]) {
        const id = actionId(action);
        // Adjacent pages overlap by one record. Deduplication makes the
        // resulting fingerprint independent of that expected boundary row.
        if (ids.has(id)) continue;
        ids.add(id);
        actions.push(action);
      }
      if (page.length < ALERT_PAGE_SIZE) return actions;
    }
  };
  const first = await list();
  const second = await list();
  const firstIds = first.map(actionId);
  const secondIds = second.map(actionId);
  if (
    firstIds.length !== secondIds.length ||
    firstIds.some((id, index) => id !== secondIds[index])
  ) {
    throw new Error("iLert alert-action inventory changed during continuity validation");
  }
  return second;
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
      `${API_BASE}/alert-sources/${encodeURIComponent(sourceId)}`,
      { headers: { accept: "application/json", authorization: `Bearer ${apiKey}` } },
      deadline,
      sleep,
      true,
    );
    if (response.status !== 200) throw new Error("binding request failed");
    return alertSource(await parseJson(response), sourceId, integrationKey);
  } catch {
    throw new Error("iLert integration binding validation failed");
  }
}

async function loadManagementBoundAlertSource(
  fetchFn: Fetch,
  apiKey: string,
  sourceId: number,
  deadline: Deadline,
  sleep: Sleep,
): Promise<Json> {
  try {
    const response = await requestWithRetry(
      fetchFn,
      `${API_BASE}/alert-sources/${encodeURIComponent(sourceId)}`,
      { headers: { accept: "application/json", authorization: `Bearer ${apiKey}` } },
      deadline,
      sleep,
      true,
    );
    if (response.status !== 200) throw new Error("source request failed");
    return managementAlertSource(await parseJson(response), sourceId);
  } catch {
    throw new Error("iLert management alert-source validation failed");
  }
}

function managementAlertSource(value: unknown, expectedId: number): Json {
  const source = requireObject(value, "iLert returned an invalid alert source");
  if (positiveNumber(source.id) !== expectedId || source.integrationType !== "API") {
    throw new Error("iLert alert source does not match the configured management identity");
  }
  return { id: expectedId };
}

function alertSource(
  value: unknown,
  expectedId: number,
  expectedIntegrationKey: string,
): Json {
  const source = requireObject(value, "iLert returned an invalid alert source");
  const id = positiveNumber(source.id);
  if (
    id !== expectedId ||
    source.integrationType !== "API" ||
    typeof source.integrationKey !== "string" ||
    !sameSecret(source.integrationKey, expectedIntegrationKey)
  ) {
    throw new Error("iLert alert source does not match the configured identity");
  }
  return { id };
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
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

function isDeterministicCanaryKey(value: string): boolean {
  const match = new RegExp(`^${CANARY_KEY_PREFIX}-([1-9][0-9]*)-([1-9][0-9]*)$`, "u")
    .exec(value);
  if (!match) return false;
  try {
    canaryRunIdentity(match[1]!, match[2]!);
    return true;
  } catch {
    return false;
  }
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

export function validWebhookSecret(secret: string): boolean {
  return /^[\x21-\x7e]{32,512}$/u.test(secret) && new Set(secret).size >= 4;
}

function requireWebhookSecret(secret: string): void {
  if (!validWebhookSecret(secret)) {
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
        arg !== "--dry-run" && arg !== "--canary" && arg !== "--finalize-canary" &&
        arg !== "--sweep-canary-orphans" && arg !== "--validate-webhook-secret",
    )
  ) {
    throw new Error(
      "usage: reconcile-ilert-alert-stream.ts [--validate-webhook-secret|--dry-run|--canary|--finalize-canary|--sweep-canary-orphans]",
    );
  }
  const dryRun = args.includes("--dry-run");
  const canary = args.includes("--canary");
  const finalizeCanary = args.includes("--finalize-canary");
  const sweepCanaryOrphans = args.includes("--sweep-canary-orphans");
  const validateWebhookSecret = args.includes("--validate-webhook-secret");
  if (validateWebhookSecret && (dryRun || canary || finalizeCanary || sweepCanaryOrphans)) {
    throw new Error("--validate-webhook-secret cannot be combined with reconciliation commands");
  }
  if (dryRun && (canary || finalizeCanary || sweepCanaryOrphans)) {
    throw new Error("--dry-run cannot be combined with a canary command");
  }
  if (
    [canary, finalizeCanary, sweepCanaryOrphans].filter(Boolean).length > 1
  ) {
    throw new Error("canary recovery commands cannot be combined");
  }
  if (!validateWebhookSecret && !dryRun && !canary && !finalizeCanary && !sweepCanaryOrphans) {
    throw new Error(
      "usage: live reconciliation requires --canary or --sweep-canary-orphans; use --dry-run to preview",
    );
  }
  const values = options.env ?? process.env;
  const log = options.log ?? console.log;

  if (validateWebhookSecret) {
    requireWebhookSecret(environment(values, "POSTIL_ILERT_WEBHOOK_SECRET"));
    log("POSTIL_ILERT_WEBHOOK_SECRET is valid");
    return;
  }

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
    });
    log("iLert canary cleanup is stabilized");
    return;
  }

  if (sweepCanaryOrphans) {
    await sweepIlertWebhookCanaryOrphans({
      apiKey: environment(values, "ILERT_API_KEY"),
      fetchFn: options.fetchFn,
      now: options.now,
      sleep: options.sleep,
      sourceId: requiredSourceId(values),
    });
    log("iLert orphan canary sweep is stabilized");
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
  if (canary) {
    await recordCanaryAlertSubmission(values, "unknown", runAttempt);
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
        onAlertAttempted: () => recordCanaryAlertSubmission(values, "unknown", runAttempt),
        onAlertSubmitted: async () => {
          alertAccepted = true;
          await recordCanaryAlertSubmission(values, "true", runAttempt);
        },
        runAttempt: runAttempt!,
        runId: runId!,
      });
    } catch (error) {
      await recordCanaryAlertSubmission(
        values,
        alertAccepted ? "true" : "unknown",
        runAttempt,
      );
      throw error;
    }
    await recordCanaryAlertSubmission(values, "cleaned", runAttempt);
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
  producerAttempt?: string,
): Promise<void> {
  const output = values.GITHUB_OUTPUT;
  if (!output) return;
  await appendFile(
    output,
    `alert_submitted=${submitted}\n${producerAttempt ? `producer_attempt=${producerAttempt}\n` : ""}`,
    "utf8",
  );
}

if (import.meta.main) await runCli();
