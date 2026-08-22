import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";

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
} from "@/lib/env";
import {
  classifyOperationalModelIncidents,
  ingestEnvelope,
  isEnvelopeOperationallyUnavailable,
  type Envelope,
} from "@/lib/envelope";
import { enqueueGateStateSync } from "@/lib/finding-approvals";
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
  verifyCompletedCheckRun,
  type ExpectedCheckRunIdentity,
} from "@/lib/github/checks";
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
  PermanentJobError,
  type CheckRunCleanupJobPayload,
  type ExternalSideEffectLease,
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
  stageReviewCompletionCandidate,
  type ReviewCompletionInput,
} from "@/lib/review-completion";
import {
  getInstallationGateEnabled,
  getOrganizationGateEnabled,
} from "@/lib/gate-mode";
import { discoverPreventionCommands } from "@/lib/review-guidance";
import {
  HOSTED_ALLOWANCE_UNAVAILABLE_MESSAGE,
  HOSTED_REVIEW_UNAVAILABLE_MESSAGE,
  PUBLICATION_INELIGIBLE_MESSAGE,
} from "@/lib/review-outcome";
import { HostedInferenceReleaseDarkError } from "@/lib/release-job-rollout";
import { shouldSendPreventionHint } from "@/lib/review-prevention-db";
import {
  consumePrivateWorkerRehearsalAfterStaging,
  WorkerInterruptionRehearsalError,
} from "@/lib/private-worker-rehearsal";
import {
  applyPublicationThreadObservations,
  getPullRequestPublicationCommentIds,
  readPublicationReceipt,
  type PublicationReceipt,
} from "@/lib/publication-receipt";
import {
  reportOperationalModelIncident,
  type ObservabilityProcessGroup,
} from "@/lib/server-observability";

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
  throw new OperationalError(
    `postil CLI exited with code ${result.exitCode}: ${redactAndTruncate(result.stderr, 500, sensitiveValues)}`,
  );
}

interface CliObservers {
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
  preserveOutputOnInterrupt?: boolean;
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
  const bin = optionalEnv("POSTIL_BIN", "postil") as string;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    let abortKillTimer: ReturnType<typeof setTimeout> | undefined;
    const stderrLines = createLineObserver(observers.onStderrLine);
    const cleanup = () => {
      clearTimeout(timer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      observers.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (settled || interrupted) return;
      interrupted = true;
      child.kill("SIGTERM");
      abortKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      abortKillTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, REVIEW_DEADLINE_MS);
    if (observers.signal?.aborted) abort();
    else observers.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
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
      if (interrupted && !observers.preserveOutputOnInterrupt) {
        reject(new WorkerShutdownError());
        return;
      }
      resolvePromise({ exitCode: code, stdout, stderr, timedOut, interrupted });
    });
  });
}

function throwIfWorkerStopping(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WorkerShutdownError();
  }
}

function reviewUsageFromEnvelope(
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
  installation: { id: number; orgId: number | null; orgSlug: string | null };
  repository: { id: number; githubRepoId: number; fullName: string };
  signal?: AbortSignal;
}): Promise<boolean> {
  const { db, payload, installation, repository, signal } = input;
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
    console.warn(
      `review publication recovery ${stagedReview.id} is already ${stagedReview.status}`,
    );
    return true;
  }
  if (
    !stagedReview.envelope ||
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
  const detailsUrl = reviewDetailsUrl(
    stagedReview.publicId,
    installation.orgSlug,
  );
  try {
    await verifyCompletedCheckRun(
      token,
      payload.repoFullName,
      {
        id: stagedReview.advisoryCheckRunId,
        name: ADVISORY_CHECK_NAME,
        externalId: checkRunExternalId(stagedReview.publicId, "review"),
        headSha: payload.headSha,
        conclusion: operationallyUnavailable ? "failure" : "success",
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
        },
        installation.orgId,
      );
      if (!completion.completed) {
        throw new ReviewPublicationReconciliationError(
          "review publication recovery lost its terminal-state race",
        );
      }
    }
    await enqueueGateStateSync(db, stagedReview);
    void import("@/worker/runner").then(({ triggerQueueDrain }) =>
      triggerQueueDrain("gate-state-sync"),
    );
    console.log(`review publication recovery ${stagedReview.id} completed`);
    return true;
  } catch (error) {
    if (signal?.aborted) throw new WorkerShutdownError();
    throw new ReviewPublicationReconciliationError(redactSecrets(error));
  }
}

