import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { validateApiBase } from "@/lib/api-base";
import { calculateUsageCostMicrosForModel } from "@/lib/billing-credits";
import {
  parseApiFormat,
  validateAdditionalAuthHeader,
  validateAdditionalAuthValue,
  type ApiFormat,
} from "@/lib/byok-provider";
import {
  canProcessRepositoryInference,
  providerModeMatchesRepositoryAccess,
} from "@/lib/private-repository-entitlement";
import { getSealingKey, unseal } from "@/lib/crypto/seal";
import { getDb, getPool, schema, type Database } from "@/lib/db";
import {
  hostedInferenceAvailable,
  hostedInferenceEnabled,
  optionalEnv,
  requireEnv,
} from "@/lib/env";
import {
  classifyOperationalModelIncidents,
  ingestEnvelope,
  isEnvelopeOperationallyUnavailable,
  type Envelope,
} from "@/lib/envelope";
import { getInstallationToken } from "@/lib/github/app-auth";
import { observeGitHubReviewThreads } from "@/lib/github/publication-threads";
import { fetchRepositorySummary } from "@/lib/github/installation-sync";
import {
  ADVISORY_CHECK_NAME,
  AmbiguousCheckRunCreationError,
  CheckRunPublicationError,
  GATE_CHECK_NAME,
  checkRunExternalId,
  completeCheckRun,
  completeExpectedCheckRun,
  createCheckRun,
  findCheckRunByExternalId,
  getPullRequestReviewContext,
  getPullRequestPublicationContext,
  verifyCompletedCheckRun,
  type ExpectedCheckRunIdentity,
} from "@/lib/github/checks";
import release from "@/data/public-cli-release.json";
import {
  buildGitHubPublicationInputIdentity,
  runGitHubPublicationCliPlanning,
} from "@/lib/github-publication-cli-planner";
import { buildGitHubPublicationControllerManifest } from "@/lib/github-publication-controller-manifest";
import { PostgresGitHubPublicationOperationStore } from "@/lib/github-publication-operation-store";
import {
  githubPublicationEnvelopeDigest,
  stageGitHubPublicationCandidateAtomically,
} from "@/lib/github-publication-atomic-stage";
import { loadAndDeriveGitHubPublicationReceipt } from "@/lib/github-publication-receipt-deriver";
import {
  materializeOrgConfig,
  materializeRepoConfig,
  materializeSharedConfig,
  buildConfigProvenance,
  missingRepositoryConfigSlots,
  type ConfigProvenanceEntry,
  type OrgReviewConfig,
} from "@/lib/github/contents";
import {
  createOwnerConfigStore,
  resolveOwnerGithubConfig,
} from "@/lib/github/owner-config";
import { configuredPublicOrigin, reviewDetailsUrl } from "@/lib/oauth";
import {
  reconcileConservativeHostedReviewSpend,
  reconcileHostedReviewSpendFromReceipt,
  releaseHostedReviewSpend,
  reserveHostedReviewSpend,
} from "@/lib/hosted-usage-reservations";
import { claimPausedHostedReview } from "@/lib/hosted-review-pause";
import { withoutOrgModelConfig } from "@/lib/org-review-config";
import {
  externalSideEffectLeaseActive,
  COALESCED_REVIEW_PAYLOAD_KEY,
  enqueueObservedReviewSnapshot,
  pendingReviewInputSupersedes,
  providerRetryLineageForJob,
  PermanentJobError,
  reviewInputLeaseState,
  withReviewPublicationFence,
  type CheckRunCleanupJobPayload,
  type JobLease,
  type ReviewInputLeaseState,
  type ReviewJobPayload,
} from "@/lib/queue";
import {
  normalizeReviewTriggerContext,
  reviewRequiresFullDiff,
} from "@/lib/review-trigger";
import {
  claimReusableLargeReviewReservation,
  hashEffectiveReviewConfiguration,
  PostgresLargeReviewAttemptStore,
  privateUpstreamAllowed,
  providerIdentity,
  startLargeReviewProviderProxy,
  type LargeReviewProviderProxy,
} from "@/lib/large-review-resume";
import { redactAndTruncate, redactSecrets } from "@/lib/redact";
import {
  finalizeStagedReviewCompletionWithGateMode,
  finalizePublicationControllerReview,
  markReviewStaleWithDurableCleanup,
  OPERATIONAL_NO_VERDICT_MESSAGE,
  stageReviewCompletionCandidate,
  type StaleReviewCleanupIdentity,
  type ReviewCompletionInput,
} from "@/lib/review-completion";
import {
  getInstallationGateEnabled,
  getOrganizationGateEnabled,
} from "@/lib/gate-mode";
import { discoverPreventionCommands } from "@/lib/review-guidance";
import { HOSTED_REVIEW_UNAVAILABLE_MESSAGE } from "@/lib/review-outcome";
import {
  HostedInferenceReleaseDarkError,
  PublicationControllerReleaseFenceError,
  publicationControllerLegacyReviewFenced,
} from "@/lib/release-job-rollout";
import { shouldSendPreventionHint } from "@/lib/review-prevention-db";
import {
  consumePrivateWorkerRehearsalAfterStaging,
  WorkerInterruptionRehearsalError,
} from "@/lib/private-worker-rehearsal";
import {
  getPullRequestPublicationCommentIds,
  readPublicationReceipt,
  reconcilePublicationThreadObservations,
  type PublicationReceipt,
} from "@/lib/publication-receipt";
import {
  reportOperationalModelIncident,
  type ObservabilityProcessGroup,
} from "@/lib/server-observability";
import {
  type PublicationControllerClaimAuthority,
  type PublicationControllerReviewAction,
  type PublicationControllerReviewIdentity,
  buildPublicationControllerOperationExecutor,
  buildPublicationControllerReviewStateMachineDependencies,
  runExactPublicationControllerRecovery,
  runPublicationControllerRecoveryIfAuthorized,
  runPublicationControllerReviewStateMachine,
} from "@/worker/publication-controller-review";

export const REVIEW_DEADLINE_MS = 10 * 60 * 1000;
// Match postil-cli's hosted profile: a normal slow review gets up to seven
// minutes, the shared LLM deadline keeps two minutes available for a fallback
// or scorer, and the worker retains one minute for process and persistence work.
const HOSTED_LLM_REQUEST_TIMEOUT_SECS = "420";
const HOSTED_LLM_TOTAL_TIMEOUT_SECS = "540";
const REVIEW_CANCELLATION_POLL_MS = 250;

const CACHE_DIR = optionalEnv("POSTIL_CACHE_DIR", ".cache") as string;

class OperationalError extends Error {}

class TerminalReviewError extends OperationalError {}

export class WorkerShutdownError extends OperationalError {
  constructor() {
    super("review interrupted by worker shutdown");
    this.name = "WorkerShutdownError";
  }
}

export class ReviewPublicationReconciliationError extends OperationalError {
  constructor(message = "review publication reconciliation is pending") {
    super(message);
    this.name = "ReviewPublicationReconciliationError";
  }
}

export class ReviewInputConvergenceError extends OperationalError {
  constructor(message = "review input convergence is pending") {
    super(message);
    this.name = "ReviewInputConvergenceError";
  }
}

/** True when GitHub's live pull request snapshot predates the signed event. */
export function livePullRequestSnapshotLagsEvent(
  expectedUpdatedAt: string,
  liveUpdatedAt: string,
): boolean {
  const expectedTime = Date.parse(expectedUpdatedAt);
  const liveTime = Date.parse(liveUpdatedAt);
  if (!Number.isFinite(expectedTime) || !Number.isFinite(liveTime)) {
    throw new TypeError("pull request update timestamps must be valid");
  }
  return liveTime < expectedTime;
}

export type InterruptedHostedSpendAction =
  | "receipt"
  | "retain-resumable"
  | "reconcile-ambiguous"
  | "release-unused";

/** Select the only safe settlement path for interrupted hosted inference. */
export function interruptedHostedSpendAction(input: {
  receiptAvailable: boolean;
  cliStarted: boolean;
  billingOutcome: "unused" | "resumable" | "ambiguous";
}): InterruptedHostedSpendAction {
  if (input.receiptAvailable) return "receipt";
  if (!input.cliStarted || input.billingOutcome === "unused") {
    return "release-unused";
  }
  return input.billingOutcome === "resumable"
    ? "retain-resumable"
    : "reconcile-ambiguous";
}

class ReviewInputSupersededError extends ReviewInputConvergenceError {
  constructor() {
    super("a newer same-head pull request edit is retained for review");
    this.name = "ReviewInputSupersededError";
  }
}

export interface ReviewInputLeaseMonitor {
  check(): Promise<void>;
  stop(): void;
}

/** Abort active review work when its exact queue claim is lost or superseded. */
export function startReviewInputLeaseMonitor(
  readState: () => Promise<ReviewInputLeaseState>,
  controller: AbortController,
  intervalMs = REVIEW_CANCELLATION_POLL_MS,
): ReviewInputLeaseMonitor {
  let stopped = false;
  let checkInFlight = false;
  const check = async (): Promise<void> => {
    if (stopped || checkInFlight || controller.signal.aborted) return;
    checkInFlight = true;
    try {
      const state = await readState();
      if (state === "newer-pending") {
        controller.abort(new ReviewInputSupersededError());
      } else if (state === "inactive") {
        controller.abort();
      }
    } catch {
      controller.abort();
    } finally {
      checkInFlight = false;
    }
  };
  const timer = setInterval(() => void check(), intervalMs);
  timer.unref?.();
  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

interface ExpectedFailureCheckRuns {
  advisory?: ExpectedCheckRunIdentity;
  gate?: ExpectedCheckRunIdentity;
  publicationIncomplete?: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function translateWorkerAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (signal?.aborted && isAbortError(error)) throw new WorkerShutdownError();
    throw error;
  }
}

interface CliEnvConfig {
  byok: boolean;
  apiBase: string;
  apiFormat: ApiFormat;
  apiKey: string | undefined;
  apiAuthHeader: string | undefined;
  apiAuthValue: string | undefined;
  model: string | undefined;
  modelCascade: string | undefined;
}

export function buildCliEnv(
  llm: CliEnvConfig,
  baseEnv: Record<string, string> = {},
): Record<string, string> {
  const cliEnv: Record<string, string> = {
    ...baseEnv,
    POSTIL_API_BASE: llm.apiBase,
    POSTIL_API_FORMAT: llm.apiFormat,
    // Hosted inference always uses the roster baked into the pinned CLI.
    // Repository model settings are accepted only when the organization has
    // supplied its own provider credentials.
    POSTIL_HOSTED_MODE: llm.byok ? "0" : "1",
    // Provisional admission is a managed-hosted deployment choice. Always
    // shadow the worker environment so BYOK children cannot inherit it.
    POSTIL_PROVISIONAL_HOSTED_ROSTER: llm.byok
      ? "0"
      : (optionalEnv("POSTIL_PROVISIONAL_HOSTED_ROSTER", "0") as string),
    // Always shadow process.env. A BYOK endpoint without additional auth must
    // never inherit the hosted gateway credential when runCli merges envs.
    POSTIL_ENDPOINT_AUTH_HEADER: llm.apiAuthHeader ?? "",
    POSTIL_ENDPOINT_AUTH_VALUE: llm.apiAuthValue ?? "",
    // runCli inherits process.env. Shadow every supported or common provider
    // credential alias so a BYOK child can receive only its sealed org key.
    MODEL_API_KEY: "",
    POSTIL_API_KEY: "",
    OPENROUTER_API_KEY: "",
    OPENROUTER_MANAGEMENT_API_KEY: "",
    LLM_API_KEY: "",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    // This is per-review policy, never a deployment-wide toggle inherited by
    // every child process.
    POSTIL_PREVENTION_HINT: baseEnv.POSTIL_PREVENTION_HINT === "1" ? "1" : "0",
    POSTIL_PREVENTION_COMMANDS_JSON:
      baseEnv.POSTIL_PREVENTION_COMMANDS_JSON ?? "[]",
    POSTIL_LLM_REQUEST_TIMEOUT_SECS: optionalEnv(
      "POSTIL_LLM_REQUEST_TIMEOUT_SECS",
      HOSTED_LLM_REQUEST_TIMEOUT_SECS,
    ) as string,
    POSTIL_LLM_TOTAL_TIMEOUT_SECS: optionalEnv(
      "POSTIL_LLM_TOTAL_TIMEOUT_SECS",
      HOSTED_LLM_TOTAL_TIMEOUT_SECS,
    ) as string,
  };
  if (llm.apiKey) {
    cliEnv.MODEL_API_KEY = llm.apiKey;
    cliEnv.POSTIL_API_KEY = llm.apiKey;
  }
  if (llm.model) cliEnv.REVIEW_MODEL = llm.model;
  if (llm.modelCascade) cliEnv.REVIEW_MODEL_CASCADE = llm.modelCascade;
  return cliEnv;
}

/** Resolve LLM config: org BYO settings win, env defaults otherwise. */
export async function resolveLlmConfig(
  orgId: number | null,
): Promise<CliEnvConfig> {
  const configuredFormat = optionalEnv(
    "POSTIL_API_FORMAT",
    "openai-compatible",
  ) as string;
  const defaultFormat = parseApiFormat(configuredFormat);
  if (!defaultFormat)
    throw new Error("POSTIL_API_FORMAT must be openai-compatible or anthropic");
  const defaultAuthHeader = optionalEnv("POSTIL_ENDPOINT_AUTH_HEADER");
  const defaultAuthValue = optionalEnv("POSTIL_ENDPOINT_AUTH_VALUE");
  if (Boolean(defaultAuthHeader) !== Boolean(defaultAuthValue)) {
    throw new Error(
      "POSTIL_ENDPOINT_AUTH_HEADER and POSTIL_ENDPOINT_AUTH_VALUE must be set together",
    );
  }
  if (defaultAuthHeader)
    validateAdditionalAuthHeader(defaultAuthHeader, defaultFormat);
  if (defaultAuthValue) validateAdditionalAuthValue(defaultAuthValue);
  const defaults: CliEnvConfig = {
    byok: false,
    apiBase: optionalEnv(
      "POSTIL_API_BASE",
      "https://openrouter.ai/api/v1",
    ) as string,
    apiFormat: defaultFormat,
    apiKey:
      optionalEnv("MODEL_API_KEY") ??
      optionalEnv("POSTIL_API_KEY") ??
      optionalEnv("OPENROUTER_API_KEY"),
    apiAuthHeader: defaultAuthHeader,
    apiAuthValue: defaultAuthValue,
    model: optionalEnv("REVIEW_MODEL"),
    modelCascade: optionalEnv("REVIEW_MODEL_CASCADE"),
  };
  if (orgId == null) return defaults;
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.orgSettings)
    .where(eq(schema.orgSettings.orgId, orgId))
    .limit(1);
  const settings = rows[0];
  if (!settings) return defaults;
  if (!settings.apiKeyCiphertext) return defaults;
  const apiKey = unseal(
    Buffer.from(settings.apiKeyCiphertext),
    getSealingKey(),
  );
  // Internal-network guard at the worker boundary: rows predating write-time
  // validation must not reach the spawned CLI as POSTIL_API_BASE.
  if (settings.apiBase) await validateApiBase(settings.apiBase);
  const apiFormat = parseApiFormat(settings.apiFormat ?? "openai-compatible");
  if (!apiFormat) throw new Error("stored BYOK API interface is invalid");
  const hasAuthHeader = Boolean(settings.apiAuthHeaderCiphertext);
  const hasAuthValue = Boolean(settings.apiAuthValueCiphertext);
  if (hasAuthHeader !== hasAuthValue) {
    throw new Error("stored BYOK additional authentication is incomplete");
  }
  const apiAuthHeader = settings.apiAuthHeaderCiphertext
    ? unseal(Buffer.from(settings.apiAuthHeaderCiphertext), getSealingKey())
    : undefined;
  const apiAuthValue = settings.apiAuthValueCiphertext
    ? unseal(Buffer.from(settings.apiAuthValueCiphertext), getSealingKey())
    : undefined;
  if (apiAuthHeader) validateAdditionalAuthHeader(apiAuthHeader, apiFormat);
  if (apiAuthValue) validateAdditionalAuthValue(apiAuthValue);
  return {
    byok: true,
    apiBase: settings.apiBase ?? defaults.apiBase,
    apiFormat,
    apiKey,
    apiAuthHeader,
    apiAuthValue,
    model: settings.model ?? defaults.model,
    modelCascade: settings.modelCascade ?? defaults.modelCascade,
  };
}

