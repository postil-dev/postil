import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import { PostHog } from "posthog-node/edge";
import type { BeforeSendFn, PostHogOptions } from "posthog-node";

import type { OperationalModelIncidentClassification } from "@/lib/envelope";

export type ObservabilityProcessGroup = "web" | "worker" | "monitor";
export type OperationalFailureClass =
  | "web_request_failed"
  | "worker_boot_failed"
  | "job_permanently_failed"
  | "webhook_recovery_failed"
  | "monitor_boot_failed"
  | "monitor_pass_failed"
  | "monitor_notification_failed";
export type OperationalState = "worker_started" | "monitor_started";
export type OperationalWarning = "job_retrying" | "webhook_recovery_retrying";

type OperationalLogEvent =
  | "postil.web.request.failed"
  | "postil.worker.boot.failed"
  | "postil.job.permanently_failed"
  | "postil.job.retrying"
  | "postil.webhook.recovery.failed"
  | "postil.webhook.recovery.retrying"
  | "postil.model.incident"
  | "postil.worker.started"
  | "postil.monitor.started"
  | "postil.monitor.boot.failed"
  | "postil.monitor.pass.failed"
  | "postil.monitor.notification.failed";

interface ObservabilityEnvironment {
  POSTHOG_ERROR_CAPTURE?: string;
  POSTHOG_LOG_CAPTURE?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  NEXT_PUBLIC_POSTHOG_KEY?: string;
  NEXT_PUBLIC_POSTHOG_HOST?: string;
  POSTHOG_LOG_WARN_SAMPLE_RATE?: string;
  POSTHOG_LOG_INFO_SAMPLE_RATE?: string;
  POSTHOG_LOG_MAX_PER_MINUTE?: string;
  POSTHOG_ERROR_MAX_PER_HOUR?: string;
  POSTIL_RELEASE_SHA?: string;
  NODE_ENV?: string;
}

interface ServerObservabilityOptions {
  processGroup: ObservabilityProcessGroup;
  environment?: ObservabilityEnvironment;
  now?: () => number;
  posthogFetch?: PostHogOptions["fetch"];
  logExporter?: LogRecordExporter;
}

interface OperationalEventDefinition {
  event: OperationalLogEvent;
  severityNumber: SeverityNumber;
  severityText: "ERROR" | "FATAL";
}

const FAILURE_EVENTS: Record<OperationalFailureClass, OperationalEventDefinition> = {
  web_request_failed: {
    event: "postil.web.request.failed",
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
  },
  worker_boot_failed: {
    event: "postil.worker.boot.failed",
    severityNumber: SeverityNumber.FATAL,
    severityText: "FATAL",
  },
  job_permanently_failed: {
    event: "postil.job.permanently_failed",
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
  },
  webhook_recovery_failed: {
    event: "postil.webhook.recovery.failed",
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
  },
  monitor_boot_failed: {
    event: "postil.monitor.boot.failed",
    severityNumber: SeverityNumber.FATAL,
    severityText: "FATAL",
  },
  monitor_pass_failed: {
    event: "postil.monitor.pass.failed",
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
  },
  monitor_notification_failed: {
    event: "postil.monitor.notification.failed",
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
  },
};

const STATE_EVENTS: Record<OperationalState, OperationalLogEvent> = {
  worker_started: "postil.worker.started",
  monitor_started: "postil.monitor.started",
};

const WARNING_EVENTS: Record<OperationalWarning, OperationalLogEvent> = {
  job_retrying: "postil.job.retrying",
  webhook_recovery_retrying: "postil.webhook.recovery.retrying",
};

const SYSTEM_DISTINCT_ID = "postil-system";
const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";
const ERROR_DEDUPLICATION_MS = 10 * 60 * 1000;
const MAX_STACK_FRAMES = 20;
const RELEASE_SHA = /^[0-9a-f]{7,40}$/i;
const FAILURE_CLASSES = new Set<OperationalFailureClass>(
  Object.keys(FAILURE_EVENTS) as OperationalFailureClass[],
);
const PROCESS_GROUPS = new Set<ObservabilityProcessGroup>(["web", "worker", "monitor"]);
const MODEL_INCIDENT_PHASES = new Set(["review", "scorer"]);
const TYPED_MODEL_INCIDENT_CATEGORIES = new Set([
  "providerError",
  "invalidOutput",
  "timeout",
  "deadline",
]);
const MODEL_INCIDENT_CATEGORIES = new Set([
  ...TYPED_MODEL_INCIDENT_CATEGORIES,
  "operational",
]);
const MODEL_INCIDENT_RECOVERIES = new Set(["repair", "fallback"]);
const MODEL_INCIDENT_SOURCES = new Set([
  "model_incident",
  "provider_sentinel",
  "model_output_sentinel",
  "operational_sentinel",
]);

