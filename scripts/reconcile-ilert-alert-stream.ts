#!/usr/bin/env bun

import { randomUUID } from "node:crypto";

const API_BASE = "https://api.ilert.com/api";
const WEBHOOK_URL = "https://postil.dev/api/webhooks/ilert";
const WEBHOOK_USERNAME = "postil-ilert";
const ACTION_NAME = "Postil operator alert stream";
const REQUEST_TIMEOUT_MS = 20_000;
const CANARY_ATTEMPTS = 12;
const CANARY_RETRY_MS = 5_000;

export const ALERT_TRIGGER_TYPES = [
  "alert-created",
  "alert-acknowledged",
  "alert-comment-added",
  "alert-resolved",
] as const;

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;

interface IlertAlertAction {
  id?: unknown;
  name?: unknown;
  connectorType?: unknown;
  triggerMode?: unknown;
  triggerTypes?: unknown;
  alertSources?: unknown;
  params?: unknown;
}

interface IlertAlertSource {
  id: number;
  name: string;
  integrationType: string;
  escalationPolicy: {
    id?: number;
    name: string;
    escalationRules: unknown[];
  };
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
  runId?: string;
  runAttempt?: string;
}

export type ReconcileOperation = "create" | "update" | "unchanged";

export interface ReconcileResult {
  actionId: string | null;
  operation: ReconcileOperation;
}

export function desiredAlertAction(
  source: IlertAlertSource,
  webhookSecret: string,
): Record<string, unknown> {
  const authorization = Buffer.from(
    `${WEBHOOK_USERNAME}:${webhookSecret}`,
    "utf8",
  ).toString("base64");
  return {
    alertSources: [source],
    connectorType: "webhook",
    name: ACTION_NAME,
    triggerMode: "AUTOMATIC",
    triggerTypes: [...ALERT_TRIGGER_TYPES],
    params: {
      webhookUrl: WEBHOOK_URL,
      headers: [{ key: "Authorization", value: `Basic ${authorization}` }],
    },
  };
}

export function equivalentAlertAction(
  actual: IlertAlertAction,
  desired: Record<string, unknown>,
): boolean {
  const actualSources = relationIds(actual.alertSources);
  const desiredSources = relationIds(desired.alertSources);
  const actualParams = record(actual.params);
  const desiredParams = record(desired.params);
  return (
    actual.name === desired.name &&
    actual.connectorType === desired.connectorType &&
    actual.triggerMode === desired.triggerMode &&
    sameStringSet(actual.triggerTypes, desired.triggerTypes) &&
    sameNumberSet(actualSources, desiredSources) &&
    actualParams?.webhookUrl === desiredParams?.webhookUrl &&
    sameHeaders(actualParams?.headers, desiredParams?.headers)
  );
}

export async function reconcileIlertAlertAction(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const source = alertSource(
    await ilertJson(
      fetchFn,
      options.apiKey,
      `/alert-sources/${options.sourceId}`,
    ),
    options.sourceId,
  );
  const desired = desiredAlertAction(source, options.webhookSecret);
  const listedActions = await listIlertAlertActions(
    fetchFn,
    options.apiKey,
  );
  const actions: unknown[] = [];
  for (let index = 0; index < listedActions.length; index += 8) {
    actions.push(
      ...(await Promise.all(
        listedActions.slice(index, index + 8).map((action) =>
          ilertJson(
            fetchFn,
            options.apiKey,
            `/alert-actions/${encodeURIComponent(requiredActionId(action))}`,
          ),
        ),
      )),
    );
  }

  const candidates = actions.filter((value): value is IlertAlertAction => {
    const action = record(value);
    if (!action) return false;
    const params = record(action.params);
    return action.name === ACTION_NAME || params?.webhookUrl === WEBHOOK_URL;
  });
  for (const candidate of candidates) {
    if (
      candidate.connectorType !== "webhook" ||
      !sameNumberSet(relationIds(candidate.alertSources), [options.sourceId])
    ) {
      throw new Error(
        "A conflicting Postil alert action exists; refusing to change its type or source scope",
      );
    }
  }
  if (candidates.length > 1) {
    throw new Error(
      "Multiple Postil webhook alert actions exist; refusing to choose or delete one",
    );
  }

  const existing = candidates[0];
  if (!existing) {
    if (options.dryRun) return { actionId: null, operation: "create" };
    const created = await ilertJson(fetchFn, options.apiKey, "/alert-actions", {
      method: "POST",
      body: JSON.stringify(desired),
    });
    const actionId = requiredActionId(created);
    await verifyReconciledAction(fetchFn, options.apiKey, actionId, desired);
    return { actionId, operation: "create" };
  }

  const actionId = requiredActionId(existing);
  if (equivalentAlertAction(existing, desired)) {
    return { actionId, operation: "unchanged" };
  }
  if (options.dryRun) return { actionId, operation: "update" };
  const updated = await ilertJson(
    fetchFn,
    options.apiKey,
    `/alert-actions/${encodeURIComponent(actionId)}`,
    { method: "PUT", body: JSON.stringify({ ...desired, id: actionId }) },
  );
  const updatedId = requiredActionId(updated);
  await verifyReconciledAction(fetchFn, options.apiKey, updatedId, desired);
  return { actionId: updatedId, operation: "update" };
}