/** Load hosted review artifacts independently of the organization's BYO key. */
export async function resolveOrgReviewConfig(
  orgId: number | null,
): Promise<OrgReviewConfig | null> {
  if (orgId == null) return null;
  const db = getDb();
  const rows = await db
    .select({
      configYaml: schema.orgSettings.configYaml,
      guardrailsMd: schema.orgSettings.guardrailsMd,
      contentPolicyMd: schema.orgSettings.contentPolicyMd,
    })
    .from(schema.orgSettings)
    .where(eq(schema.orgSettings.orgId, orgId))
    .limit(1);
  const row = rows[0];
  return row
    ? { ...row, configYaml: withoutOrgModelConfig(row.configYaml) }
    : null;
}

/** Shared owner config defaults on even when the organization has no settings row. */
export async function resolveSharedConfigEnabled(
  orgId: number | null,
): Promise<boolean> {
  if (orgId == null) return false;
  const row = (
    await getDb()
      .select({ enabled: schema.orgSettings.sharedConfigEnabled })
      .from(schema.orgSettings)
      .where(eq(schema.orgSettings.orgId, orgId))
      .limit(1)
  )[0];
  return row?.enabled ?? true;
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  /** Exact stdout bytes, retained for byte-authenticated child protocols. */
  stdoutBytes: Uint8Array;
  stderr: string;
  timedOut: boolean;
  interrupted: boolean;
}

const REQUIRED_HOSTED_PUBLICATION_FAILURE =
  /required hosted (?:check )?publication failed/i;

// The publication receipt carries no structured field for why the CLI left a
// check-run incomplete; its stderr text is the only signal available. A moved
// pull request head is the one reason worth distinguishing from a transient
// forge failure: a check-run for a snapshot that no longer exists can never
// report completed, so it must never be handed to indefinite reconciliation.
const PULL_REQUEST_SNAPSHOT_CHANGED =
  /pull request snapshot changed after review/i;
/** True when the CLI declined to publish because the reviewed head moved. */
export function publicationSkippedForChangedSnapshot(stderr: string): boolean {
  return PULL_REQUEST_SNAPSHOT_CHANGED.test(stderr);
}

/**
 * A strict hosted CLI can compute and emit a complete envelope before one of
 * GitHub's publication calls fails. Preserve that result so the worker can
 * account for the completed inference and hand the exact check identities to
 * durable reconciliation. Other exit-2 results remain operational failures.
 */
export function ingestCompletedHostedReview(
  result: Pick<CliResult, "exitCode" | "stdout" | "stderr"> & {
    interrupted?: boolean;
  },
  sensitiveValues: string[] = [],
) {
  // The CLI emits the complete envelope before any forge I/O. A late worker
  // interruption can therefore terminate the process with no exit code after
  // GitHub accepted both terminal checks. The validated envelope, not the
  // signal-derived exit status, is the durable recovery input in that case.
  if (result.interrupted) return ingestEnvelope(result.stdout);
  if (result.exitCode === 0 || result.exitCode === 1) {
    return ingestEnvelope(result.stdout);
  }
  if (
    result.exitCode === 2 &&
    REQUIRED_HOSTED_PUBLICATION_FAILURE.test(result.stderr)
  ) {
    try {
      return ingestEnvelope(result.stdout);
    } catch (error) {
      throw new OperationalError(
        `postil CLI publication failed without a valid envelope: ${redactSecrets(error)}`,
      );
    }
  }
  if (result.exitCode === 2) {
    try {
      const ingested = ingestEnvelope(result.stdout);
      if (isEnvelopeOperationallyUnavailable(ingested.envelope)) {
        return ingested;
      }
    } catch {
      // The public worker error below carries the bounded CLI diagnostic. A
      // malformed or ordinary exit-2 envelope is not a completed review.
    }
  }
  throw new OperationalError(
    `postil CLI exited with code ${result.exitCode}: ${redactAndTruncate(result.stderr, 500, sensitiveValues)}`,
  );
}

export function formatHostedReviewIngestionLog(
  stdout: string,
  envelope: Envelope,
  gateFailing: boolean,
): string {
  const outcome = isEnvelopeOperationallyUnavailable(envelope)
    ? "no reviewer verdict"
    : `gate ${gateFailing ? "failing" : "passing"}`;
  return `envelope ingested (${Buffer.byteLength(stdout)} bytes, ${envelope.findings.length} findings, ${outcome})`;
}