export class ServerObservability {
  private readonly now: () => number;
  private readonly processGroup: ObservabilityProcessGroup;
  private readonly deploymentEnvironment: "production" | "development";
  private readonly release: string;
  private readonly posthog?: PostHog;
  private readonly loggerProvider?: LoggerProvider;
  private readonly logger?: ReturnType<LoggerProvider["getLogger"]>;
  private readonly warnSampleRate: number;
  private readonly infoSampleRate: number;
  private readonly logMaxPerMinute: number;
  private readonly errorMaxPerHour: number;
  private logWindow = -1;
  private logWindowCount = 0;
  private errorWindow = -1;
  private errorWindowCount = 0;
  private readonly errorFingerprints = new Map<number, number>();

  constructor(options: ServerObservabilityOptions) {
    const environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
    this.processGroup = options.processGroup;
    this.deploymentEnvironment =
      environment.NODE_ENV === "production" ? "production" : "development";
    this.release = safeRelease(environment.POSTIL_RELEASE_SHA);
    this.warnSampleRate = safeRate(environment.POSTHOG_LOG_WARN_SAMPLE_RATE, 0.1);
    this.infoSampleRate = safeRate(environment.POSTHOG_LOG_INFO_SAMPLE_RATE, 0.01);
    this.logMaxPerMinute = safePositiveInteger(
      environment.POSTHOG_LOG_MAX_PER_MINUTE,
      60,
    );
    this.errorMaxPerHour = safePositiveInteger(
      environment.POSTHOG_ERROR_MAX_PER_HOUR,
      10,
    );

    const token = environment.POSTHOG_PROJECT_TOKEN ?? environment.NEXT_PUBLIC_POSTHOG_KEY;
    const host = safePostHogHost(environment.NEXT_PUBLIC_POSTHOG_HOST);
    if (environment.POSTHOG_ERROR_CAPTURE === "1" && token) {
      this.posthog = new PostHog(token, {
        host,
        enableExceptionAutocapture: false,
        disableGeoip: true,
        disableRemoteConfig: true,
        disableRemoteFeatureFlags: true,
        sendFeatureFlagEvent: false,
        flushAt: 10,
        flushInterval: 1_000,
        requestTimeout: 3_000,
        fetchRetryCount: 0,
        disableCompression: true,
        fetch: options.posthogFetch,
        before_send: sanitizePostHogEvent,
      });
    }

    if (environment.POSTHOG_LOG_CAPTURE === "1" && token) {
      const exporter =
        options.logExporter ??
        new OTLPLogExporter({
          url: new URL("/i/v1/logs", `${host}/`).toString(),
          headers: { Authorization: `Bearer ${token}` },
          timeoutMillis: 3_000,
        });
      this.loggerProvider = new LoggerProvider({
        resource: resourceFromAttributes({
          "service.name": `postil-${this.processGroup}`,
          "service.version": this.release,
          "deployment.environment": this.deploymentEnvironment,
          "process.group": this.processGroup,
        }),
        logRecordLimits: {
          attributeCountLimit: 8,
          attributeValueLengthLimit: 80,
        },
        processors: [
          new BatchLogRecordProcessor({
            exporter,
            maxQueueSize: 256,
            maxExportBatchSize: 32,
            scheduledDelayMillis: 1_000,
            exportTimeoutMillis: 3_000,
          }),
        ],
      });
      this.logger = this.loggerProvider.getLogger("postil-operational", this.release);
    }
  }