/**
 * Run one hosted review end to end.
 *
 * The worker's job is deliberately small: mint a token, create the two
 * check-runs (so it owns their ids even if the CLI crashes), spawn the CLI,
 * store the envelope, and mark the check-runs failed on crash/timeout. All
 * review logic lives in the CLI.
 */
export async function runReviewJob(
  payload: ReviewJobPayload,
  timing: { queuedAt: Date; startedAt: Date; lease?: ExternalSideEffectLease } = {
    queuedAt: new Date(),
    startedAt: new Date(),
  },
  observabilityProcessGroup: ObservabilityProcessGroup = "worker",
  signal?: AbortSignal,
  onPublicationStarted?: () => void,
): Promise<void> {
  throwIfWorkerStopping(signal);
  if (
    typeof payload.sourceInstallationId !== "number" ||
    typeof payload.sourceOrgId !== "number" ||
    typeof payload.githubRepoId !== "number"
  ) {
    throw new PermanentJobError("review job lacks immutable source identity");
  }
  const db = getDb();
  const leaseActive = () => timing.lease
    ? externalSideEffectLeaseActive(getPool(), timing.lease)
    : Promise.resolve(true);
  if (!(await leaseActive())) return;

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
    await resumeStagedReviewCompletion({
      db,
      payload,
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
  if (
    !liveContext.open ||
    liveContext.merged ||
    liveContext.draft ||
    liveContext.headSha !== payload.headSha ||
    liveContext.baseSha !== payload.baseSha ||
    !(await leaseActive())
  ) {
    console.warn(`review job skipped: pull request closed, changed, or lost its lease`);
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
  let leasePollInFlight = false;
  const leasePoll = timing.lease
    ? setInterval(() => {
        if (leasePollInFlight || leaseAbortController.signal.aborted) return;
        leasePollInFlight = true;
        void leaseActive()
          .then((active) => {
            if (!active) leaseAbortController.abort();
          })
          .catch(() => leaseAbortController.abort())
          .finally(() => {
            leasePollInFlight = false;
          });
      }, REVIEW_CANCELLATION_POLL_MS)
    : undefined;
  leasePoll?.unref?.();
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
    return current.open &&
      !current.merged &&
      !current.draft &&
      current.headSha === payload.headSha &&
      current.baseSha === payload.baseSha &&
      await leaseActive();
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
    if (!(await publicationAuthorized())) {
      reviewLog.line("publication cancelled before forge writes");
      throw new TerminalReviewError(PUBLICATION_INELIGIBLE_MESSAGE);
    }
    onPublicationStarted?.();
    const superseded = await supersedeActiveReviews({
      repositoryId: repository.id,
      prNumber: payload.prNumber,
      newHeadSha: payload.headSha,
      repoFullName: payload.repoFullName,
      token,
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
      // Both check runs point at the same review page. Without this the
      // advisory run falls back to GitHub's default target, which is the
      // App's homepage, so "View more details" leaves the reader to find
      // the run themselves.
      { signal: reviewSignal, externalId: advisoryCheckExternalId, detailsUrl },
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

    if (!providerModeMatches) {
      throw new TerminalReviewError(
        "configured provider mode does not match the active inference entitlement",
      );
    }

    throwIfWorkerStopping(reviewSignal);
    const cliVersionLine = await postilCliVersionLogLine();
    cliVersion = cliVersionLine.replace(/^postil CLI version /, "");
    reviewLog.line(cliVersionLine);

    const args = [
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
      "--check-run-id",
      String(advisoryCheckRunId),
      "--gate-check-run-id",
      String(gateCheckRunId),
    ];
    if (optionalEnv("POSTIL_LOCAL_REVIEW_BOUNDED") === "1") {
      args.push("--bounded");
    }
    if (baseline?.envelope) {
      await mkdir(join(CACHE_DIR, "baselines"), { recursive: true });
      baselinePath = join(CACHE_DIR, "baselines", `review-${reviewId}.json`);
      await writeFile(baselinePath, JSON.stringify(baseline.envelope));
      // Absolute: the CLI resolves --baseline against its own cwd, which is
      // the per-review work dir below, not the worker's.
      if (!forceFullReview) args.push("--since-sha", baseline.headSha);
      args.push("--baseline", resolve(baselinePath));
    }
    args.push("--output", "json");

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
      retryLineage: timing.lease
        ? `review-job:${timing.lease.id}`
        : `review:${reviewId}`,
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
          const message = HOSTED_ALLOWANCE_UNAVAILABLE_MESSAGE;
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
            return true;
          });
          if (settled) {
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
        // The path is optional. A CLI without receipt support ignores it, and
        // absence is persisted as legacy unknown.
        POSTIL_PUBLICATION_RECEIPT_PATH: publicationReceiptPath,
      },
    );

    if (!(await publicationAuthorized())) {
      reviewLog.line("publication cancelled before CLI start");
      throw new TerminalReviewError(PUBLICATION_INELIGIBLE_MESSAGE);
    }
    reviewLog.line("postil CLI spawned");
    cliStarted = true;
    const result = await runCli(args, cliEnv, workDir, {
      onStderrLine: (line) => reviewLog.line(`[stderr] ${line}`),
      signal: reviewSignal,
      preserveOutputOnInterrupt: true,
    });
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
      `envelope ingested (${Buffer.byteLength(result.stdout)} bytes, ${ingested.envelope.findings.length} findings, gate ${ingested.gateFailing ? "failing" : "passing"})`,
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
        reviewJobId: timing.lease?.id,
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
    reviewLog.line("review result and publication receipt staged durably");
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
      await db
        .update(schema.reviews)
        .set({ status: "stale", finishedAt: new Date() })
        .where(
          and(eq(schema.reviews.id, reviewId), eq(schema.reviews.status, "running")),
        );
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
    const workerInstanceId = timing.lease?.lockedBy.match(/^(.+)#\d+$/)?.[1];
    if (observabilityProcessGroup === "worker" && workerInstanceId && timing.lease) {
      const rehearsalNonce = await consumePrivateWorkerRehearsalAfterStaging(
        getPool(),
        {
          reviewId,
          reviewJobId: timing.lease.id,
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
          id: advisoryCheckRunId,
          name: ADVISORY_CHECK_NAME,
          externalId: advisoryCheckExternalId,
          headSha: payload.headSha,
          conclusion: operationallyUnavailable ? "failure" : "success",
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
        const observations = await observeGitHubReviewThreads(
          token,
          payload.repoFullName,
          payload.prNumber,
          commentIds,
          signal,
        );
        await applyPublicationThreadObservations(db, observations);
        if (observations.length > 0) {
          reviewLog.line(
            `publication lifecycle reconciled (${observations.length} GitHub threads)`,
          );
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
    const reconcileInterruptedSpend = async (): Promise<void> => {
      if (hostedUsageReservationId && cliStarted) {
        const reservationId = hostedUsageReservationId;
        const billingOutcome = largeReviewProxy?.billingOutcome() ?? "unused";
        const reconcile = billingOutcome === "resumable"
          ? Promise.resolve()
          : billingOutcome === "ambiguous"
            ? largeReviewProxy!.boundRunKey().then((largeReviewRunKey) => {
                if (!largeReviewRunKey) {
                  throw new Error("ambiguous provider contact lacks a durable run");
                }
                return reconcileConservativeHostedReviewSpend(db, {
                  reservationId,
                  repositoryId: repository.id,
                  reviewId,
                  triggerSource: reviewValues.triggerSource,
                  largeReviewRunKey,
                });
              })
            : releaseHostedReviewSpend(db, reservationId);
        await reconcile.catch((reconcileError) => {
          console.error(
            `failed to reconcile hosted review usage: ${redactSecrets(reconcileError)}`,
          );
          if (billingOutcome === "ambiguous") {
            throw new PermanentJobError(
              "ambiguous provider usage could not be settled safely",
            );
          }
        });
      } else {
        await releaseHostedReviewSpend(db, hostedUsageReservationId).catch(
          (releaseError) => {
            console.error(
              `failed to release unused hosted usage reservation: ${redactSecrets(releaseError)}`,
            );
          },
        );
      }
    };
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
        await db
          .update(schema.reviews)
          .set({
            status: "stale",
            errorMessage: "interrupted by an instance replacement; requeued",
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
    if (leasePoll) clearInterval(leasePoll);
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
  token?: string;
  githubInstallationId?: number;
  message?: string;
  orgSlug?: string | null;
}

/** Mark active reviews stale and neutralize every recorded forge check-run. */
export async function supersedeActiveReviews(
  input: SupersedeActiveReviewsInput,
): Promise<number> {
  const db = getDb();
  const active = await db
    .select({
      id: schema.reviews.id,
      publicId: schema.reviews.publicId,
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

  let token = input.token;
  if (
    !token &&
    active.some(
      (review) =>
        review.advisoryCheckRunId != null || review.gateCheckRunId != null,
    )
  ) {
    if (input.githubInstallationId === undefined) {
      throw new Error(
        "cannot complete superseded check-runs without an installation id",
      );
    }
    token = await getInstallationToken(input.githubInstallationId);
  }

  const message = input.message ?? `superseded by a newer review of ${input.newHeadSha}`;
  let superseded = 0;
  for (const review of active) {
    const changed = await db
      .update(schema.reviews)
      .set({ status: "stale", finishedAt: new Date() })
      .where(
        and(
          eq(schema.reviews.id, review.id),
          inArray(schema.reviews.status, ["queued", "running"]),
        ),
      )
      .returning({ id: schema.reviews.id });
    if (changed.length === 0) continue;
    superseded += 1;
    if (token) {
      await neutralizeSupersededCheckRuns(
        token,
        input.repoFullName,
        review.advisoryCheckRunId,
        review.gateCheckRunId,
        message,
        reviewDetailsUrl(review.publicId, input.orgSlug),
      );
    }
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
): Promise<boolean> {
  const summary =
    "Postil did not run a review for this commit. No review comment or verdict was published.";
  const errors: unknown[] = [];
  for (const [kind, checkRunId] of [
    ["advisory", advisoryCheckRunId],
    ["gate", gateCheckRunId],
  ] as const) {
    if (checkRunId === undefined) continue;
    await completeCheckRun(
      token,
      repoFullName,
      checkRunId,
      "neutral",
      "Review unavailable",
      summary,
      undefined,
      detailsUrl,
    ).catch((error) => {
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
 * Complete both check-runs after an operational failure. Enforced gates fail
 * closed; advisory gates stand aside while the review check fails truthfully.
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
    publicationIncomplete &&
    ((gateCheckRunId != null && !expectedChecks?.gate) ||
      (advisoryCheckRunId != null && !expectedChecks?.advisory))
  ) {
    throw new CheckRunPublicationError(
      "publication cleanup requires the exact GitHub check-run identities",
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
      "failure",
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
      if (payload.intent === "neutralize") {
        await completeHostedInferenceDisabledCheckRuns(
          token,
          payload.repoFullName,
          advisoryCheckRunId ?? undefined,
          gateCheckRunId ?? undefined,
          true,
          payload.detailsUrl,
        );
        return;
      }
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
}