interface CliObservers {
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
  preserveOutputOnInterrupt?: boolean;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

const POSTIL_CLI_VERSION_TIMEOUT_MS = 3_000;
const POSTIL_CLI_VERSION_OUTPUT_MAX_BYTES = 256;
const POSTIL_CLI_VERSION_PATTERN =
  /^postil\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const postilCliVersionCache = new Map<string, Promise<string>>();

/** Probe the immutable worker binary without forwarding process credentials. */
export function probePostilCliVersion(
  executable: string,
  timeoutMs = POSTIL_CLI_VERSION_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const safeEnvironment = (
      process.env.PATH ? { PATH: process.env.PATH } : {}
    ) as NodeJS.ProcessEnv;
    const child = spawn(executable, ["--version"], {
      env: safeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const reject = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new OperationalError(message));
    };
    const resolve = (version: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(version);
    };

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(`postil CLI version probe timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > POSTIL_CLI_VERSION_OUTPUT_MAX_BYTES) {
        child.kill("SIGKILL");
        reject("postil CLI version probe exceeded its output limit");
        return;
      }
      stdout += chunk.toString();
    });
    child.stderr.resume();
    child.on("error", () => {
      reject("failed to start postil CLI version probe");
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      if (exitCode !== 0) {
        reject(
          `postil CLI version probe exited with code ${exitCode ?? "unknown"}`,
        );
        return;
      }
      const match = POSTIL_CLI_VERSION_PATTERN.exec(stdout.trim());
      if (!match?.[1]) {
        reject("postil CLI version probe returned unrecognized output");
        return;
      }
      resolve(match[1]);
    });
  });
}

export async function postilCliVersionLogLine(): Promise<string> {
  const executable = optionalEnv("POSTIL_BIN", "postil") as string;
  let version = postilCliVersionCache.get(executable);
  if (!version) {
    // A broken or missing binary should not add the full probe timeout to every
    // queued review. Cache the safe sentinel just like a successful version.
    version = probePostilCliVersion(executable).catch(() => "unavailable");
    postilCliVersionCache.set(executable, version);
  }
  return `postil CLI version ${await version}`;
}

const REVIEW_LOG_FLUSH_MS = 1_000;
const REVIEW_LOG_BATCH_SIZE = 50;
export const REVIEW_LOG_MAX_LINES = 2_000;
const REVIEW_LOG_LINE_MAX_CHARS = 10_000;

/** Buffered per-review writer. Storage failures never fail the review itself. */
export class ReviewLogWriter {
  private readonly pending: Array<typeof schema.reviewLogs.$inferInsert> = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private writeChain: Promise<void> = Promise.resolve();
  private nextSeq = 1;
  private stopped = false;
  private sensitiveValues: string[] = [];

  constructor(private readonly reviewId: number) {
    this.timer = setInterval(() => void this.flush(), REVIEW_LOG_FLUSH_MS);
    this.timer.unref?.();
  }

  setSensitiveValues(values: string[]): void {
    this.sensitiveValues = values;
  }

  line(value: unknown): void {
    if (this.stopped) return;
    let line: string;
    if (this.nextSeq === REVIEW_LOG_MAX_LINES) {
      line = `[log truncated after ${REVIEW_LOG_MAX_LINES - 1} lines]`;
      this.stopped = true;
    } else {
      line = redactAndTruncate(
        String(value),
        REVIEW_LOG_LINE_MAX_CHARS,
        this.sensitiveValues,
      );
    }
    this.pending.push({
      reviewId: this.reviewId,
      seq: this.nextSeq,
      at: new Date(),
      line,
    });
    this.nextSeq += 1;
    if (this.pending.length >= REVIEW_LOG_BATCH_SIZE) void this.flush();
  }

  async flush(): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length);
    if (batch.length > 0) {
      this.writeChain = this.writeChain.then(async () => {
        try {
          await getDb().insert(schema.reviewLogs).values(batch);
        } catch (err) {
          console.error(
            `review ${this.reviewId}: could not persist log batch: ${redactSecrets(err, this.sensitiveValues)}`,
          );
        }
      });
    }
    await this.writeChain;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}

function createLineObserver(onLine: ((line: string) => void) | undefined) {
  let remainder = "";
  const decoder = new TextDecoder();
  return {
    push(chunk: Buffer) {
      if (!onLine) return;
      const text = remainder + decoder.decode(chunk, { stream: true });
      const parts = text.split("\n");
      remainder = parts.pop() ?? "";
      for (const part of parts)
        onLine(part.endsWith("\r") ? part.slice(0, -1) : part);
    },
    end() {
      if (!onLine) return;
      remainder += decoder.decode();
      if (remainder.length > 0)
        onLine(remainder.endsWith("\r") ? remainder.slice(0, -1) : remainder);
      remainder = "";
    },
  };
}

export function runCli(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
  observers: CliObservers = {},
): Promise<CliResult> {
  for (const [stream, maximum] of [
    ["stdout", observers.maxStdoutBytes],
    ["stderr", observers.maxStderrBytes],
  ] as const) {
    if (
      maximum !== undefined &&
      (!Number.isSafeInteger(maximum) || maximum <= 0)
    ) {
      return Promise.reject(
        new OperationalError(`postil CLI ${stream} byte limit is invalid`),
      );
    }
  }
  const bin = optionalEnv("POSTIL_BIN", "postil") as string;
  return new Promise((resolvePromise, reject) => {
    const ownsProcessGroup = process.platform !== "win32";
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: ownsProcessGroup,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutByteLength = 0;
    let stderrByteLength = 0;
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    let abortKillTimer: ReturnType<typeof setTimeout> | undefined;
    let outputLimitFailure: string | undefined;
    const stderrLines = createLineObserver(observers.onStderrLine);
    const cleanup = () => {
      clearTimeout(timer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      observers.signal?.removeEventListener("abort", abort);
    };
    const signalChildTree = (signal: NodeJS.Signals) => {
      if (ownsProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The direct child may have exited between observation and signal.
        }
      }
      child.kill(signal);
    };
    const hardStopChildTree = () => {
      signalChildTree("SIGKILL");
      // ChildProcess close otherwise waits for descendants that inherited a
      // protocol pipe and escaped termination. Closing our endpoints keeps
      // every deadline and byte bound locally enforceable.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const abort = () => {
      if (settled || interrupted) return;
      interrupted = true;
      signalChildTree("SIGTERM");
      abortKillTimer = setTimeout(hardStopChildTree, 1_000);
      abortKillTimer.unref?.();
    };
    const rejectOversizedOutput = (stream: "stdout" | "stderr", maximum: number) => {
      if (outputLimitFailure !== undefined) return;
      outputLimitFailure = `postil CLI ${stream} exceeded its ${maximum} byte limit`;
      hardStopChildTree();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      hardStopChildTree();
    }, REVIEW_DEADLINE_MS);
    if (observers.signal?.aborted) abort();
    else observers.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutByteLength += chunk.byteLength;
      if (
        observers.maxStdoutBytes !== undefined &&
        stdoutByteLength > observers.maxStdoutBytes
      ) {
        rejectOversizedOutput("stdout", observers.maxStdoutBytes);
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrByteLength += chunk.byteLength;
      if (
        observers.maxStderrBytes !== undefined &&
        stderrByteLength > observers.maxStderrBytes
      ) {
        rejectOversizedOutput("stderr", observers.maxStderrBytes);
        return;
      }
      stderrChunks.push(chunk);
      stderrLines.push(chunk);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new OperationalError(
          `failed to spawn postil CLI (${bin}): ${err.message}. Set POSTIL_BIN or put 'postil' on PATH.`,
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      stderrLines.end();
      if (outputLimitFailure !== undefined) {
        reject(new OperationalError(outputLimitFailure));
        return;
      }
      if (interrupted && !observers.preserveOutputOnInterrupt) {
        reject(new WorkerShutdownError());
        return;
      }
      const stdoutBytes = Buffer.concat(stdoutChunks, stdoutByteLength);
      resolvePromise({
        exitCode: code,
        stdout: stdoutBytes.toString("utf8"),
        stdoutBytes,
        stderr: Buffer.concat(stderrChunks, stderrByteLength).toString("utf8"),
        timedOut,
        interrupted,
      });
    });
  });
}

function throwIfWorkerStopping(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WorkerShutdownError();
  }
}

export function reviewUsageFromEnvelope(
  envelope: Envelope,
  input: { orgId: number | null; repositoryId: number; byok: boolean },
): ReviewCompletionInput["usage"] {
  return (
    envelope.modelUsage ?? [
      {
        model: envelope.modelUsed,
        promptTokens: envelope.usage.promptTokens,
        completionTokens: envelope.usage.completionTokens,
      },
    ]
  ).map((entry) => ({
    orgId: input.orgId,
    repositoryId: input.repositoryId,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    modelUsed: entry.model,
    costMicros: calculateUsageCostMicrosForModel(
      entry.model,
      entry.promptTokens,
      entry.completionTokens,
    ),
    billingScope: input.byok
      ? ("analytics" as const)
      : ("private_hosted" as const),
  }));
}

async function resumeStagedReviewCompletion(input: {
  db: Database;
  payload: ReviewJobPayload;
  lease: JobLease;
  installation: { id: number; orgId: number | null; orgSlug: string | null };
  repository: { id: number; githubRepoId: number; fullName: string };
  signal?: AbortSignal;
}): Promise<boolean> {
  const { db, payload, lease, installation, repository, signal } = input;
  const trigger = normalizeReviewTriggerContext(payload.trigger);
  const selection = {
    id: schema.reviews.id,
    publicId: schema.reviews.publicId,
    status: schema.reviews.status,
    repositoryId: schema.reviews.repositoryId,
    sourceOrgId: schema.reviews.sourceOrgId,
    sourceInstallationId: schema.reviews.sourceInstallationId,
    sourceGithubInstallationId: schema.reviews.sourceGithubInstallationId,
    sourceGithubRepoId: schema.reviews.sourceGithubRepoId,
    sourceRepoFullName: schema.reviews.sourceRepoFullName,
    prNumber: schema.reviews.prNumber,
    headSha: schema.reviews.headSha,
    baseSha: schema.reviews.baseSha,
    envelope: schema.reviews.envelope,
    advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
    gateCheckRunId: schema.reviews.gateCheckRunId,
  };
  const stagedReview = payload.recoveryReviewId
    ? (
        await db
          .select(selection)
          .from(schema.reviews)
          .where(eq(schema.reviews.id, payload.recoveryReviewId))
          .limit(1)
      )[0]
    : (
        await db
          .select(selection)
          .from(schema.reviews)
          .where(
            and(
              eq(schema.reviews.repositoryId, repository.id),
              eq(schema.reviews.prNumber, payload.prNumber),
              eq(schema.reviews.headSha, payload.headSha),
              eq(schema.reviews.baseSha, payload.baseSha),
              eq(schema.reviews.triggerSource, trigger.source),
              eq(schema.reviews.triggerContext, trigger),
              eq(schema.reviews.status, "running"),
              isNotNull(schema.reviews.envelope),
            ),
          )
          .orderBy(desc(schema.reviews.id))
          .limit(1)
      )[0];
  if (!stagedReview) {
    if (payload.recoveryReviewId !== undefined) {
      throw new PermanentJobError("review publication recovery row is missing");
    }
    return false;
  }
  if (
    stagedReview.repositoryId !== repository.id ||
    stagedReview.sourceOrgId !== payload.sourceOrgId ||
    stagedReview.sourceInstallationId !== payload.sourceInstallationId ||
    stagedReview.sourceGithubInstallationId !== payload.installationId ||
    stagedReview.sourceGithubRepoId !== payload.githubRepoId ||
    stagedReview.sourceRepoFullName !== payload.repoFullName ||
    stagedReview.prNumber !== payload.prNumber ||
    stagedReview.headSha !== payload.headSha ||
    stagedReview.baseSha !== payload.baseSha
  ) {
    throw new PermanentJobError("review publication recovery identity changed");
  }
  if (
    stagedReview.status !== "running" &&
    stagedReview.status !== "completed"
  ) {
    if (stagedReview.status !== "stale") {
      throw new PermanentJobError(
        `review publication recovery is already ${stagedReview.status}`,
      );
    }
  }
  if (!stagedReview.envelope) {
    throw new PermanentJobError("review publication recovery state is incomplete");
  }

  const detailsUrl = reviewDetailsUrl(
    stagedReview.publicId,
    installation.orgSlug,
  );
  const cleanupIdentity: StaleReviewCleanupIdentity = {
    reviewId: stagedReview.id,
    installationId: payload.installationId,
    repoFullName: payload.repoFullName,
    headSha: payload.headSha,
    advisoryCheckRunId: stagedReview.advisoryCheckRunId,
    gateCheckRunId: stagedReview.gateCheckRunId,
    advisoryCheckExternalId: checkRunExternalId(stagedReview.publicId, "review"),
    gateCheckExternalId: checkRunExternalId(stagedReview.publicId, "gate"),
    advisoryCheckRunMayExist: stagedReview.advisoryCheckRunId == null,
    gateCheckRunMayExist:
      stagedReview.gateCheckRunId == null && stagedReview.advisoryCheckRunId != null,
    message: "superseded by newer pull request input before publication recovery",
    detailsUrl,
    intent: "neutralize",
  };
  if (stagedReview.status === "stale") {
    await markReviewStaleWithDurableCleanup(db, cleanupIdentity);
    return true;
  }
  if (stagedReview.status === "completed") {
    void import("@/worker/runner").then(({ triggerQueueDrain }) =>
      triggerQueueDrain("gate-state-sync"),
    );
    return true;
  }
  if (
    stagedReview.advisoryCheckRunId == null ||
    stagedReview.gateCheckRunId == null
  ) {
    throw new PermanentJobError("review publication recovery state is incomplete");
  }

  const token = await translateWorkerAbort(
    getInstallationToken(payload.installationId, signal),
    signal,
  );
  const currentRepository = await translateWorkerAbort(
    fetchRepositorySummary(token, payload.repoFullName, signal),
    signal,
  );
  if (
    currentRepository.id !== payload.githubRepoId ||
    currentRepository.full_name !== payload.repoFullName
  ) {
    throw new PermanentJobError(
      "review publication recovery repository identity changed",
    );
  }
  const operationallyUnavailable = isEnvelopeOperationallyUnavailable(
    stagedReview.envelope,
  );
  const liveContext = await translateWorkerAbort(
    getPullRequestReviewContext(token, payload.repoFullName, payload.prNumber, signal),
    signal,
  );
  const storedPayload = payload as ReviewJobPayload & {
    [COALESCED_REVIEW_PAYLOAD_KEY]?: ReviewJobPayload;
  };
  const pending = storedPayload[COALESCED_REVIEW_PAYLOAD_KEY];
  const expectedUpdatedAt = Date.parse(payload.expectedPullRequestUpdatedAt);
  const liveUpdatedAt = Date.parse(liveContext.updatedAt);
  if (
    liveContext.headSha === payload.headSha &&
    liveContext.baseSha === payload.baseSha &&
    liveUpdatedAt < expectedUpdatedAt
  ) {
    throw new ReviewPublicationReconciliationError(
      "pull request state has not converged to the staged publication input",
    );
  }
  const pendingSupersedes = pending !== undefined &&
    (pendingReviewInputSupersedes(
      payload.expectedPullRequestUpdatedAt,
      pending.expectedPullRequestUpdatedAt,
      payload.reviewInputSequence,
      pending.reviewInputSequence,
    ) ||
      pending.headSha !== payload.headSha ||
      pending.baseSha !== payload.baseSha);
  const pendingCoversLive = pending !== undefined &&
    pending.headSha === liveContext.headSha &&
    pending.baseSha === liveContext.baseSha &&
    Date.parse(pending.expectedPullRequestUpdatedAt) >= liveUpdatedAt;
  const liveIsExact =
    liveContext.open &&
    !liveContext.merged &&
    !liveContext.draft &&
    liveContext.headSha === payload.headSha &&
    liveContext.baseSha === payload.baseSha &&
    liveUpdatedAt === expectedUpdatedAt;
  if (pendingSupersedes || !liveIsExact) {
    if (
      liveContext.open &&
      !liveContext.merged &&
      !liveContext.draft &&
      !pendingCoversLive
    ) {
      await enqueueObservedReviewSnapshot(getPool(), storedPayload, liveContext);
    }
    await markReviewStaleWithDurableCleanup(db, cleanupIdentity);
    await neutralizeSupersededCheckRuns(
      token,
      payload.repoFullName,
      stagedReview.advisoryCheckRunId,
      stagedReview.gateCheckRunId,
      cleanupIdentity.message,
      detailsUrl,
    );
    console.log(`review publication recovery ${stagedReview.id} superseded`);
    return true;
  }
  if (operationallyUnavailable) {
    await failCheckRuns(
      token,
      payload.repoFullName,
      stagedReview.advisoryCheckRunId,
      stagedReview.gateCheckRunId,
      "the stored review envelope contains an operational sentinel",
      signal,
      true,
      detailsUrl,
      {
        advisory: {
          id: stagedReview.advisoryCheckRunId,
          name: ADVISORY_CHECK_NAME,
          externalId: checkRunExternalId(stagedReview.publicId, "review"),
          headSha: payload.headSha,
          detailsUrl,
        },
        gate: {
          id: stagedReview.gateCheckRunId,
          name: GATE_CHECK_NAME,
          externalId: checkRunExternalId(stagedReview.publicId, "gate"),
          headSha: payload.headSha,
          detailsUrl,
        },
      },
      await getOrganizationGateEnabled(db, installation.orgId),
    );
  }
  try {
    await verifyCompletedCheckRun(
      token,
      payload.repoFullName,
      {
        id: stagedReview.advisoryCheckRunId,
        name: ADVISORY_CHECK_NAME,
        externalId: checkRunExternalId(stagedReview.publicId, "review"),
        headSha: payload.headSha,
        conclusion: operationallyUnavailable ? "neutral" : "success",
        requireOutput: true,
        detailsUrl,
      },
      signal,
    );
    if (stagedReview.status === "running") {
      const reservation = (
        await db
          .select({ id: schema.hostedUsageReservations.id })
          .from(schema.hostedUsageReservations)
          .where(eq(schema.hostedUsageReservations.reviewId, stagedReview.id))
          .limit(1)
      )[0];
      const completion = await finalizeStagedReviewCompletionWithGateMode(
        db,
        {
          reviewId: stagedReview.id,
          usage: reviewUsageFromEnvelope(stagedReview.envelope, {
            orgId: installation.orgId,
            repositoryId: repository.id,
            byok: !reservation,
          }),
          hostedUsageReservationId: reservation?.id ?? null,
          usageAccountingComplete:
            stagedReview.envelope.usageAccountingComplete === true,
          reviewJobLease: lease,
          expectedReviewInput: payload,
          staleCleanup: cleanupIdentity,
          ...(operationallyUnavailable
            ? {
                terminalStatus: "failed" as const,
                errorMessage: OPERATIONAL_NO_VERDICT_MESSAGE,
              }
            : {}),
        },
        installation.orgId,
      );
      if (!completion.completed) {
        if (completion.superseded) {
          console.log(
            `review publication recovery ${stagedReview.id} superseded during verification`,
          );
          return true;
        }
        throw new ReviewPublicationReconciliationError(
          "review publication recovery lost its terminal-state race",
        );
      }
    }
    void import("@/worker/runner").then(({ triggerQueueDrain }) =>
      triggerQueueDrain("gate-state-sync"),
    );
    console.log(
      `review publication recovery ${stagedReview.id} ${operationallyUnavailable ? "terminalized without a verdict" : "completed"}`,
    );
    return true;
  } catch (error) {
    if (signal?.aborted) throw new WorkerShutdownError();
    throw new ReviewPublicationReconciliationError(redactSecrets(error));
  }
}

async function loadPublicationControllerReviewIdentity(input: {
  payload: ReviewJobPayload;
  lease: JobLease;
}): Promise<PublicationControllerReviewIdentity | null> {
  if (!Number.isSafeInteger(input.payload.recoveryReviewId)) return null;
  const result = await getPool().query<{
    repository_id: string;
    pr_number: number;
    publication_generation: string;
    review_id: string;
    accepted_input_digest: string;
  }>(
    `SELECT generation.repository_id::text AS repository_id,
            generation.pr_number,
            generation.publication_generation::text AS publication_generation,
            generation.review_id::text AS review_id,
            generation.accepted_input_digest
       FROM jobs job
       JOIN review_publication_generations generation
         ON generation.review_id = (job.payload->>'recoveryReviewId')::bigint
        AND generation.review_input_sequence =
          (job.payload->>'reviewInputSequence')::bigint
      WHERE job.id = $1 AND job.kind = 'review' AND job.status = 'running'
        AND job.locked_by = $2 AND job.lock_generation = $3
        AND job.payload->>'recoveryReviewId' = $4
        AND generation.sealed_at IS NOT NULL
      LIMIT 2`,
    [
      input.lease.id,
      input.lease.lockedBy,
      input.lease.lockGeneration,
      String(input.payload.recoveryReviewId),
    ],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw new PermanentJobError(
      "review recovery matches more than one publication-controller generation",
    );
  }
  const row = result.rows[0]!;
  return {
    databaseRepositoryId: row.repository_id,
    pullRequestNumber: row.pr_number,
    publicationGeneration: row.publication_generation,
    reviewId: Number(row.review_id),
    acceptedInputIdentity: `sha256:${row.accepted_input_digest}`,
  };
}

async function publicationControllerSupersessionRequested(
  identity: PublicationControllerReviewIdentity,
  lease: JobLease,
): Promise<boolean> {
  const result = await getPool().query<{ superseded: boolean }>(
    `SELECT (
       jsonb_typeof(job.payload->'_postilCoalescedReviewPayload') = 'object'
       OR high_water.publication_generation IS DISTINCT FROM $4::bigint
       OR high_water.accepted_review_id IS DISTINCT FROM $5::bigint
       OR high_water.accepted_input_digest IS DISTINCT FROM $6
     ) AS superseded
       FROM jobs job
       LEFT JOIN pull_request_publication_high_waters high_water
         ON high_water.repository_id = $7::bigint
        AND high_water.pr_number = $8
      WHERE job.id = $1 AND job.kind = 'review' AND job.status = 'running'
        AND job.locked_by = $2 AND job.lock_generation = $3`,
    [
      lease.id,
      lease.lockedBy,
      lease.lockGeneration,
      identity.publicationGeneration,
      identity.reviewId,
      identity.acceptedInputIdentity.slice("sha256:".length),
      identity.databaseRepositoryId,
      identity.pullRequestNumber,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ReviewPublicationReconciliationError(
      "publication-controller queue lease is inactive",
    );
  }
  return row.superseded;
}

async function inspectPublicationControllerGeneration(input: {
  identity: PublicationControllerReviewIdentity;
  lease: JobLease;
}): Promise<"work" | "success" | "definitive-failure" | "superseded"> {
  const result = await getPool().query<{
    operation_count: number;
    active_operations: number;
    superseded_operations: number;
    terminal_gate_operations: number;
    required_failure_operations: number;
    gate_state: string;
    gate_activation_variant: string | null;
  }>(
    `SELECT count(*)::integer AS operation_count,
            count(*) FILTER (
              WHERE operation.state IN ('pending', 'applying', 'unknown')
            )::integer AS active_operations,
            count(*) FILTER (WHERE operation.state = 'superseded')::integer
              AS superseded_operations,
            count(*) FILTER (
              WHERE operation.kind = 'gateCheckComplete'
                AND operation.state IN ('applied', 'skipped', 'failed', 'superseded')
            )::integer AS terminal_gate_operations,
            count(*) FILTER (
              WHERE operation.operation_key IN (
                SELECT jsonb_array_elements_text(
                  gate.operation_record #> '{payload,selection,requiredOperationKeys}'
                )
              )
                AND operation.state IN ('failed', 'superseded')
            )::integer AS required_failure_operations,
            gate.state AS gate_state,
            (
              SELECT attempt.evidence_payload->>'activationVariant'
                FROM review_publication_operation_attempts attempt
               WHERE attempt.repository_id = gate.repository_id
                 AND attempt.pr_number = gate.pr_number
                 AND attempt.publication_generation = gate.publication_generation
                 AND attempt.operation_key = gate.operation_key
                 AND attempt.phase IN ('dispatched', 'applied')
               ORDER BY attempt.observed_at DESC, attempt.id DESC
               LIMIT 1
            ) AS gate_activation_variant
       FROM review_publication_operations operation
       JOIN review_publication_operations gate
         ON gate.repository_id = operation.repository_id
        AND gate.pr_number = operation.pr_number
        AND gate.publication_generation = operation.publication_generation
        AND gate.kind = 'gateCheckComplete'
      WHERE operation.repository_id = $1::bigint
        AND operation.pr_number = $2
        AND operation.publication_generation = $3::bigint
      GROUP BY gate.repository_id, gate.pr_number,
               gate.publication_generation, gate.operation_key,
               gate.operation_record, gate.state`,
    [
      input.identity.databaseRepositoryId,
      input.identity.pullRequestNumber,
      input.identity.publicationGeneration,
    ],
  );
  const row = result.rows[0];
  if (!row || row.operation_count < 2) {
    throw new PermanentJobError("publication-controller generation has no operation manifest");
  }
  const supersessionRequested = await publicationControllerSupersessionRequested(
    input.identity,
    input.lease,
  );
  if (row.active_operations > 0) return "work";
  if (row.terminal_gate_operations !== 1) {
    throw new ReviewPublicationReconciliationError(
      "publication-controller generation lacks terminal gate evidence",
    );
  }
  if (supersessionRequested || row.superseded_operations > 0) return "superseded";
  if (
    row.gate_state === "failed" ||
    row.required_failure_operations > 0 ||
    row.gate_activation_variant ===
      "all-dependencies-terminal:publication-failure"
  ) return "definitive-failure";
  return "success";
}

async function supersedeOnePendingPublicationOperation(
  identity: PublicationControllerReviewIdentity,
): Promise<boolean> {
  return new PostgresGitHubPublicationOperationStore(getPool(), {
    databaseRepositoryId: identity.databaseRepositoryId,
    pullRequestNumber: identity.pullRequestNumber,
    publicationGeneration: identity.publicationGeneration,
  }).supersedeOnePending();
}

async function publicationControllerMutationAuthorized(input: {
  identity: PublicationControllerReviewIdentity;
  lease: JobLease;
}): Promise<boolean> {
  if (!(await externalSideEffectLeaseActive(getPool(), input.lease))) return false;
  return !(await publicationControllerSupersessionRequested(
    input.identity,
    input.lease,
  ));
}

async function executeOnePublicationControllerOperation(input: {
  identity: PublicationControllerReviewIdentity;
  payload: ReviewJobPayload;
  lease: JobLease;
  signal?: AbortSignal;
}) {
  if (await publicationControllerSupersessionRequested(input.identity, input.lease)) {
    if (await supersedeOnePendingPublicationOperation(input.identity)) {
      return { status: "superseded" as const };
    }
  }
  const token = await translateWorkerAbort(
    getInstallationToken(input.payload.installationId, input.signal),
    input.signal,
  );
  return buildPublicationControllerOperationExecutor({
    pool: getPool(),
    scope: {
      databaseRepositoryId: input.identity.databaseRepositoryId,
      pullRequestNumber: input.identity.pullRequestNumber,
      publicationGeneration: input.identity.publicationGeneration,
    },
    token,
    appId: publicationControllerGitHubAppId(),
    claimOwner: `${input.lease.lockedBy}:review:${input.lease.id}:${input.lease.lockGeneration}`,
    signal: input.signal,
    dispatchAuthorized: () => publicationControllerMutationAuthorized(input),
  })();
}

function publicationControllerGitHubAppId(): number {
  const appId = Number(requireEnv("GITHUB_APP_ID"));
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new PermanentJobError("GITHUB_APP_ID must be a positive integer");
  }
  return appId;
}

async function loadPublicationControllerContinuationPayload(input: {
  identity: PublicationControllerReviewIdentity;
  lease: JobLease;
}): Promise<ReviewJobPayload> {
  const result = await getPool().query<{ payload: ReviewJobPayload }>(
    `SELECT payload
       FROM jobs
      WHERE id = $1 AND kind = 'review' AND status = 'running'
        AND locked_by = $2 AND lock_generation = $3
        AND payload->>'recoveryReviewId' = $4
        AND payload->>'reviewInputSequence' = $5`,
    [
      input.lease.id,
      input.lease.lockedBy,
      input.lease.lockGeneration,
      String(input.identity.reviewId),
      input.identity.publicationGeneration,
    ],
  );
  const payload = result.rows[0]?.payload;
  if (!payload) {
    throw new ReviewPublicationReconciliationError(
      "publication-controller continuation lost its exact queue lease",
    );
  }
  return payload;
}

export async function publicationControllerRemoteCheckRunId(
  identity: PublicationControllerReviewIdentity,
  kind: "advisoryCheckCreate" | "gateCheckCreate",
  database = getPool(),
): Promise<number | null> {
  const result = await database.query<{ remote_id: string | null }>(
    `SELECT COALESCE(
              applied.remote_operation_id,
              applied.remote_identity,
              reconciled.remote_operation_id,
              reconciled.remote_identity,
              NULLIF(operation.terminal_evidence->>'remoteOperationId', ''),
              NULLIF(operation.terminal_evidence->>'remoteId', ''),
              NULLIF(operation.terminal_evidence->'result'->>'checkRunId', '')
            ) AS remote_id
       FROM review_publication_operations operation
       LEFT JOIN LATERAL (
         SELECT attempt.remote_operation_id, attempt.remote_identity
           FROM review_publication_operation_attempts attempt
          WHERE attempt.repository_id = operation.repository_id
            AND attempt.pr_number = operation.pr_number
            AND attempt.publication_generation = operation.publication_generation
            AND attempt.operation_key = operation.operation_key
            AND attempt.phase = 'applied'
          ORDER BY attempt.observed_at DESC, attempt.id DESC
          LIMIT 1
       ) applied ON true
       LEFT JOIN LATERAL (
         SELECT reconciliation.remote_operation_id,
                reconciliation.remote_identity
           FROM review_publication_operation_reconciliations reconciliation
          WHERE reconciliation.repository_id = operation.repository_id
            AND reconciliation.pr_number = operation.pr_number
            AND reconciliation.publication_generation = operation.publication_generation
            AND reconciliation.operation_key = operation.operation_key
            AND reconciliation.outcome = 'applied'
          ORDER BY reconciliation.observed_at DESC, reconciliation.id DESC
          LIMIT 1
       ) reconciled ON true
      WHERE operation.repository_id = $1::bigint
        AND operation.pr_number = $2
        AND operation.publication_generation = $3::bigint
        AND operation.kind = $4
      LIMIT 1`,
    [
      identity.databaseRepositoryId,
      identity.pullRequestNumber,
      identity.publicationGeneration,
      kind,
    ],
  );
  const value = result.rows[0]?.remote_id;
  if (!value || !/^[1-9][0-9]{0,18}$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

async function finalizePublicationControllerGeneration(input: {
  identity: PublicationControllerReviewIdentity;
  payload: ReviewJobPayload;
  lease: JobLease;
  outcome: "success" | "definitive-failure" | "superseded";
  receipt?: PublicationReceipt;
}): Promise<void> {
  const context = await getDb()
    .select({
      envelope: schema.reviews.envelope,
      orgId: schema.installations.orgId,
      repositoryId: schema.repositories.id,
      reservationId: schema.hostedUsageReservations.id,
    })
    .from(schema.reviews)
    .innerJoin(
      schema.repositories,
      eq(schema.repositories.id, schema.reviews.repositoryId),
    )
    .innerJoin(
      schema.installations,
      eq(schema.installations.id, schema.repositories.installationId),
    )
    .leftJoin(
      schema.hostedUsageReservations,
      eq(schema.hostedUsageReservations.reviewId, schema.reviews.id),
    )
    .where(eq(schema.reviews.id, input.identity.reviewId))
    .limit(1);
  const row = context[0];
  if (!row?.envelope) {
    throw new ReviewPublicationReconciliationError(
      "publication-controller review has no staged envelope",
    );
  }
  const envelope = ingestEnvelope(JSON.stringify(row.envelope));
  const result = await finalizePublicationControllerReview(
    getDb(),
    {
      reviewId: input.identity.reviewId,
      reviewJobLease: input.lease,
      expectedReviewInput: input.payload,
      databaseRepositoryId: Number(input.identity.databaseRepositoryId),
      pullRequestNumber: input.identity.pullRequestNumber,
      publicationGeneration: input.identity.publicationGeneration,
      acceptedInputIdentity: input.identity.acceptedInputIdentity,
      outcome: input.outcome,
      ...(input.receipt === undefined ? {} : { publicationReceipt: input.receipt }),
      usage: reviewUsageFromEnvelope(envelope.envelope, {
        orgId: row.orgId,
        repositoryId: row.repositoryId,
        byok: row.reservationId === null,
      }),
      hostedUsageReservationId: row.reservationId,
      usageAccountingComplete: envelope.usageAccountingComplete,
      advisoryCheckRunId: await publicationControllerRemoteCheckRunId(
        input.identity,
        "advisoryCheckCreate",
      ),
      gateCheckRunId: await publicationControllerRemoteCheckRunId(
        input.identity,
        "gateCheckCreate",
      ),
    },
    row.orgId,
  );
  if (!result.completed && !result.superseded) {
    throw new ReviewPublicationReconciliationError(
      "publication-controller finalization did not settle the exact review lease",
    );
  }
}

async function runPublicationControllerRecovery(input: {
  payload: ReviewJobPayload;
  lease: JobLease;
  signal?: AbortSignal;
}, detectedIdentity?: PublicationControllerReviewIdentity): Promise<
  PublicationControllerReviewAction | null
> {
  return runPublicationControllerReviewStateMachine(
    input,
    buildPublicationControllerReviewStateMachineDependencies({
      loadIdentity: detectedIdentity
        ? async () => detectedIdentity
        : loadPublicationControllerReviewIdentity,
      inspectGeneration: ({ identity, lease }) =>
        inspectPublicationControllerGeneration({ identity, lease }),
      executeOne: executeOnePublicationControllerOperation,
      deriveReceipt: ({ identity }) =>
        loadAndDeriveGitHubPublicationReceipt({
          database: getPool(),
          repositoryId: identity.databaseRepositoryId,
          pullRequestNumber: identity.pullRequestNumber,
          publicationGeneration: identity.publicationGeneration,
          reviewId: identity.reviewId,
          acceptedInputIdentity: identity.acceptedInputIdentity,
        }),
      finalize: finalizePublicationControllerGeneration,
      loadContinuationPayload: loadPublicationControllerContinuationPayload,
      throwIfStopping: throwIfWorkerStopping,
    }),
  );
}

function publicationControllerGateOutput(input: {
  gateEnabled: boolean;
  gateFailing: boolean;
  unavailable: boolean;
  detailsUrl: string;
}) {
  if (!input.gateEnabled) {
    return {
      conclusion: "neutral" as const,
      title: "Postil gate is advisory",
      summary: input.unavailable
        ? "Merge blocking is disabled. The incomplete review remains advisory."
        : "Merge blocking is disabled. Review findings remain advisory.",
      detailsUrl: input.detailsUrl,
    };
  }
  if (input.unavailable) {
    return {
      conclusion: "failure" as const,
      title: "Review unavailable",
      summary: "Postil could not complete this review. The merge check remains blocked.",
      detailsUrl: input.detailsUrl,
    };
  }
  if (input.gateFailing) {
    return {
      conclusion: "failure" as const,
      title: "Postil gate blocked",
      summary: "One or more blocking findings remain.",
      detailsUrl: input.detailsUrl,
    };
  }
  return {
    conclusion: "success" as const,
    title: "Postil gate passed",
    summary: "No blocking findings remain for this commit.",
    detailsUrl: input.detailsUrl,
  };
}

/**
 * Run one hosted review end to end.
 *
 * The worker's job is deliberately small: mint a token, create the two
 * check-runs (so it owns their ids even if the CLI crashes), spawn the CLI,
 * store the envelope, and give each check its policy-correct terminal outcome
 * on crash or timeout. All review logic lives in the CLI.
 */
export async function runReviewJob(
  payload: ReviewJobPayload,
  timing: { queuedAt: Date; startedAt: Date; lease: JobLease },
  observabilityProcessGroup: ObservabilityProcessGroup = "worker",
  signal?: AbortSignal,
  onPublicationStarted?: () => void,
  publicationControllerClaim?: PublicationControllerClaimAuthority,
): Promise<PublicationControllerReviewAction | void> {
  throwIfWorkerStopping(signal);
  if (
    typeof payload.sourceInstallationId !== "number" ||
    typeof payload.sourceOrgId !== "number" ||
    typeof payload.githubRepoId !== "number"
  ) {
    throw new PermanentJobError("review job lacks immutable source identity");
  }
  const db = getDb();
  const leaseActive = () => externalSideEffectLeaseActive(getPool(), timing.lease);
  if (!(await leaseActive())) return;
  const controllerOwned = publicationControllerClaim !== undefined;
  const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
  const recovery = await runPublicationControllerRecoveryIfAuthorized({
    payload,
    claim: publicationControllerClaim,
    localReleaseSha: releaseSha,
    authorityError: (message) => new PermanentJobError(message),
    recover: () => runExactPublicationControllerRecovery({
      payload,
      loadIdentity: () => loadPublicationControllerReviewIdentity({
        payload,
        lease: timing.lease,
      }),
      recover: async (recoveryIdentity) => {
        const action = await runPublicationControllerRecovery({
          payload,
          lease: timing.lease,
          signal,
        }, recoveryIdentity);
        if (action === null) {
          throw new ReviewPublicationReconciliationError(
            "publication-controller staged identity was lost during recovery",
          );
        }
        return action;
      },
      isShutdownError: (error) => error instanceof WorkerShutdownError,
      isReconciliationError: (error) =>
        error instanceof ReviewPublicationReconciliationError,
      reconciliationError: (message) =>
        new ReviewPublicationReconciliationError(message),
      errorMessage: redactSecrets,
    }),
  });
  if (recovery !== null) return recovery;
  if (
    !controllerOwned &&
    releaseSha &&
    await publicationControllerLegacyReviewFenced(getPool(), releaseSha)
  ) {
    throw new PublicationControllerReleaseFenceError(releaseSha);
  }

  const installation = (
    await db
      .select({
        id: schema.installations.id,
        orgId: schema.installations.orgId,
        orgSlug: schema.organizations.slug,
        githubOrgId: schema.organizations.githubOrgId,
        suspended: schema.installations.suspended,
      })
      .from(schema.installations)
      .leftJoin(
        schema.organizations,
        eq(schema.installations.orgId, schema.organizations.id),
      )
      .where(
        eq(schema.installations.githubInstallationId, payload.installationId),
      )
      .limit(1)
  )[0];
  if (
    !installation ||
    installation.id !== payload.sourceInstallationId ||
    installation.orgId !== payload.sourceOrgId
  ) {
    throw new PermanentJobError(
      `review job cannot start: unknown installation ${payload.installationId}`,
    );
  }
  const repository = (
    await db
      .select()
      .from(schema.repositories)
      .where(
        and(
          eq(schema.repositories.installationId, installation.id),
          eq(schema.repositories.githubRepoId, payload.githubRepoId),
        ),
      )
      .limit(1)
  )[0];
  if (!repository || repository.fullName !== payload.repoFullName) {
    throw new PermanentJobError(
      `review job cannot start: repository ${payload.repoFullName} is missing`,
    );
  }
  if (
    !controllerOwned &&
    await resumeStagedReviewCompletion({
      db,
      payload,
      lease: timing.lease,
      installation,
      repository,
      signal,
    })
  ) {
    return;
  }
  if (installation.suspended) {
    throw new PermanentJobError(
      `review job cannot start: installation ${payload.installationId} is suspended`,
    );
  }
  if (!repository.enabled) {
    throw new PermanentJobError(
      `review job cannot start: repository ${payload.repoFullName} is disabled`,
    );
  }
  const signedOrStoredPrivate =
    repository.private || payload.repositoryPrivate === true;
  const repositoryAccess = await canProcessRepositoryInference(db, {
    orgId: installation.orgId,
    repositoryPrivate: signedOrStoredPrivate,
  });
  if (!repositoryAccess.allowed) {
    throw new PermanentJobError(
      `review job cannot start: repository ${payload.repoFullName} is not entitled to inference`,
    );
  }
  // Validate the configured origin before inserting any review. A bad
  // deployment setting must not create a row whose check-runs cannot link to it.
  configuredPublicOrigin();
  const llm = await resolveLlmConfig(installation.orgId);
  const hostedReviewUnavailable =
    !llm.byok && !(await hostedInferenceAvailable(getPool()));
  if (hostedReviewUnavailable) {
    const releaseSha = optionalEnv("POSTIL_RELEASE_SHA");
    if (hostedInferenceEnabled() && releaseSha) {
      throw new HostedInferenceReleaseDarkError(releaseSha);
    }
    const trigger = normalizeReviewTriggerContext(payload.trigger);
    const paused = await claimPausedHostedReview(
      db,
      {
        repositoryId: repository.id,
        prNumber: payload.prNumber,
        authorGithubId: payload.authorGithubId ?? null,
        authorLogin: payload.authorLogin ?? null,
        headSha: payload.headSha,
        baseSha: payload.baseSha,
        sinceSha: null,
        triggerSource: trigger.source,
        triggerContext: trigger,
        queuedAt: timing.queuedAt,
        startedAt: timing.startedAt,
      },
      {
        installationId: payload.installationId,
        repoFullName: payload.repoFullName,
        orgSlug: installation.orgSlug,
        checkRunsMayExist: false,
      },
    );
    console.warn(
      `review job skipped: managed hosted inference is unavailable${paused ? "" : "; pause already recorded"}`,
    );
    return;
  }
  const token = await translateWorkerAbort(
    getInstallationToken(payload.installationId, signal),
    signal,
  );
  const currentRepository = await translateWorkerAbort(
    fetchRepositorySummary(token, payload.repoFullName, signal),
    signal,
  );
  if (
    currentRepository.id !== payload.githubRepoId ||
    currentRepository.full_name !== payload.repoFullName
  ) {
    throw new PermanentJobError("review job repository identity changed");
  }
  const liveContext = await translateWorkerAbort(
    getPullRequestReviewContext(
      token,
      currentRepository.full_name,
      payload.prNumber,
      signal,
    ),
    signal,
  );
  // Jobs admitted by a pre-rollout binary have no event timestamp. Bind them
  // to the first live snapshot observed by the homogeneous fleet so they can
  // drain safely after lock-generation activation.
  const expectedPullRequestUpdatedAt =
    typeof payload.expectedPullRequestUpdatedAt === "string" &&
      Number.isFinite(Date.parse(payload.expectedPullRequestUpdatedAt))
      ? payload.expectedPullRequestUpdatedAt
      : liveContext.updatedAt;
  const liveSnapshotLagsEvent = livePullRequestSnapshotLagsEvent(
    expectedPullRequestUpdatedAt,
    liveContext.updatedAt,
  );
  if (!(await leaseActive())) {
    console.warn("review job skipped: lost its lease");
    return;
  }
  if (!liveContext.open || liveContext.merged || liveContext.draft) {
    console.warn("review job skipped: pull request is not reviewable");
    return;
  }
  if (
    !liveSnapshotLagsEvent &&
    (liveContext.headSha !== payload.headSha || liveContext.baseSha !== payload.baseSha)
  ) {
    await enqueueObservedReviewSnapshot(getPool(), payload, liveContext);
    console.warn("review job reconciled to the current pull request snapshot");
    return;
  }
  await db
    .update(schema.repositories)
    .set({
      fullName: currentRepository.full_name,
      private: currentRepository.private,
    })
    .where(eq(schema.repositories.id, repository.id));
  const currentAccess = await canProcessRepositoryInference(db, {
    orgId: installation.orgId,
    repositoryPrivate: currentRepository.private,
  });
  if (!currentAccess.allowed) {
    throw new PermanentJobError(
      `review job cannot start: current visibility for ${payload.repoFullName} is not entitled to inference`,
    );
  }
  const providerModeMatches = providerModeMatchesRepositoryAccess(
    currentRepository.private,
    currentAccess,
    llm.byok,
  );

  let authorGithubId = payload.authorGithubId;
  let authorLogin = payload.authorLogin;
  if (currentRepository.private) {
    const context = liveContext;
    if (
      typeof context.authorGithubId !== "number" ||
      !Number.isSafeInteger(context.authorGithubId) ||
      context.authorGithubId <= 0 ||
      !context.authorLogin
    ) {
      throw new OperationalError(
        "private review author identity is unavailable",
      );
    }
    authorGithubId = context.authorGithubId;
    authorLogin = context.authorLogin;
  }

  // Incremental re-review: baseline = last completed review of this PR.
  const baseline = (
    await db
      .select()
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.repositoryId, repository.id),
          eq(schema.reviews.prNumber, payload.prNumber),
          eq(schema.reviews.status, "completed"),
          isNotNull(schema.reviews.envelope),
        ),
      )
      .orderBy(desc(schema.reviews.finishedAt))
      .limit(1)
  )[0];
  const preventionHint = await shouldSendPreventionHint(
    db,
    repository.id,
    payload.prNumber,
  );
  const trigger = normalizeReviewTriggerContext(payload.trigger);
  const forceFullReview = reviewRequiresFullDiff({
    requested: payload.forceFullReview === true,
    baselineBaseSha: baseline?.baseSha,
    currentBaseSha: payload.baseSha,
  });
  const reviewValues = {
    repositoryId: repository.id,
    sourceOrgId: payload.sourceOrgId,
    sourceInstallationId: payload.sourceInstallationId,
    sourceGithubInstallationId: payload.installationId,
    sourceGithubRepoId: payload.githubRepoId,
    sourceRepoFullName: payload.repoFullName,
    prNumber: payload.prNumber,
    authorGithubId: authorGithubId ?? null,
    authorLogin: authorLogin ?? null,
    headSha: payload.headSha,
    baseSha: payload.baseSha,
    sinceSha: forceFullReview ? null : (baseline?.headSha ?? null),
    triggerSource: trigger.source,
    triggerContext: trigger,
    queuedAt: timing.queuedAt,
    startedAt: timing.startedAt,
  };
  const inserted = (
    await db
      .insert(schema.reviews)
      .values({ ...reviewValues, status: "running" })
      .returning({ id: schema.reviews.id, publicId: schema.reviews.publicId })
  )[0];
  const reviewId = inserted?.id;
  const publicId = inserted?.publicId;
  if (reviewId === undefined || !publicId)
    throw new Error("review insert returned no row");
  const detailsUrl = reviewDetailsUrl(publicId, installation.orgSlug);

  const reviewLog = new ReviewLogWriter(reviewId);
  reviewLog.line(
    `review queued at ${timing.queuedAt.toISOString()} -> worker claimed at ${timing.startedAt.toISOString()}`,
  );

  let advisoryCheckRunId: number | undefined;
  let gateCheckRunId: number | undefined;
  let baselinePath: string | undefined;
  let workDir: string | undefined;
  let publicationReceiptPath: string | undefined;
  let sensitiveValues: string[] = [];
  let hostedUsageReservationId: string | null = null;
  let cliStarted = false;
  let completionStaged = false;
  let receiptUsageForRace: ReviewCompletionInput["usage"] | undefined;
  let usageAccountingCompleteForRace = false;
  let advisoryCheckRunMayExist = false;
  let gateCheckRunMayExist = false;
  let gateEnabled = false;
  let cliVersion = "unavailable";
  let largeReviewProxy: LargeReviewProviderProxy | undefined;
  const leaseAbortController = new AbortController();
  const reviewSignal = signal
    ? AbortSignal.any([signal, leaseAbortController.signal])
    : leaseAbortController.signal;
  const inputLeaseMonitor = timing.lease
    ? startReviewInputLeaseMonitor(
        () =>
          reviewInputLeaseState(
            getPool(),
            timing.lease!,
            expectedPullRequestUpdatedAt,
            payload.reviewInputSequence,
          ),
        leaseAbortController,
      )
    : undefined;
  const publicationAuthorized = async (): Promise<boolean> => {
    if (!(await leaseActive())) return false;
    const current = await translateWorkerAbort(
      getPullRequestReviewContext(
        token,
        payload.repoFullName,
        payload.prNumber,
        reviewSignal,
      ),
      reviewSignal,
    );
    const inputLeaseState = timing.lease
      ? await reviewInputLeaseState(
          getPool(),
          timing.lease,
          expectedPullRequestUpdatedAt,
          payload.reviewInputSequence,
        )
      : "current";
    if (inputLeaseState === "inactive") return false;
    if (inputLeaseState === "newer-pending") {
      throw new ReviewInputSupersededError();
    }
    if (
      livePullRequestSnapshotLagsEvent(
        expectedPullRequestUpdatedAt,
        current.updatedAt,
      )
    ) {
      throw new ReviewInputConvergenceError(
        `GitHub pull request ${payload.repoFullName}#${payload.prNumber} has not converged to the signed edit`,
      );
    }
    return current.open &&
      !current.merged &&
      !current.draft &&
      current.headSha === payload.headSha &&
      current.baseSha === payload.baseSha;
  };
  const advisoryCheckExternalId = checkRunExternalId(publicId, "review");
  const gateCheckExternalId = checkRunExternalId(publicId, "gate");
  const expectedFailureCheckRuns = (
    publicationIncomplete = false,
  ): ExpectedFailureCheckRuns => ({
    ...(advisoryCheckRunId === undefined
      ? {}
      : {
          advisory: {
            id: advisoryCheckRunId,
            name: ADVISORY_CHECK_NAME,
            externalId: advisoryCheckExternalId,
            headSha: payload.headSha,
            detailsUrl,
          },
        }),
    ...(gateCheckRunId === undefined
      ? {}
      : {
          gate: {
            id: gateCheckRunId,
            name: GATE_CHECK_NAME,
            externalId: gateCheckExternalId,
            headSha: payload.headSha,
            detailsUrl,
          },
        }),
    publicationIncomplete,
  });

  try {
    gateEnabled = await getOrganizationGateEnabled(db, installation.orgId);
    throwIfWorkerStopping(reviewSignal);
    sensitiveValues = [token];
    reviewLog.setSensitiveValues(sensitiveValues);
    try {
      if (!(await publicationAuthorized())) {
        reviewLog.line("publication cancelled before forge writes");
        throw new TerminalReviewError(
          "pull request is no longer eligible for publication",
        );
      }
    } catch (error) {
      // A signed synchronize head owns checks even while GitHub's REST read
      // lags the event. The second authorization immediately before the CLI
      // either observes convergence or terminalizes this pair and retries.
      if (!(error instanceof ReviewInputConvergenceError)) throw error;
      reviewLog.line(
        "signed pull request head accepted while GitHub convergence is pending",
      );
    }
    onPublicationStarted?.();
    if (!controllerOwned) {
      const superseded = await supersedeActiveReviews({
        repositoryId: repository.id,
        prNumber: payload.prNumber,
        newHeadSha: payload.headSha,
        repoFullName: payload.repoFullName,
        githubInstallationId: payload.installationId,
        excludeReviewId: reviewId,
        orgSlug: installation.orgSlug,
      });
      if (superseded > 0)
        reviewLog.line(`superseded ${superseded} earlier active review(s)`);

      advisoryCheckRunId = await createCheckRun(
        token,
        payload.repoFullName,
        ADVISORY_CHECK_NAME,
        payload.headSha,
        { signal: reviewSignal, externalId: advisoryCheckExternalId },
      ).catch((error) => {
        advisoryCheckRunMayExist =
          error instanceof AmbiguousCheckRunCreationError;
        throw error;
      });
      await db
        .update(schema.reviews)
        .set({ advisoryCheckRunId })
        .where(eq(schema.reviews.id, reviewId));
      gateCheckRunId = await createCheckRun(
        token,
        payload.repoFullName,
        GATE_CHECK_NAME,
        payload.headSha,
        {
          signal: reviewSignal,
          externalId: gateCheckExternalId,
          detailsUrl,
        },
      ).catch((error) => {
        gateCheckRunMayExist = error instanceof AmbiguousCheckRunCreationError;
        throw error;
      });
      await db
        .update(schema.reviews)
        .set({ gateCheckRunId })
        .where(eq(schema.reviews.id, reviewId));
      reviewLog.line("forge check-runs created");
    }

    if (!providerModeMatches) {
      throw new TerminalReviewError(
        "configured provider mode does not match the active inference entitlement",
      );
    }

    throwIfWorkerStopping(reviewSignal);
    const cliVersionLine = await postilCliVersionLogLine();
    cliVersion = cliVersionLine.replace(/^postil CLI version /, "");
    reviewLog.line(cliVersionLine);

    const args = controllerOwned ? [] : [
      "review",
      "--forge",
      "github",
      // Remote CLI invocations are local-only by default. The hosted worker is
      // the explicit publication boundary, so it must opt in deliberately.
      "--publish",
      // The CLI publishes only the advisory result. The worker completes the
      // merge gate after the envelope and accounting are terminal in Postil.
      "--defer-gate-check",
      "--repo",
      payload.repoFullName,
      "--pr",
      String(payload.prNumber),
      "--sha",
      payload.headSha,
      "--base-sha",
      payload.baseSha,
      "--check-run-id",
      String(advisoryCheckRunId),
      "--gate-check-run-id",
      String(gateCheckRunId),
    ];
    if (!controllerOwned && optionalEnv("POSTIL_LOCAL_REVIEW_BOUNDED") === "1") {
      args.push("--bounded");
    }
    if (baseline?.envelope) {
      await mkdir(join(CACHE_DIR, "baselines"), { recursive: true });
      baselinePath = join(CACHE_DIR, "baselines", `review-${reviewId}.json`);
      await writeFile(baselinePath, JSON.stringify(baseline.envelope));
      // Absolute: the CLI resolves --baseline against its own cwd, which is
      // the per-review work dir below, not the worker's.
      if (!controllerOwned) {
        if (!forceFullReview) args.push("--since-sha", baseline.headSha);
        args.push("--baseline", resolve(baselinePath));
      }
    }
    if (!controllerOwned) args.push("--output", "json");

    // Materialize the repo's .postil config (default branch) into a fresh
    // per-review directory and run the CLI there, so repo-level config works
    // hosted exactly as it does locally. See lib/github/contents.ts for the
    // trust model (default branch only, never the PR head).
    workDir = resolve(CACHE_DIR, "workdirs", `review-${reviewId}`);
    await mkdir(workDir, { recursive: true });
    publicationReceiptPath = join(workDir, "publication-receipt.json");
    const repoConfigFiles = await materializeRepoConfig(
      token,
      payload.repoFullName,
      workDir,
      { allowModelSettings: llm.byok },
    );
    if (repoConfigFiles.length > 0) {
      console.log(
        `review ${reviewId}: using repo config from ${payload.repoFullName} (${repoConfigFiles.join(", ")})`,
      );
    }
    let sharedConfigFiles: string[] = [];
    let sharedProvenance: ConfigProvenanceEntry[] = [];
    const missingSharedSlots = missingRepositoryConfigSlots(repoConfigFiles);
    if (
      missingSharedSlots.length > 0 &&
      installation.orgId !== null &&
      installation.githubOrgId !== null &&
      (await resolveSharedConfigEnabled(installation.orgId))
    ) {
      const owner = currentRepository.full_name.split("/", 1)[0];
      if (owner) {
        const shared = await resolveOwnerGithubConfig(
          createOwnerConfigStore(db),
          {
            token,
            orgId: installation.orgId,
            githubOwnerId: installation.githubOrgId,
            installationId: installation.id,
            owner,
            requiredSlots: missingSharedSlots,
          },
        );
        sharedProvenance = shared.provenance;
        sharedConfigFiles = await materializeSharedConfig(
          workDir,
          repoConfigFiles,
          shared.config,
          { allowModelSettings: llm.byok },
        );
        reviewLog.line(
          `shared configuration ${shared.status}${shared.stale ? " (last known good snapshot)" : ""}`,
        );
      }
    }
    const orgConfigFiles = await materializeOrgConfig(
      workDir,
      [
        ...repoConfigFiles,
        ...sharedConfigFiles.map((file) => file.slice("shared:".length)),
      ],
      await resolveOrgReviewConfig(installation.orgId),
    );
    if (orgConfigFiles.length > 0) {
      console.log(
        `review ${reviewId}: using hosted organization config (${orgConfigFiles
          .map((file) => file.slice(4))
          .join(", ")})`,
      );
    }
    const configFiles = [
      ...repoConfigFiles,
      ...sharedConfigFiles,
      ...orgConfigFiles,
    ];
    const configProvenance = buildConfigProvenance(
      configFiles,
      sharedProvenance,
      {
        id: currentRepository.id,
        fullName: currentRepository.full_name,
      },
    );
    reviewLog.line(
      `configuration materialized (${configFiles.length > 0 ? configFiles.join(", ") : "no overrides"})`,
    );

    const configurationSha256 = await hashEffectiveReviewConfiguration(
      workDir,
      configFiles,
    );
    const durableRunIdentity = {
      repositoryId: repository.id,
      prNumber: payload.prNumber,
      cliVersion,
      configurationSha256,
      providerIdentity: providerIdentity({
        ...llm,
        identityKey: getSealingKey(),
      }),
      headSha: payload.headSha,
      baseSha: payload.baseSha,
      retryLineage: providerRetryLineageForJob(payload, timing.lease.id),
    };
    let expectedRunKey: string | undefined;
    if (!llm.byok) {
      const reusableReservation = await claimReusableLargeReviewReservation(
        db,
        durableRunIdentity,
        reviewId,
      );
      if (reusableReservation.kind === "conservatively-settled") {
        throw new TerminalReviewError(
          "large-review provider outcome was already conservatively settled",
        );
      }
      if (reusableReservation.kind === "resume") {
        hostedUsageReservationId = reusableReservation.reservationId;
        expectedRunKey = reusableReservation.expectedRunKey;
        reviewLog.line("hosted inference spend reservation resumed");
      } else {
        const spendReservation = await reserveHostedReviewSpend(db, {
          orgId: installation.orgId,
          reviewId,
          usesByok: llm.byok,
        });
        if (spendReservation && !spendReservation.allowed) {
          const message =
            "Hosted inference allowance is unavailable or fully reserved.";
          const settled = await db.transaction(async (tx) => {
            const failedRows = await tx
              .update(schema.reviews)
              .set({
                status: "failed",
                errorMessage: message,
                finishedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.reviews.id, reviewId),
                  eq(schema.reviews.status, "running"),
                ),
              )
              .returning({ id: schema.reviews.id });
            if (failedRows.length === 0) return false;
            if (!controllerOwned) {
              await tx.insert(schema.jobs).values({
                kind: "check-run-cleanup",
                payload: {
                  installationId: payload.installationId,
                  repoFullName: payload.repoFullName,
                  advisoryCheckRunId,
                  gateCheckRunId,
                  headSha: payload.headSha,
                  advisoryCheckExternalId,
                  gateCheckExternalId,
                  advisoryCheckRunMayExist,
                  gateCheckRunMayExist,
                  message,
                  detailsUrl,
                  intent: "fail",
                },
                maxAttempts: 5,
              });
            }
            return true;
          });
          if (settled && !controllerOwned) {
            await failCheckRuns(
              token,
              payload.repoFullName,
              advisoryCheckRunId,
              gateCheckRunId,
              message,
              undefined,
              false,
              detailsUrl,
              expectedFailureCheckRuns(),
              gateEnabled,
            );
          }
          reviewLog.line(
            "hosted inference reservation denied before provider access",
          );
          console.warn(
            `review job skipped: private repository ${payload.repoFullName} has no hosted inference capacity`,
          );
          return;
        }
        hostedUsageReservationId = spendReservation.reservationId;
        reviewLog.line("hosted inference spend reserved");
      }
    }
    const allowPrivateUpstream = privateUpstreamAllowed({
      byok: llm.byok,
      configuredOptIn: optionalEnv("POSTIL_ALLOW_PRIVATE_API_BASE"),
    });
    const activeLargeReviewProxy = await startLargeReviewProviderProxy({
      upstreamApiBase: llm.apiBase,
      apiFormat: llm.apiFormat,
      additionalAuthHeader: llm.apiAuthHeader,
      allowPrivateUpstream,
      identity: durableRunIdentity,
      runContext: {
        currentReviewId: reviewId,
        hostedReservationId: hostedUsageReservationId,
        expectedRunKey,
      },
      store: new PostgresLargeReviewAttemptStore(db),
    });
    largeReviewProxy = activeLargeReviewProxy;

    sensitiveValues = [
      token,
      llm.apiKey,
      llm.apiAuthHeader,
      llm.apiAuthValue,
      ...activeLargeReviewProxy.redactionValues,
    ].filter((value): value is string => Boolean(value));
    reviewLog.setSensitiveValues(sensitiveValues);
    throwIfWorkerStopping(reviewSignal);
    const cliEnv = buildCliEnv(
      { ...llm, apiBase: activeLargeReviewProxy.apiBase },
      {
        GITHUB_TOKEN: token,
        POSTIL_ALLOW_PRIVATE_API_BASE: "1",
        POSTIL_LARGE_REVIEW_PLAN_ENDPOINT: activeLargeReviewProxy.planEndpoint,
        POSTIL_LARGE_REVIEW_PLAN_TOKEN: activeLargeReviewProxy.planToken,
        POSTIL_EXPECTED_GITHUB_REPO_ID: String(repository.githubRepoId),
        ...(detailsUrl ? { POSTIL_DETAILS_URL: detailsUrl } : {}),
        POSTIL_PREVENTION_HINT: preventionHint ? "1" : "0",
        POSTIL_PREVENTION_COMMANDS_JSON: JSON.stringify(
          preventionHint
            ? await discoverPreventionCommands(token, payload.repoFullName)
            : [],
        ),
        ...(!controllerOwned
          ? {
              // The path is optional. A CLI without receipt support ignores it,
              // and absence is persisted as legacy unknown.
              POSTIL_PUBLICATION_RECEIPT_PATH: publicationReceiptPath,
            }
          : {}),
      },
    );

    if (controllerOwned) {
      if (!detailsUrl) {
        throw new PermanentJobError(
          "publication-controller review has no public details URL",
        );
      }
      const publicationContext = await translateWorkerAbort(
        getPullRequestPublicationContext(
          token,
          payload.repoFullName,
          payload.prNumber,
          reviewSignal,
        ),
        reviewSignal,
      );
      const exactUpdatedAt = new Date(expectedPullRequestUpdatedAt).toISOString();
      if (
        !publicationContext.open ||
        publicationContext.merged ||
        publicationContext.draft ||
        publicationContext.headSha !== payload.headSha ||
        publicationContext.baseSha !== payload.baseSha ||
        publicationContext.updatedAt !== exactUpdatedAt
      ) {
        throw new ReviewInputSupersededError();
      }
      if (
        !payload.reviewInputSequence ||
        !/^[1-9][0-9]*$/u.test(payload.reviewInputSequence)
      ) {
        throw new PermanentJobError(
          "publication-controller review lacks an exact input generation",
        );
      }
      const bounded = optionalEnv("POSTIL_LOCAL_REVIEW_BOUNDED") === "1";
      const acceptedInput = buildGitHubPublicationInputIdentity({
        databaseRepositoryId: String(repository.id),
        githubRepositoryId: String(repository.githubRepoId),
        repositoryFullName: payload.repoFullName,
        pullRequestNumber: String(payload.prNumber),
        controllerGeneration: payload.reviewInputSequence,
        reviewId: String(reviewId),
        headSha: publicationContext.headSha,
        mergeBaseSha: publicationContext.mergeBaseSha,
        targetSha: publicationContext.baseSha,
        targetBranch: publicationContext.targetBranch,
        pullRequestTitle: publicationContext.title,
        pullRequestBody: publicationContext.body,
        expectedPullRequestUpdatedAt: publicationContext.updatedAt,
        cliVersion,
        cliCommitSha: release.hostedCliCommit,
        cliArtifactSha256: `sha256:${release.hostedCliLinuxX86_64Sha256}`,
        configurationSha256: `sha256:${configurationSha256}`,
        providerIdentity: durableRunIdentity.providerIdentity,
        retryLineage: durableRunIdentity.retryLineage,
        ...(baseline?.envelope && !forceFullReview
          ? {
              baselineReviewId: String(baseline.id),
              baselineHeadSha: baseline.headSha,
              baselineEnvelopeSha256:
                `sha256:${githubPublicationEnvelopeDigest(baseline.envelope)}`,
            }
          : {}),
        bounded,
        forceFullReview,
        detailsUrl,
      });
      if (!(await publicationAuthorized())) {
        throw new ReviewInputSupersededError();
      }
      cliStarted = true;
      const planned = await runGitHubPublicationCliPlanning({
        execute: runCli,
        environment: cliEnv,
        workingDirectory: workDir,
        expected: {
          controllerGeneration: payload.reviewInputSequence,
          inputIdentity: acceptedInput.digest,
          repositoryId: String(repository.githubRepoId),
          repositoryFullName: payload.repoFullName,
          pullRequestNumber: String(payload.prNumber),
          headSha: publicationContext.headSha,
          mergeBaseSha: publicationContext.mergeBaseSha,
          targetSha: publicationContext.baseSha,
          pullRequestTitle: publicationContext.title,
          pullRequestBody: publicationContext.body,
        },
        bounded,
        ...(!forceFullReview && baselinePath
          ? { baselinePath: resolve(baselinePath), sinceSha: baseline?.headSha }
          : {}),
        signal: reviewSignal,
        onStderrLine: (line) => reviewLog.line(`[stderr] ${line}`),
      });
      for (const incident of classifyOperationalModelIncidents(
        planned.ingestedEnvelope.envelope,
      )) {
        reportOperationalModelIncident(observabilityProcessGroup, incident);
      }
      receiptUsageForRace = reviewUsageFromEnvelope(
        planned.ingestedEnvelope.envelope,
        { orgId: installation.orgId, repositoryId: repository.id, byok: llm.byok },
      );
      usageAccountingCompleteForRace =
        planned.ingestedEnvelope.usageAccountingComplete;
      const gateOutput = publicationControllerGateOutput({
        gateEnabled,
        gateFailing: planned.ingestedEnvelope.gateFailing,
        unavailable: isEnvelopeOperationallyUnavailable(
          planned.ingestedEnvelope.envelope,
        ),
        detailsUrl,
      });
      const requiredOperationKey = planned.acceptedPlan.value.operations.at(-1)
        ?.operationKey;
      if (!requiredOperationKey) {
        throw new PermanentJobError(
          "publication-controller plan has no terminal advisory operation",
        );
      }
      const controllerManifest = buildGitHubPublicationControllerManifest({
        acceptedPlan: planned.acceptedPlan.value,
        acceptedPlanBytesDigest: `sha256:${planned.acceptedPlan.digest}`,
        requiredTerminalOperationKeys: [requiredOperationKey],
        gateOutput,
      });
      await stageGitHubPublicationCandidateAtomically({
        database: getPool(),
        organizationId: installation.orgId,
        envelopeArtifact: planned.envelopeArtifact,
        completion: {
          reviewId,
          reviewJobLease: timing.lease,
          envelope: planned.ingestedEnvelope.envelope,
          configFiles,
          configProvenance,
          silent: planned.ingestedEnvelope.silent,
          gateFailing: planned.ingestedEnvelope.gateFailing,
          deferPublicationReceipt: true,
        },
        generation: {
          acceptedInput,
          acceptedPlan: planned.acceptedPlan,
          controllerManifest,
          snapshot: {
            repositoryId: repository.id,
            githubRepositoryId: repository.githubRepoId,
            reviewId,
            reviewInputSequence: payload.reviewInputSequence,
            expectedPullRequestUpdatedAt: publicationContext.updatedAt,
            envelopeDigest: githubPublicationEnvelopeDigest(
              planned.ingestedEnvelope.envelope,
            ),
            targetBranch: publicationContext.targetBranch,
            pullRequestTitle: publicationContext.title,
            pullRequestBody: publicationContext.body,
          },
        },
      });
      completionStaged = true;
      await activeLargeReviewProxy.discardCompletedRun();
      reviewLog.line("review result and publication generation staged durably");
      return {
        kind: "continue",
        payload: await loadPublicationControllerContinuationPayload({
          identity: {
            databaseRepositoryId: String(repository.id),
            pullRequestNumber: payload.prNumber,
            publicationGeneration: payload.reviewInputSequence,
            reviewId,
            acceptedInputIdentity: acceptedInput.digest,
          },
          lease: timing.lease,
        }),
      };
    }

    const result = await withReviewPublicationFence(
      getPool(),
      payload,
      async () => {
        if (!(await publicationAuthorized())) {
          reviewLog.line("publication cancelled before CLI start");
          throw new TerminalReviewError(
            "pull request is no longer eligible for publication",
          );
        }
        reviewLog.line("postil CLI spawned under the pull request publication fence");
        cliStarted = true;
        return runCli(args, cliEnv, workDir, {
          onStderrLine: (line) => reviewLog.line(`[stderr] ${line}`),
          signal: reviewSignal,
          preserveOutputOnInterrupt: true,
        });
      },
    );
    if (
      result.interrupted &&
      leaseAbortController.signal.reason instanceof ReviewInputSupersededError
    ) {
      throw leaseAbortController.signal.reason;
    }
    reviewLog.line(
      `postil CLI exited with code ${result.exitCode}${result.timedOut ? " after timeout" : ""}${result.interrupted ? " during worker interruption" : ""}`,
    );

    if (result.timedOut) {
      throw new OperationalError(
        `review exceeded ${REVIEW_DEADLINE_MS / 60000} minute deadline`,
      );
    }
    // Exit 0 = clean/below gate, 1 = gate-failing findings. Strict hosted
    // publication can emit the completed envelope and then exit 2 when GitHub
    // accepts only part of the result. Retain that envelope and let the exact
    // check identities move to durable cleanup instead of rerunning inference.
    const ingested = ingestCompletedHostedReview({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      interrupted: result.interrupted,
    }, sensitiveValues);
    const snapshotChanged = publicationSkippedForChangedSnapshot(result.stderr);
    for (const incident of classifyOperationalModelIncidents(
      ingested.envelope,
    )) {
      reportOperationalModelIncident(observabilityProcessGroup, incident);
    }
    reviewLog.line(
      formatHostedReviewIngestionLog(
        result.stdout,
        ingested.envelope,
        ingested.gateFailing,
      ),
    );
    let publicationReceipt: PublicationReceipt | undefined;
    try {
      publicationReceipt = await readPublicationReceipt(publicationReceiptPath);
      reviewLog.line(
        `publication receipt ingested (${publicationReceipt.findings.length} finding states)`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reviewLog.line("publication receipt absent; lifecycle recorded as legacy unknown");
      } else {
        throw error;
      }
    }
    const operationallyUnavailable = isEnvelopeOperationallyUnavailable(
      ingested.envelope,
    );
    const receiptUsage = reviewUsageFromEnvelope(ingested.envelope, {
      orgId: installation.orgId,
      repositoryId: repository.id,
      byok: llm.byok,
    });
    receiptUsageForRace = receiptUsage;
    usageAccountingCompleteForRace = ingested.usageAccountingComplete;
    const staged = await stageReviewCompletionCandidate(
      db,
      {
        reviewId,
        reviewJobLease: timing.lease,
        envelope: ingested.envelope,
        configFiles,
        configProvenance,
        silent: ingested.silent,
        gateFailing: ingested.gateFailing,
        publicationReceipt,
      },
      installation.orgId,
    );
    if (!staged.staged) {
      throw new ReviewPublicationReconciliationError(
        "review completion lost its terminal-state race",
      );
    }
    completionStaged = true;
    await activeLargeReviewProxy.discardCompletedRun();
    reviewLog.line("review result staged durably");
    if (snapshotChanged) {
      // The CLI refused to complete a check-run for a pull request snapshot
      // that has already moved on. A newer push means a fresher review
      // already covers the new head, so this run is stale in exactly the
      // sense supersession assigns, not a publication failure to reconcile.
      if (hostedUsageReservationId) {
        await reconcileHostedReviewSpendFromReceipt(db, {
          reservationId: hostedUsageReservationId,
          repositoryId: repository.id,
          reviewId,
          triggerSource: reviewValues.triggerSource,
          usage: receiptUsage,
          usageAccountingComplete: ingested.usageAccountingComplete,
        });
      }
      await markReviewStaleWithDurableCleanup(db, {
        reviewId,
        installationId: payload.installationId,
        repoFullName: payload.repoFullName,
        headSha: payload.headSha,
        advisoryCheckRunId: advisoryCheckRunId ?? null,
        gateCheckRunId: gateCheckRunId ?? null,
        advisoryCheckExternalId,
        gateCheckExternalId,
        advisoryCheckRunMayExist,
        gateCheckRunMayExist,
        message: "the pull request snapshot changed before this review could publish",
        detailsUrl,
        intent: "neutralize",
      });
      await neutralizeSupersededCheckRuns(
        token,
        payload.repoFullName,
        advisoryCheckRunId ?? null,
        gateCheckRunId ?? null,
        "the pull request snapshot changed before this review could publish",
        detailsUrl,
      );
      reviewLog.line(
        "review marked stale: CLI declined to publish for a superseded pull request snapshot",
      );
      return;
    }
    if (operationallyUnavailable) {
      await failCheckRuns(
        token,
        payload.repoFullName,
        advisoryCheckRunId,
        gateCheckRunId,
        "the review envelope contains an operational sentinel",
        result.interrupted ? undefined : signal,
        true,
        detailsUrl,
        expectedFailureCheckRuns(),
        gateEnabled,
      );
      reviewLog.line(
        "operational sentinel published as no reviewer verdict with policy-sensitive gate",
      );
    }
    const workerInstanceId = timing.lease.lockedBy.match(/^(.+)#\d+$/)?.[1];
    if (observabilityProcessGroup === "worker" && workerInstanceId) {
      const rehearsalNonce = await consumePrivateWorkerRehearsalAfterStaging(
        getPool(),
        {
          reviewId,
          reviewJobLease: timing.lease,
          repoFullName: payload.repoFullName,
          prNumber: payload.prNumber,
          headSha: payload.headSha,
          workerInstanceId,
        },
      );
      if (rehearsalNonce) {
        reviewLog.line("private worker interruption rehearsal consumed");
        throw new WorkerInterruptionRehearsalError(rehearsalNonce);
      }
    }
    try {
      await verifyCompletedCheckRun(
        token,
        payload.repoFullName,
        {
          id: advisoryCheckRunId!,
          name: ADVISORY_CHECK_NAME,
          externalId: advisoryCheckExternalId,
          headSha: payload.headSha,
          conclusion: operationallyUnavailable ? "neutral" : "success",
          requireOutput: true,
          detailsUrl,
        },
        result.interrupted ? undefined : signal,
      );
    } catch (error) {
      if (error instanceof CheckRunPublicationError) {
        throw error;
      }
      throw new CheckRunPublicationError(
        "GitHub review publication could not be verified",
        { cause: error },
      );
    }
    reviewLog.line("forge advisory check-run verified completed by the CLI");

    // Guard on status so a completion racing a superseding push or watchdog
    // cannot flap the row back to completed or attribute usage to a run that
    // no longer owns the result. The worker publishes the gate only after
    // this durable terminal transition succeeds.
    const completion = await finalizeStagedReviewCompletionWithGateMode(
      db,
      {
        reviewId,
        usage: receiptUsage,
        hostedUsageReservationId,
        usageAccountingComplete: ingested.usageAccountingComplete,
        reviewJobLease: timing.lease,
        expectedReviewInput: payload,
        staleCleanup: {
          reviewId,
          installationId: payload.installationId,
          repoFullName: payload.repoFullName,
          advisoryCheckRunId: advisoryCheckRunId ?? null,
          gateCheckRunId: gateCheckRunId ?? null,
          headSha: payload.headSha,
          advisoryCheckExternalId,
          gateCheckExternalId,
          advisoryCheckRunMayExist,
          gateCheckRunMayExist,
          message: "superseded by newer pull request input before completion",
          detailsUrl,
          intent: "neutralize",
        },
        ...(operationallyUnavailable
          ? {
              terminalStatus: "failed" as const,
              errorMessage: OPERATIONAL_NO_VERDICT_MESSAGE,
            }
          : {}),
      },
      installation.orgId,
    );
    const completed = completion.completed;
    if (completed) {
      void import("@/worker/runner").then(({ triggerQueueDrain }) =>
        triggerQueueDrain("gate-state-sync"),
      );
      reviewLog.line("durable gate synchronization queued from stored review truth");
    }

    if (!completed) {
      if (hostedUsageReservationId) {
        await reconcileHostedReviewSpendFromReceipt(db, {
          reservationId: hostedUsageReservationId,
          repositoryId: repository.id,
          reviewId,
          triggerSource: reviewValues.triggerSource,
          usage: receiptUsage,
          usageAccountingComplete: ingested.usageAccountingComplete,
        });
      }
      const terminal = (
        await db
          .select({ status: schema.reviews.status })
          .from(schema.reviews)
          .where(eq(schema.reviews.id, reviewId))
          .limit(1)
      )[0];
      if (terminal?.status === "stale") {
        // A superseding webhook may have neutralized the checks while this
        // CLI was still running. The CLI can PATCH them afterward, so make
        // neutral the final forge state once the old process exits.
        await neutralizeSupersededCheckRuns(
          token,
          payload.repoFullName,
          advisoryCheckRunId ?? null,
          gateCheckRunId ?? null,
          "superseded by a newer review",
          detailsUrl,
        );
        reviewLog.line(
          "forge check-runs restored to neutral after supersession",
        );
      } else if (terminal?.status === "failed") {
        await failCheckRuns(
          token,
          payload.repoFullName,
          advisoryCheckRunId,
          gateCheckRunId,
          "the review lost its terminal-state race",
          undefined,
          true,
          detailsUrl,
          expectedFailureCheckRuns(completionStaged),
          gateEnabled,
        );
        reviewLog.line(
          "forge check-runs restored to the durable failed terminal state",
        );
      }
      console.warn(
        `review ${reviewId} completed after it was already superseded or failed`,
      );
    } else {
      try {
        const commentIds = await getPullRequestPublicationCommentIds(
          db,
          repository.id,
          payload.prNumber,
        );
        const lifecycleAuthorGithubId = authorGithubId;
        if (
          typeof lifecycleAuthorGithubId !== "number" ||
          !Number.isSafeInteger(lifecycleAuthorGithubId) ||
          lifecycleAuthorGithubId <= 0
        ) {
          reviewLog.line(
            "publication lifecycle observation skipped because the pull request author identity is unavailable",
          );
        } else {
          const observations = await observeGitHubReviewThreads(
            token,
            payload.repoFullName,
            payload.prNumber,
            commentIds,
            lifecycleAuthorGithubId,
            signal,
          );
          await reconcilePublicationThreadObservations(
            db,
            payload.sourceDeliveryId ?? `review:${publicId}`,
            observations,
          );
          if (observations.length > 0) {
            reviewLog.line(
              `publication lifecycle reconciled (${observations.length} GitHub threads)`,
            );
          }
        }
      } catch (error) {
        // A transient GitHub read does not invalidate the immutable receipt.
        console.warn(
          `review ${reviewId} publication lifecycle observation deferred: ${redactSecrets(error)}`,
        );
        reviewLog.line("publication lifecycle observation deferred");
      }
    }
  } catch (err) {
    if (
      leaseAbortController.signal.reason instanceof ReviewInputSupersededError
    ) {
      err = leaseAbortController.signal.reason;
    }
    const reconcileInterruptedSpend = async (): Promise<void> => {
      if (!hostedUsageReservationId) return;
      const billingOutcome = largeReviewProxy?.billingOutcome() ?? "unused";
      const action = interruptedHostedSpendAction({
        receiptAvailable: receiptUsageForRace !== undefined,
        cliStarted,
        billingOutcome,
      });
      if (action === "receipt") {
        await reconcileHostedReviewSpendFromReceipt(db, {
          reservationId: hostedUsageReservationId,
          repositoryId: repository.id,
          reviewId,
          triggerSource: reviewValues.triggerSource,
          usage: receiptUsageForRace!,
          usageAccountingComplete: usageAccountingCompleteForRace,
        });
        return;
      }
      if (action === "retain-resumable") return;
      if (action === "reconcile-ambiguous") {
        const largeReviewRunKey = await largeReviewProxy?.boundRunKey();
        if (!largeReviewRunKey) {
          throw new PermanentJobError(
            "ambiguous provider contact lacks a durable run",
          );
        }
        await reconcileConservativeHostedReviewSpend(db, {
          reservationId: hostedUsageReservationId,
          repositoryId: repository.id,
          reviewId,
          triggerSource: reviewValues.triggerSource,
          largeReviewRunKey,
        });
        return;
      }
      await releaseHostedReviewSpend(db, hostedUsageReservationId);
    };
    if (controllerOwned) {
      if (completionStaged) {
        if (err instanceof WorkerShutdownError) throw err;
        throw new ReviewPublicationReconciliationError(
          `publication-controller recovery deferred: ${redactSecrets(err, sensitiveValues)}`,
        );
      }
      if (err instanceof WorkerShutdownError) throw err;
      await reconcileInterruptedSpend();
      if (err instanceof ReviewInputConvergenceError) {
        await db
          .update(schema.reviews)
          .set({
            status: "stale",
            errorMessage: "superseded by newer pull request input",
            finishedAt: new Date(),
          })
          .where(
            and(
              eq(schema.reviews.id, reviewId),
              eq(schema.reviews.status, "running"),
            ),
          );
        reviewLog.line("review superseded before controller generation staging");
        return;
      }
      await db
        .update(schema.reviews)
        .set({
          status: "failed",
          errorMessage: redactSecrets(err, sensitiveValues),
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(schema.reviews.id, reviewId),
            eq(schema.reviews.status, "running"),
          ),
        );
      throw err;
    }
    if (err instanceof ReviewInputConvergenceError) {
      const retainedRerun = err instanceof ReviewInputSupersededError;
      const message = retainedRerun
        ? "newer pull request input retained; current review superseded"
        : "pull request input convergence deferred; review requeued";
      reviewLog.line(message);
      const staleTransitioned = await markReviewStaleWithDurableCleanup(db, {
        reviewId,
        installationId: payload.installationId,
        repoFullName: payload.repoFullName,
        headSha: payload.headSha,
        advisoryCheckRunId: advisoryCheckRunId ?? null,
        gateCheckRunId: gateCheckRunId ?? null,
        advisoryCheckExternalId,
        gateCheckExternalId,
        advisoryCheckRunMayExist,
        gateCheckRunMayExist,
        message,
        detailsUrl,
        intent: "neutralize",
      });
      await reconcileInterruptedSpend();
      if (staleTransitioned) {
        await neutralizeSupersededCheckRuns(
          token,
          payload.repoFullName,
          advisoryCheckRunId ?? null,
          gateCheckRunId ?? null,
          message,
          detailsUrl,
        );
      }
      if (retainedRerun) {
        reviewLog.line("retained pull request input queued for a fresh review");
        return;
      }
      throw err;
    }
    if (err instanceof CheckRunPublicationError && receiptUsageForRace) {
      const terminal = (
        await db
          .select({ status: schema.reviews.status })
          .from(schema.reviews)
          .where(eq(schema.reviews.id, reviewId))
          .limit(1)
      )[0];
      if (terminal?.status === "stale") {
        if (hostedUsageReservationId) {
          await reconcileHostedReviewSpendFromReceipt(db, {
            reservationId: hostedUsageReservationId,
            repositoryId: repository.id,
            reviewId,
            triggerSource: reviewValues.triggerSource,
            usage: receiptUsageForRace,
            usageAccountingComplete: usageAccountingCompleteForRace,
          });
        }
        await neutralizeSupersededCheckRuns(
          token,
          payload.repoFullName,
          advisoryCheckRunId ?? null,
          gateCheckRunId ?? null,
          "superseded by a newer review",
          detailsUrl,
        );
        reviewLog.line(
          "forge check-runs restored to neutral after supersession",
        );
        console.warn(
          `review ${reviewId} publication verification raced with supersession`,
        );
        return;
      }
    }
    if (completionStaged) {
      if (err instanceof WorkerInterruptionRehearsalError) throw err;
      const message = err instanceof WorkerShutdownError
        ? "worker stopped after the review result was staged"
        : `publication verification deferred: ${redactSecrets(err, sensitiveValues)}`;
      reviewLog.line(message);
      if (err instanceof WorkerShutdownError) throw err;
      if (err instanceof ReviewPublicationReconciliationError) throw err;
      throw new ReviewPublicationReconciliationError(message);
    }
    if (err instanceof WorkerShutdownError) {
      // Publication has begun (check-runs exist on the forge), but an
      // instance replacement is not a review failure: the requeued job runs
      // a fresh attempt whose check-runs supersede these, so the gate stays
      // pending instead of failing closed. The runner requeues this claim
      // without consuming a retry attempt. Spend settles first: ambiguous
      // provider usage that cannot be settled safely must fail closed below
      // instead of silently requeueing unaccounted spend.
      const spendError = await reconcileInterruptedSpend()
        .then(() => null)
        .catch((reconcileError: unknown) => reconcileError);
      if (!spendError) {
        reviewLog.line(
          "review interrupted by worker shutdown after publication began; a fresh attempt will supersede it",
        );
        await markReviewStaleWithDurableCleanup(db, {
          reviewId,
          installationId: payload.installationId,
          repoFullName: payload.repoFullName,
          advisoryCheckRunId: advisoryCheckRunId ?? null,
          gateCheckRunId: gateCheckRunId ?? null,
          headSha: payload.headSha,
          advisoryCheckExternalId,
          gateCheckExternalId,
          advisoryCheckRunMayExist,
          gateCheckRunMayExist,
          message: "interrupted by an instance replacement; requeued",
          detailsUrl,
          intent: "neutralize",
        });
        throw err;
      }
      reviewLog.line(
        "interrupted review spend could not be settled; failing closed",
      );
    }
    const publicationIncomplete = err instanceof CheckRunPublicationError;
    const message = redactSecrets(err, sensitiveValues);
    reviewLog.line(`review failed: ${message}`);
    const failedRows = await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.reviews)
        .set({
          status: "failed",
          errorMessage: redactAndTruncate(message, 2000, sensitiveValues),
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(schema.reviews.id, reviewId),
            eq(schema.reviews.status, "running"),
          ),
        )
        .returning({ id: schema.reviews.id });
      if (rows.length === 0) return rows;
      await tx.insert(schema.jobs).values({
        kind: "check-run-cleanup",
        payload: {
          installationId: payload.installationId,
          repoFullName: payload.repoFullName,
          advisoryCheckRunId: advisoryCheckRunId ?? null,
          gateCheckRunId: gateCheckRunId ?? null,
          headSha: payload.headSha,
          advisoryCheckExternalId,
          gateCheckExternalId,
          advisoryCheckRunMayExist,
          gateCheckRunMayExist,
          message,
          detailsUrl,
          intent: "fail",
          publicationIncomplete,
        },
        maxAttempts: 5,
      });
      return rows;
    });
    await reconcileInterruptedSpend();
    // Without a token there are no check-runs to complete (creation is the
    // first tokened call); with one, fail them closed - unless the watchdog
    // already claimed this review and completed them itself (0 rows above).
    if (token && failedRows.length > 0) {
      await failCheckRuns(
        token,
        payload.repoFullName,
        advisoryCheckRunId,
        gateCheckRunId,
        message,
        undefined,
        false,
        detailsUrl,
        expectedFailureCheckRuns(publicationIncomplete),
        gateEnabled,
      );
      reviewLog.line("forge check-runs updated for review failure");
    }
    // A preflight rejection becomes one durable failed review and one exact
    // terminal check pair. Retrying the review job would create duplicate
    // review/check identities for a condition that cannot change mid-job.
    if (
      err instanceof TerminalReviewError ||
      (err instanceof CheckRunPublicationError && failedRows.length > 0)
    ) {
      return;
    }
    throw err;
  } finally {
    inputLeaseMonitor?.stop();
    largeReviewProxy?.close();
    if (baselinePath)
      await rm(baselinePath, { force: true }).catch(() => undefined);
    if (workDir)
      await rm(workDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    await reviewLog.close();
  }
}