export async function verifyIlertAlertStreamCanary(
  options: CanaryOptions,
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? Bun.sleep;
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  const canaryKey = [
    "postil-operator-alert-stream-canary",
    options.runId ?? "local",
    options.runAttempt ?? "1",
    randomUUID(),
  ].join("-");
  let alertAccepted = false;
  let resolveSent = false;
  let primaryError: unknown;

  try {
    await postIlertEvent(fetchFn, {
      integrationKey: options.integrationKey,
      eventType: "ALERT",
      summary: "Postil operator alert stream canary",
      details: "GitHub Actions is verifying the Postil operator notification path.",
      alertKey: canaryKey,
      priority: "HIGH",
    });
    alertAccepted = true;

    const created = await waitForCanaryDelivery({
      actionId: options.actionId,
      apiKey: options.apiKey,
      canaryKey,
      fetchFn,
      sleep,
      startedAt,
    });
    await postIlertEvent(fetchFn, {
      integrationKey: options.integrationKey,
      eventType: "RESOLVE",
      summary: "Postil operator alert stream canary resolved",
      alertKey: canaryKey,
    });
    resolveSent = true;
    await waitForCanaryDelivery({
      actionId: options.actionId,
      alertId: created.alertId,
      apiKey: options.apiKey,
      canaryKey,
      fetchFn,
      minimumSuccessfulDeliveries: created.successfulDeliveries + 1,
      requiredStatus: "RESOLVED",
      sleep,
      startedAt,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (alertAccepted && !resolveSent) {
      try {
        await postIlertEvent(fetchFn, {
          integrationKey: options.integrationKey,
          eventType: "RESOLVE",
          summary: "Postil operator alert stream canary resolved",
          alertKey: canaryKey,
        });
      } catch (resolveError) {
        if (primaryError === undefined) throw resolveError;
      }
    }
  }
}

interface WaitForCanaryOptions {
  actionId: string;
  alertId?: string;
  apiKey: string;
  canaryKey: string;
  fetchFn: Fetch;
  minimumSuccessfulDeliveries?: number;
  requiredStatus?: string;
  sleep: Sleep;
  startedAt: string;
}

async function waitForCanaryDelivery(
  options: WaitForCanaryOptions,
): Promise<{ alertId: string; successfulDeliveries: number }> {
  for (let attempt = 0; attempt < CANARY_ATTEMPTS; attempt += 1) {
    const alerts = await ilertJson(
      options.fetchFn,
      options.apiKey,
      `/alerts?from=${encodeURIComponent(options.startedAt)}&max-results=100`,
    );
    if (!Array.isArray(alerts)) {
      throw new Error("iLert returned an invalid alert list during the canary");
    }
    const alert = alerts.find(
      (value) => record(value)?.alertKey === options.canaryKey,
    );
    const alertRecord = record(alert);
    const alertId = positiveAlertId(alertRecord?.id);
    if (alertId && (!options.alertId || options.alertId === alertId)) {
      const actions = await ilertJson(
        options.fetchFn,
        options.apiKey,
        `/alerts/${encodeURIComponent(alertId)}/actions`,
      );
      const successfulDeliveries = successfulActionDeliveries(
        actions,
        options.actionId,
      );
      if (
        successfulDeliveries >= (options.minimumSuccessfulDeliveries ?? 1) &&
        (!options.requiredStatus || alertRecord?.status === options.requiredStatus)
      ) {
        return { alertId, successfulDeliveries };
      }
    }
    if (attempt + 1 < CANARY_ATTEMPTS) await options.sleep(CANARY_RETRY_MS);
  }
  throw new Error("iLert did not confirm successful Postil webhook delivery");
}

function successfulActionDeliveries(value: unknown, actionId: string): number {
  const actions = Array.isArray(value) ? value : [value];
  if (actions.some((action) => !record(action))) {
    throw new Error("iLert returned invalid action history during the canary");
  }
  return actions
    .filter((action) => record(action)?.alertActionId === actionId)
    .flatMap((action) => {
      const history = record(action)?.history;
      if (!Array.isArray(history)) return [];
      return history;
    })
    .filter((entry) => record(entry)?.success === true).length;
}

async function postIlertEvent(
  fetchFn: Fetch,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetchWithTimeout(fetchFn, `${API_BASE}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`iLert event request failed with HTTP ${response.status}`);
  }
}

async function ilertJson(
  fetchFn: Fetch,
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetchWithTimeout(fetchFn, `${API_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: apiKey,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`iLert management request failed with HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("iLert returned invalid JSON");
  }
}

async function listIlertAlertActions(
  fetchFn: Fetch,
  apiKey: string,
): Promise<IlertAlertAction[]> {
  const actions: IlertAlertAction[] = [];
  for (let startIndex = 0; startIndex <= 1_000; startIndex += 100) {
    const page = await ilertJson(
      fetchFn,
      apiKey,
      `/alert-actions?start-index=${startIndex}&max-results=100`,
    );
    if (!Array.isArray(page) || page.some((value) => !record(value))) {
      throw new Error("iLert returned an invalid alert-action list");
    }
    actions.push(...(page as IlertAlertAction[]));
    if (page.length < 100) return actions;
  }
  throw new Error("iLert alert-action pagination exceeded the safety bound");
}

async function verifyReconciledAction(
  fetchFn: Fetch,
  apiKey: string,
  actionId: string,
  desired: Record<string, unknown>,
): Promise<void> {
  const confirmed = await ilertJson(
    fetchFn,
    apiKey,
    `/alert-actions/${encodeURIComponent(actionId)}`,
  );
  const action = record(confirmed);
  if (!action || !equivalentAlertAction(action, desired)) {
    throw new Error("iLert did not retain the reconciled alert action");
  }
}

async function fetchWithTimeout(
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function requiredActionId(value: unknown): string {
  const id = opaqueActionId(record(value)?.id);
  if (!id) throw new Error("iLert returned an alert action without an identity");
  return id;
}

function alertSource(value: unknown, expectedId: number): IlertAlertSource {
  const source = record(value);
  const escalationPolicy = record(source?.escalationPolicy);
  const id = positiveSafeNumber(source?.id);
  const name = source?.name;
  const integrationType = source?.integrationType;
  const policyName = escalationPolicy?.name;
  const escalationRules = escalationPolicy?.escalationRules;
  if (
    id !== expectedId ||
    typeof name !== "string" ||
    name.length === 0 ||
    typeof integrationType !== "string" ||
    integrationType.length === 0 ||
    typeof policyName !== "string" ||
    policyName.length === 0 ||
    !Array.isArray(escalationRules)
  ) {
    throw new Error("iLert returned an invalid alert source");
  }
  const policyId = positiveSafeNumber(escalationPolicy?.id);
  return {
    id,
    name,
    integrationType,
    escalationPolicy: {
      ...(policyId === null ? {} : { id: policyId }),
      name: policyName,
      escalationRules,
    },
  };
}

function positiveSafeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function opaqueActionId(value: unknown): string | null {
  if (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return null;
}

function positiveAlertId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return value;
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function relationIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const id = record(entry)?.id;
    const parsed = positiveSafeNumber(id);
    return parsed === null ? [] : [parsed];
  });
}

function sameStringSet(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (!left.every((value) => typeof value === "string")) return false;
  if (!right.every((value) => typeof value === "string")) return false;
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function sameNumberSet(left: number[], right: number[]): boolean {
  return [...left].sort((a, b) => a - b).join("\0") ===
    [...right].sort((a, b) => a - b).join("\0");
}

function sameHeaders(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  const normalize = (values: unknown[]) =>
    values
      .map((value) => record(value))
      .filter((value): value is Record<string, unknown> => value !== null)
      .map((value) => `${String(value.key).toLowerCase()}:${String(value.value)}`)
      .sort();
  return normalize(left).join("\0") === normalize(right).join("\0");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sourceIdFromEnvironment(): number {
  const raw = requiredEnvironment("POSTIL_ILERT_ALERT_SOURCE_ID");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw) {
    throw new Error("POSTIL_ILERT_ALERT_SOURCE_ID must be a positive integer");
  }
  return value;
}

async function main(): Promise<void> {
  const allowed = new Set(["--dry-run", "--canary"]);
  if (process.argv.slice(2).some((argument) => !allowed.has(argument))) {
    throw new Error("usage: reconcile-ilert-alert-stream.ts [--dry-run] [--canary]");
  }
  const dryRun = process.argv.includes("--dry-run");
  const canary = process.argv.includes("--canary");
  if (dryRun && canary) throw new Error("--canary cannot be combined with --dry-run");

  const apiKey = requiredEnvironment("ILERT_API_KEY");
  const result = await reconcileIlertAlertAction({
    apiKey,
    sourceId: sourceIdFromEnvironment(),
    webhookSecret: requiredEnvironment("POSTIL_ILERT_WEBHOOK_SECRET"),
    dryRun,
  });
  console.log(
    dryRun
      ? `iLert alert-stream reconciliation plan: ${result.operation}`
      : `iLert alert-stream reconciliation: ${result.operation}`,
  );
  if (canary) {
    if (!result.actionId) throw new Error("the reconciled alert action has no identity");
    await verifyIlertAlertStreamCanary({
      actionId: result.actionId,
      apiKey,
      integrationKey: requiredEnvironment("ILERT_INTEGRATION_KEY"),
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    });
    console.log("iLert confirmed successful Postil webhook delivery");
  }
}

if (import.meta.main) {
  await main();
}