  reportFailure(failureClass: OperationalFailureClass, error: unknown): void {
    const definition = FAILURE_EVENTS[failureClass];
    const timestamp = this.now();
    const sanitizedError = sanitizeOperationalError(failureClass, error);

    if (this.posthog && this.consumeErrorAllowance(sanitizedError.stack ?? failureClass, timestamp)) {
      this.posthog.captureException(sanitizedError, SYSTEM_DISTINCT_ID, {
        "$process_person_profile": false,
        "$geoip_disable": true,
        "postil.failure_class": failureClass,
        "postil.process_group": this.processGroup,
        "service.name": `postil-${this.processGroup}`,
        "service.version": this.release,
        "deployment.environment": this.deploymentEnvironment,
      });
    }

    this.emitLog(definition.event, definition.severityNumber, definition.severityText, {
      failureClass,
      outcome: "failure",
      sampleRate: 1,
      timestamp,
    });
  }

  reportState(state: OperationalState): void {
    this.emitLog(STATE_EVENTS[state], SeverityNumber.INFO, "INFO", {
      outcome: "success",
      sampleRate: this.infoSampleRate,
      timestamp: this.now(),
    });
  }

  reportWarning(warning: OperationalWarning): void {
    this.emitLog(WARNING_EVENTS[warning], SeverityNumber.WARN, "WARN", {
      outcome: "retrying",
      sampleRate: this.warnSampleRate,
      timestamp: this.now(),
    });
  }

  reportModelIncident(incident: OperationalModelIncidentClassification): void {
    if (!isOperationalModelIncidentClassification(incident)) return;
    const timestamp = this.now();
    if (
      this.posthog &&
      this.consumeErrorAllowance(modelIncidentFingerprint(incident), timestamp)
    ) {
      this.posthog.capture({
        distinctId: SYSTEM_DISTINCT_ID,
        event: "postil_model_incident",
        properties: {
          "$process_person_profile": false,
          "$geoip_disable": true,
          "postil.process_group": this.processGroup,
          "postil.incident_phase": incident.phase,
          "postil.incident_category": incident.category,
          "postil.incident_recovered": incident.recovered,
          ...(incident.recovery
            ? { "postil.incident_recovery": incident.recovery }
            : {}),
          "postil.incident_source": incident.source,
          "service.name": `postil-${this.processGroup}`,
          "service.version": this.release,
          "deployment.environment": this.deploymentEnvironment,
        },
        sendFeatureFlags: false,
      });
    }

    this.emitLog(
      "postil.model.incident",
      incident.recovered ? SeverityNumber.WARN : SeverityNumber.ERROR,
      incident.recovered ? "WARN" : "ERROR",
      {
        incident,
        outcome: incident.recovered ? "recovered" : "failure",
        sampleRate: incident.recovered ? this.warnSampleRate : 1,
        timestamp,
      },
    );
  }

  async shutdown(): Promise<void> {
    const operations: Promise<unknown>[] = [];
    if (this.posthog) operations.push(this.posthog.shutdown(3_000));
    if (this.loggerProvider) operations.push(this.loggerProvider.shutdown());
    await Promise.allSettled(operations);
  }

  private emitLog(
    event: OperationalLogEvent,
    severityNumber: SeverityNumber,
    severityText: "INFO" | "WARN" | "ERROR" | "FATAL",
    options: {
      failureClass?: OperationalFailureClass;
      incident?: OperationalModelIncidentClassification;
      outcome: "success" | "retrying" | "recovered" | "failure";
      sampleRate: number;
      timestamp: number;
    },
  ): void {
    if (!this.logger) return;
    if (!sampled(event, this.processGroup, options.timestamp, options.sampleRate)) return;
    if (!this.consumeLogAllowance(options.timestamp)) return;

    this.logger.emit({
      eventName: event,
      severityNumber,
      severityText,
      body: event,
      timestamp: options.timestamp,
      attributes: {
        "event.name": event,
        outcome: options.outcome,
        ...(options.failureClass ? { "failure.class": options.failureClass } : {}),
        ...(options.incident
          ? {
              "incident.phase": options.incident.phase,
              "incident.category": options.incident.category,
              "incident.recovered": options.incident.recovered,
              ...(options.incident.recovery
                ? { "incident.recovery": options.incident.recovery }
                : {}),
              "incident.source": options.incident.source,
            }
          : {}),
      },
    });
  }