interface SupersedeActiveReviewsInput {
  repositoryId: number;
  prNumber: number;
  newHeadSha: string;
  repoFullName: string;
  excludeReviewId?: number;
  onlyDifferentHead?: boolean;
  githubInstallationId: number;
  message?: string;
  orgSlug?: string | null;
}

/** Atomically mark active reviews stale and retain retryable forge cleanup. */
export async function supersedeActiveReviews(
  input: SupersedeActiveReviewsInput,
): Promise<number> {
  const db = getDb();
  const active = await db
    .select({
      id: schema.reviews.id,
      publicId: schema.reviews.publicId,
      status: schema.reviews.status,
      headSha: schema.reviews.headSha,
      advisoryCheckRunId: schema.reviews.advisoryCheckRunId,
      gateCheckRunId: schema.reviews.gateCheckRunId,
    })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.repositoryId, input.repositoryId),
        eq(schema.reviews.prNumber, input.prNumber),
        inArray(schema.reviews.status, ["queued", "running"]),
        input.excludeReviewId === undefined
          ? undefined
          : ne(schema.reviews.id, input.excludeReviewId),
        input.onlyDifferentHead
          ? ne(schema.reviews.headSha, input.newHeadSha)
          : undefined,
      ),
    );
  if (active.length === 0) return 0;

  const message = input.message ?? `superseded by a newer review of ${input.newHeadSha}`;
  let superseded = 0;
  for (const review of active) {
    const changed = await markReviewStaleWithDurableCleanup(db, {
      reviewId: review.id,
      installationId: input.githubInstallationId,
      repoFullName: input.repoFullName,
      advisoryCheckRunId: review.advisoryCheckRunId,
      gateCheckRunId: review.gateCheckRunId,
      headSha: review.headSha,
      advisoryCheckExternalId: checkRunExternalId(review.publicId, "review"),
      gateCheckExternalId: checkRunExternalId(review.publicId, "gate"),
      advisoryCheckRunMayExist:
        review.status === "running" && review.advisoryCheckRunId == null,
      gateCheckRunMayExist:
        review.status === "running" &&
        review.advisoryCheckRunId != null &&
        review.gateCheckRunId == null,
      message,
      detailsUrl: reviewDetailsUrl(review.publicId, input.orgSlug),
      intent: "neutralize",
    });
    if (!changed) continue;
    superseded += 1;
  }
  if (superseded > 0) {
    void import("@/worker/runner").then(({ triggerQueueDrain }) =>
      triggerQueueDrain("check-run-cleanup")
    );
  }
  return superseded;
}

async function neutralizeSupersededCheckRuns(
  token: string,
  repoFullName: string,
  advisoryCheckRunId: number | null,
  gateCheckRunId: number | null,
  message: string,
  detailsUrl?: string,
): Promise<void> {
  for (const checkRunId of [gateCheckRunId, advisoryCheckRunId]) {
    if (checkRunId == null) continue;
    await completeCheckRun(
      token,
      repoFullName,
      checkRunId,
      "neutral",
      "Review superseded",
      message,
      undefined,
      detailsUrl,
    ).catch((err) =>
      console.error(
        `failed to complete superseded check-run ${checkRunId}: ${redactSecrets(err, [token])}`,
      ),
    );
  }
}

export async function completeHostedInferenceDisabledCheckRuns(
  token: string,
  repoFullName: string,
  advisoryCheckRunId: number | undefined,
  gateCheckRunId: number | undefined,
  throwOnError = false,
  detailsUrl?: string,
  expectedChecks?: ExpectedFailureCheckRuns,
): Promise<boolean> {
  const summary =
    "Postil did not run a review for this commit. No review comment or verdict was published.";
  const errors: unknown[] = [];
  for (const [kind, checkRunId] of [
    ["advisory", advisoryCheckRunId],
    ["gate", gateCheckRunId],
  ] as const) {
    if (checkRunId === undefined) continue;
    const expected = expectedChecks?.[kind];
    const completion = expected
      ? completeExpectedCheckRun(
          token,
          repoFullName,
          { ...expected, conclusion: "neutral" },
          "Review unavailable",
          summary,
        )
      : Promise.reject(
          new CheckRunPublicationError(
            "unavailable review cleanup requires the exact GitHub check-run identities",
          ),
        );
    await completion.catch((error) => {
      errors.push(error);
      console.error(
        `failed to neutralize unavailable ${kind} check-run: ${redactSecrets(error, [token])}`,
      );
    });
  }
  if (throwOnError && errors.length > 0) {
    throw new AggregateError(
      errors,
      "could not neutralize unavailable review check-runs",
    );
  }
  return errors.length === 0;
}