  private consumeLogAllowance(timestamp: number): boolean {
    const window = Math.floor(timestamp / 60_000);
    if (window !== this.logWindow) {
      this.logWindow = window;
      this.logWindowCount = 0;
    }
    if (this.logWindowCount >= this.logMaxPerMinute) return false;
    this.logWindowCount += 1;
    return true;
  }

  private consumeErrorAllowance(stack: string, timestamp: number): boolean {
    const fingerprint = stableHash(stack);
    const lastSeen = this.errorFingerprints.get(fingerprint);
    if (lastSeen !== undefined && timestamp - lastSeen < ERROR_DEDUPLICATION_MS) return false;

    const window = Math.floor(timestamp / (60 * 60 * 1000));
    if (window !== this.errorWindow) {
      this.errorWindow = window;
      this.errorWindowCount = 0;
      for (const [key, seenAt] of this.errorFingerprints) {
        if (timestamp - seenAt >= ERROR_DEDUPLICATION_MS) this.errorFingerprints.delete(key);
      }
    }
    if (this.errorWindowCount >= this.errorMaxPerHour) return false;
    this.errorWindowCount += 1;
    this.errorFingerprints.set(fingerprint, timestamp);
    return true;
  }
}

const productionInstances = new Map<ObservabilityProcessGroup, ServerObservability>();

export function reportOperationalFailure(
  processGroup: ObservabilityProcessGroup,
  failureClass: OperationalFailureClass,
  error: unknown,
): void {
  try {
    productionInstance(processGroup).reportFailure(failureClass, error);
  } catch {
    // Observability must never alter request or worker failure handling.
  }
}

export function reportOperationalState(
  processGroup: ObservabilityProcessGroup,
  state: OperationalState,
): void {
  try {
    productionInstance(processGroup).reportState(state);
  } catch {
    // Observability must never alter worker startup.
  }
}

export function reportOperationalWarning(
  processGroup: ObservabilityProcessGroup,
  warning: OperationalWarning,
): void {
  try {
    productionInstance(processGroup).reportWarning(warning);
  } catch {
    // Observability must never alter retry handling.
  }
}

export function reportOperationalModelIncident(
  processGroup: ObservabilityProcessGroup,
  incident: OperationalModelIncidentClassification,
): void {
  try {
    productionInstance(processGroup).reportModelIncident(incident);
  } catch {
    // Observability must never alter review completion.
  }
}

export async function shutdownServerObservability(
  processGroup?: ObservabilityProcessGroup,
): Promise<void> {
  const instances = processGroup
    ? [productionInstances.get(processGroup)]
    : Array.from(productionInstances.values());
  await Promise.all(instances.filter(Boolean).map((instance) => instance!.shutdown()));
  if (processGroup) productionInstances.delete(processGroup);
  else productionInstances.clear();
}

function productionInstance(processGroup: ObservabilityProcessGroup): ServerObservability {
  let instance = productionInstances.get(processGroup);
  if (!instance) {
    instance = new ServerObservability({ processGroup });
    productionInstances.set(processGroup, instance);
  }
  return instance;
}

export function sanitizeOperationalError(
  failureClass: OperationalFailureClass,
  error: unknown,
): Error {
  const sanitized = new Error(failureClass);
  sanitized.name = "PostilOperationalError";
  sanitized.stack = sanitizeStack(error, failureClass);
  return sanitized;
}

function sanitizeStack(error: unknown, failureClass: OperationalFailureClass): string {
  const header = `PostilOperationalError: ${failureClass}`;
  if (!(error instanceof Error) || typeof error.stack !== "string") return header;
  const frames = error.stack
    .split("\n")
    .slice(1)
    .map(sanitizeStackFrame)
    .filter((frame): frame is string => Boolean(frame))
    .slice(0, MAX_STACK_FRAMES);
  return [header, ...frames].join("\n");
}