/**
 * Publish no-verdict terminal checks after an operational failure. The review
 * check is neutral, and the gate fails only when merge enforcement is enabled.
 * Advisory organizations receive a neutral gate.
 */
export async function failCheckRuns(
  token: string,
  repoFullName: string,
  advisoryCheckRunId: number | undefined | null,
  gateCheckRunId: number | undefined | null,
  _message: string,
  signal?: AbortSignal,
  throwOnError = false,
  detailsUrl?: string,
  expectedChecks?: ExpectedFailureCheckRuns,
  gateEnabled = true,
): Promise<void> {
  const details = detailsUrl ? `\n\n[Review details](${detailsUrl})` : "";
  const publicationIncomplete = expectedChecks?.publicationIncomplete === true;
  if (
    (gateCheckRunId != null && !expectedChecks?.gate) ||
    (advisoryCheckRunId != null && !expectedChecks?.advisory)
  ) {
    throw new CheckRunPublicationError(
      "terminal cleanup requires the exact GitHub check-run identities",
    );
  }
  const reviewTitle = publicationIncomplete
    ? "Review publication incomplete"
    : "Review did not complete";
  const summary = publicationIncomplete
    ? `Postil completed the review, but GitHub did not receive the complete result. This run is not a published review verdict.${details}`
    : `Postil could not complete this review, so no review verdict exists.${details}`;
  const errors: unknown[] = [];
  const complete = async (
    checkRunId: number,
    expected: ExpectedCheckRunIdentity | undefined,
    conclusion: "failure" | "neutral",
    title: string,
    checkSummary: string,
  ): Promise<void> => {
    if (!expected) {
      await completeCheckRun(
        token,
        repoFullName,
        checkRunId,
        conclusion,
        title,
        checkSummary,
        signal,
        detailsUrl,
      );
      return;
    }
    if (expected.id !== checkRunId) {
      throw new CheckRunPublicationError(
        `GitHub check-run ${checkRunId} differs from its recorded review identity`,
      );
    }
    await completeExpectedCheckRun(
      token,
      repoFullName,
      { ...expected, conclusion },
      title,
      checkSummary,
      signal,
    );
  };
  if (gateCheckRunId != null) {
    const gateSummary = gateEnabled
      ? publicationIncomplete
        ? `${summary}\n\nThe merge check remains blocked because the reviewed result was not fully published. Re-request the check.`
        : `${summary}\n\nThe merge check remains blocked because an unreviewed head is not a passing head. Push again or re-request the check.`
      : `${summary}\n\nMerge blocking is disabled for this organization.`;
    await complete(
      gateCheckRunId,
      expectedChecks?.gate,
      gateEnabled ? "failure" : "neutral",
      gateEnabled ? reviewTitle : "Postil gate is advisory",
      gateSummary,
    ).catch((error) => {
      errors.push(error);
      console.error(
        `failed to complete gate check-run: ${redactSecrets(error, [token])}`,
      );
    });
  }
  if (advisoryCheckRunId != null) {
    await complete(
      advisoryCheckRunId,
      expectedChecks?.advisory,
      "neutral",
      reviewTitle,
      summary,
    ).catch((error) => {
      errors.push(error);
      console.error(
        `failed to complete advisory check-run: ${redactSecrets(error, [token])}`,
      );
    });
  }
  if (throwOnError && errors.length > 0) {
    throw new AggregateError(
      errors,
      "could not complete failed review check-runs",
    );
  }
}