function sanitizeStackFrame(line: string): string | undefined {
  const location = line.match(/(?:\(|\s)([^()\s]+):(\d+):(\d+)\)?\s*$/);
  if (!location) return undefined;
  const rawPath = location[1]?.replace(/^file:\/\//, "");
  const lineNumber = location[2];
  const columnNumber = location[3];
  if (!rawPath || !lineNumber || !columnNumber) return undefined;

  const sourceIndex = rawPath.lastIndexOf("/src/");
  const buildIndex = rawPath.lastIndexOf("/.next/server/");
  let safePath: string | undefined;
  if (sourceIndex >= 0) safePath = rawPath.slice(sourceIndex + 1);
  else if (rawPath.startsWith("src/")) safePath = rawPath;
  else if (buildIndex >= 0) safePath = rawPath.slice(buildIndex + 1);
  else if (rawPath.startsWith(".next/server/")) safePath = rawPath;
  if (!safePath || safePath.includes("..")) return undefined;
  return `    at ${safePath}:${lineNumber}:${columnNumber}`;
}

function sanitizePostHogEvent(
  event: Parameters<BeforeSendFn>[0],
): ReturnType<BeforeSendFn> {
  if (!event?.properties) return null;
  if (event.event === "$exception") return sanitizePostHogExceptionEvent(event);
  if (event.event === "postil_model_incident") return sanitizePostHogModelIncident(event);
  return null;
}

function sanitizePostHogExceptionEvent(
  event: NonNullable<Parameters<BeforeSendFn>[0]>,
): ReturnType<BeforeSendFn> {
  const properties = event.properties;
  if (!properties) return null;
  const failureClass = properties["postil.failure_class"];
  const processGroup = properties["postil.process_group"];
  if (
    typeof failureClass !== "string" ||
    !FAILURE_CLASSES.has(failureClass as OperationalFailureClass) ||
    typeof processGroup !== "string" ||
    !PROCESS_GROUPS.has(processGroup as ObservabilityProcessGroup)
  ) {
    return null;
  }

  const exception = firstException(properties.$exception_list);
  const token = properties.token;
  const safeProperties: Record<string, unknown> = {
    ...(typeof token === "string" ? { token } : {}),
    $exception_list: [
      {
        type: "PostilOperationalError",
        value: failureClass,
        mechanism: { type: "generic", handled: true, synthetic: false },
        ...(exception.frames.length > 0
          ? { stacktrace: { type: "raw", frames: exception.frames } }
          : {}),
      },
    ],
    $exception_level: "error",
    $process_person_profile: false,
    $geoip_disable: true,
    "postil.failure_class": failureClass,
    "postil.process_group": processGroup,
    "service.name": `postil-${processGroup}`,
    "service.version": safeRelease(properties["service.version"]),
    "deployment.environment":
      properties["deployment.environment"] === "production"
        ? "production"
        : "development",
  };

  return {
    ...event,
    distinctId: SYSTEM_DISTINCT_ID,
    groups: undefined,
    flags: undefined,
    sendFeatureFlags: false,
    disableGeoip: true,
    properties: safeProperties,
  };
}

function sanitizePostHogModelIncident(
  event: NonNullable<Parameters<BeforeSendFn>[0]>,
): ReturnType<BeforeSendFn> {
  const properties = event.properties;
  if (!properties) return null;
  const processGroup = properties["postil.process_group"];
  const phase = properties["postil.incident_phase"];
  const category = properties["postil.incident_category"];
  const recovered = properties["postil.incident_recovered"];
  const recovery = properties["postil.incident_recovery"];
  const source = properties["postil.incident_source"];
  if (
    typeof processGroup !== "string" ||
    !PROCESS_GROUPS.has(processGroup as ObservabilityProcessGroup) ||
    typeof phase !== "string" ||
    !MODEL_INCIDENT_PHASES.has(phase) ||
    typeof category !== "string" ||
    !MODEL_INCIDENT_CATEGORIES.has(category) ||
    typeof recovered !== "boolean" ||
    typeof source !== "string" ||
    !MODEL_INCIDENT_SOURCES.has(source) ||
    !isValidModelIncidentTuple({ phase, category, recovered, recovery, source })
  ) {
    return null;
  }

  const token = properties.token;
  return {
    ...event,
    distinctId: SYSTEM_DISTINCT_ID,
    groups: undefined,
    flags: undefined,
    sendFeatureFlags: false,
    disableGeoip: true,
    properties: {
      ...(typeof token === "string" ? { token } : {}),
      $process_person_profile: false,
      $geoip_disable: true,
      "postil.process_group": processGroup,
      "postil.incident_phase": phase,
      "postil.incident_category": category,
      "postil.incident_recovered": recovered,
      ...(typeof recovery === "string"
        ? { "postil.incident_recovery": recovery }
        : {}),
      "postil.incident_source": source,
      "service.name": `postil-${processGroup}`,
      "service.version": safeRelease(properties["service.version"]),
      "deployment.environment":
        properties["deployment.environment"] === "production"
          ? "production"
          : "development",
    },
  };
}

function firstException(value: unknown): { frames: Array<Record<string, unknown>> } {
  if (!Array.isArray(value) || !isRecord(value[0])) return { frames: [] };
  const stacktrace = value[0].stacktrace;
  if (!isRecord(stacktrace) || !Array.isArray(stacktrace.frames)) return { frames: [] };
  return {
    frames: stacktrace.frames
      .filter(isRecord)
      .map(sanitizePostHogFrame)
      .filter((frame): frame is Record<string, unknown> => Boolean(frame))
      .slice(0, MAX_STACK_FRAMES),
  };
}

function sanitizePostHogFrame(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof frame.filename !== "string") return undefined;
  const safeFrame = sanitizeStackFrame(
    ` at ${frame.filename}:${integer(frame.lineno)}:${integer(frame.colno)}`,
  );
  if (!safeFrame) return undefined;
  const match = safeFrame.match(/^\s*at (.+):(\d+):(\d+)$/);
  if (!match) return undefined;
  return {
    platform: "node:javascript",
    filename: match[1],
    lineno: Number(match[2]),
    colno: Number(match[3]),
    in_app: true,
  };
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperationalModelIncidentClassification(
  incident: OperationalModelIncidentClassification,
): boolean {
  return isValidModelIncidentTuple(incident);
}

function isValidModelIncidentTuple(incident: {
  phase: unknown;
  category: unknown;
  recovered: unknown;
  recovery?: unknown;
  source: unknown;
}): boolean {
  if (
    typeof incident.source !== "string" ||
    !MODEL_INCIDENT_SOURCES.has(incident.source) ||
    typeof incident.phase !== "string" ||
    !MODEL_INCIDENT_PHASES.has(incident.phase) ||
    typeof incident.category !== "string" ||
    !MODEL_INCIDENT_CATEGORIES.has(incident.category) ||
    typeof incident.recovered !== "boolean"
  ) {
    return false;
  }
  if (incident.source === "model_incident") {
    const recovery = incident.recovery;
    if (
      recovery !== undefined &&
      (typeof recovery !== "string" || !MODEL_INCIDENT_RECOVERIES.has(recovery))
    ) {
      return false;
    }
    return (
      TYPED_MODEL_INCIDENT_CATEGORIES.has(incident.category) &&
      incident.recovered === (typeof recovery === "string")
    );
  }
  if (incident.recovery !== undefined || incident.recovered) return false;
  return (
    (incident.source === "provider_sentinel" &&
      incident.phase === "review" &&
      incident.category === "providerError") ||
    (incident.source === "model_output_sentinel" &&
      incident.phase === "review" &&
      incident.category === "invalidOutput") ||
    (incident.source === "operational_sentinel" &&
      incident.phase === "review" &&
      incident.category === "operational")
  );
}

function modelIncidentFingerprint(
  incident: OperationalModelIncidentClassification,
): string {
  return [
    "model_incident",
    incident.phase,
    incident.category,
    incident.recovered ? "recovered" : "unrecovered",
    incident.recovery ?? "none",
    incident.source,
  ].join(":");
}

function sampled(
  event: OperationalLogEvent,
  processGroup: ObservabilityProcessGroup,
  timestamp: number,
  rate: number,
): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const minute = Math.floor(timestamp / 60_000);
  return stableHash(`${event}:${processGroup}:${minute}`) / 0x1_0000_0000 < rate;
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function safePostHogHost(value: string | undefined): string {
  try {
    const url = new URL(value ?? DEFAULT_POSTHOG_HOST);
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_POSTHOG_HOST;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_POSTHOG_HOST;
  }
}

function safeRelease(value: unknown): string {
  return typeof value === "string" && RELEASE_SHA.test(value) ? value.toLowerCase() : "unknown";
}

function safeRate(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function safePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