/** Retryable worker job that completes check-runs after a watchdog kill. */
export async function runCheckRunCleanupJob(
  payload: CheckRunCleanupJobPayload,
  timeoutMs = 10_000,
): Promise<void> {
  validateCheckRunCleanupPayload(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const gateEnabled = await getInstallationGateEnabled(
      getDb(),
      payload.installationId,
    );
    const token = await getInstallationToken(
      payload.installationId,
      controller.signal,
    );
    const errors: unknown[] = [];
    const complete = async (
      advisoryCheckRunId: number | null | undefined,
      gateCheckRunId: number | null | undefined,
    ) => {
      const expectedChecks: ExpectedFailureCheckRuns = {
        ...(advisoryCheckRunId != null &&
        payload.headSha &&
        payload.advisoryCheckExternalId
          ? {
              advisory: {
                id: advisoryCheckRunId,
                name: ADVISORY_CHECK_NAME,
                externalId: payload.advisoryCheckExternalId,
                headSha: payload.headSha,
                detailsUrl: payload.detailsUrl,
              },
            }
          : {}),
        ...(gateCheckRunId != null &&
        payload.headSha &&
        payload.gateCheckExternalId
          ? {
              gate: {
                id: gateCheckRunId,
                name: GATE_CHECK_NAME,
                externalId: payload.gateCheckExternalId,
                headSha: payload.headSha,
                detailsUrl: payload.detailsUrl,
              },
            }
          : {}),
        publicationIncomplete: payload.publicationIncomplete === true,
      };
      if (payload.intent === "neutralize") {
        await completeHostedInferenceDisabledCheckRuns(
          token,
          payload.repoFullName,
          advisoryCheckRunId ?? undefined,
          gateCheckRunId ?? undefined,
          true,
          payload.detailsUrl,
          expectedChecks,
        );
        return;
      }
      await failCheckRuns(
        token,
        payload.repoFullName,
        advisoryCheckRunId,
        gateCheckRunId,
        payload.message,
        controller.signal,
        true,
        payload.detailsUrl,
        expectedChecks,
        gateEnabled,
      );
    };

    await complete(payload.advisoryCheckRunId, payload.gateCheckRunId).catch(
      (error) => {
        errors.push(error);
      },
    );

    let reconciledAdvisoryCheckRunId: number | null = null;
    let reconciledGateCheckRunId: number | null = null;
    if (
      payload.advisoryCheckRunId == null &&
      payload.advisoryCheckRunMayExist &&
      payload.headSha &&
      payload.advisoryCheckExternalId
    ) {
      try {
        reconciledAdvisoryCheckRunId = await findCheckRunByExternalId(
          token,
          payload.repoFullName,
          payload.headSha,
          ADVISORY_CHECK_NAME,
          payload.advisoryCheckExternalId,
          controller.signal,
        );
        if (reconciledAdvisoryCheckRunId === null) {
          errors.push(
            new Error(
              `ambiguous advisory check-run ${payload.advisoryCheckExternalId} is not visible on GitHub`,
            ),
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (
      payload.gateCheckRunId == null &&
      payload.gateCheckRunMayExist &&
      payload.headSha &&
      payload.gateCheckExternalId
    ) {
      try {
        reconciledGateCheckRunId = await findCheckRunByExternalId(
          token,
          payload.repoFullName,
          payload.headSha,
          GATE_CHECK_NAME,
          payload.gateCheckExternalId,
          controller.signal,
        );
        if (reconciledGateCheckRunId === null) {
          errors.push(
            new Error(
              `ambiguous gate check-run ${payload.gateCheckExternalId} is not visible on GitHub`,
            ),
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
    await complete(
      reconciledAdvisoryCheckRunId,
      reconciledGateCheckRunId,
    ).catch((error) => {
      errors.push(error);
    });
    if (errors.length > 0) {
      const details = checkRunCleanupErrorDetails(errors, token);
      throw new AggregateError(
        errors,
        `check-run cleanup remains incomplete: ${details}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function checkRunCleanupErrorDetails(
  errors: readonly unknown[],
  token: string,
): string {
  const messages = new Set<string>();
  const visit = (error: unknown): void => {
    if (error instanceof AggregateError) {
      for (const nested of error.errors) visit(nested);
      return;
    }
    messages.add(redactSecrets(error, [token]));
  };
  for (const error of errors) visit(error);
  return [...messages].filter(Boolean).join("; ") || "unknown GitHub failure";
}

export function validateCheckRunCleanupPayload(
  payload: CheckRunCleanupJobPayload,
): void {
  const validId = (value: unknown): value is number | null =>
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  if (
    !Number.isSafeInteger(payload.installationId) ||
    payload.installationId <= 0 ||
    typeof payload.repoFullName !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/.test(payload.repoFullName) ||
    !validId(payload.advisoryCheckRunId) ||
    !validId(payload.gateCheckRunId) ||
    typeof payload.message !== "string" ||
    (payload.intent !== undefined &&
      payload.intent !== "fail" &&
      payload.intent !== "neutralize")
  ) {
    throw new PermanentJobError("check-run cleanup job payload is malformed");
  }
  for (const [mayExist, externalId] of [
    [payload.advisoryCheckRunMayExist, payload.advisoryCheckExternalId],
    [payload.gateCheckRunMayExist, payload.gateCheckExternalId],
  ] as const) {
    if (
      mayExist === true &&
      (typeof payload.headSha !== "string" ||
        !payload.headSha ||
        typeof externalId !== "string" ||
        !externalId)
    ) {
      throw new PermanentJobError("check-run cleanup job payload is malformed");
    }
  }
  if (
    payload.publicationIncomplete === true &&
    ((payload.advisoryCheckRunId != null &&
      !payload.advisoryCheckExternalId) ||
      (payload.gateCheckRunId != null && !payload.gateCheckExternalId) ||
      !payload.headSha)
  ) {
    throw new PermanentJobError("check-run cleanup job payload is malformed");
  }
  if (
    ((payload.advisoryCheckRunId != null &&
      !payload.advisoryCheckExternalId) ||
      (payload.gateCheckRunId != null && !payload.gateCheckExternalId) ||
      ((payload.advisoryCheckRunId != null || payload.gateCheckRunId != null) &&
        !payload.headSha))
  ) {
    throw new PermanentJobError("check-run cleanup job payload is malformed");
  }
}
